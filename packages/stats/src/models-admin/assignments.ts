import * as fs from "node:fs";
import * as path from "node:path";
import { YAML } from "bun";
import { relativeToRoot, resolveOmpTree, type OmpTree } from "./paths";
import type { AgentAssignment, HermesAssignment, ModelsAdminSnapshot, RoleAssignment, WatchdogAssignment } from "./types";
import { splitFrontmatter } from "./yaml-patch";

function readText(file: string): string | null {
	try {
		return fs.readFileSync(file, "utf8");
	} catch {
		return null;
	}
}

function parseYaml(text: string | null): Record<string, unknown> {
	if (!text) return {};
	try {
		const parsed = YAML.parse(text);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

function asString(value: unknown): string | null {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return null;
}

function asModelValue(value: unknown): string | string[] | null {
	if (value == null) return null;
	if (Array.isArray(value)) return value.map(item => asString(item) ?? String(item));
	const scalar = asString(value);
	return scalar;
}

const MODEL_SELECTOR_KEYS: Record<string, true> = { id: true, model: true };

/** Walk role/override maps — every string value is a selector. */
function collectSelectors(value: unknown, into: Set<string>): void {
	if (typeof value === "string" && value.trim()) into.add(value.trim());
	else if (Array.isArray(value)) for (const item of value) collectSelectors(item, into);
	else if (value && typeof value === "object") {
		for (const child of Object.values(value as Record<string, unknown>)) collectSelectors(child, into);
	}
}

/**
 * Walk models.yml / config.models. Only `id` and `model` are selectors.
 * Recursing every property would put apiKey / baseUrl / headers in the datalist.
 */
function collectCatalogModels(value: unknown, into: Set<string>): void {
	if (Array.isArray(value)) {
		for (const item of value) collectCatalogModels(item, into);
		return;
	}
	if (!value || typeof value !== "object") return;
	for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
		if (MODEL_SELECTOR_KEYS[key]) collectSelectors(child, into);
		else collectCatalogModels(child, into);
	}
}

function agentGroup(name: string): string {
	if (name.startsWith("lfg-")) return "lfg";
	if (name.startsWith("ce-")) return "lenses";
	if (name === "scout" || name === "oracle") return "core";
	return "other";
}

function listAgentFiles(dir: string): string[] {
	try {
		return fs
			.readdirSync(dir)
			.filter(name => name.endsWith(".md"))
			.sort((a, b) => a.localeCompare(b));
	} catch {
		return [];
	}
}

export function loadSnapshot(tree = resolveOmpTree()): ModelsAdminSnapshot {
	const warnings: string[] = [];
	if (!tree.present) {
		warnings.push(`No OMP tree at ${tree.root}. Set OMP_HOME or use a gapilabs/omp checkout.`);
	}

	const configText = readText(tree.configYml);
	const config = parseYaml(configText);
	const modelsFile = parseYaml(readText(tree.modelsYml));
	const watchdogText = readText(tree.watchdogYml);
	const watchdog = parseYaml(watchdogText);
	const macHost = parseYaml(readText(tree.macHostYml));
	const vpsHost = parseYaml(readText(tree.vpsHostYml));

	const modelRoles = (config.modelRoles as Record<string, unknown> | undefined) ?? {};
	const fallbacks = ((config.retry as Record<string, unknown> | undefined)?.fallbackChains ?? {}) as Record<
		string,
		unknown
	>;
	const overrides = ((config.task as Record<string, unknown> | undefined)?.agentModelOverrides ?? {}) as Record<
		string,
		unknown
	>;

	const catalog = new Set<string>();
	collectCatalogModels(config.models, catalog);
	collectCatalogModels(modelsFile, catalog);
	collectSelectors(modelRoles, catalog);
	collectSelectors(overrides, catalog);
	collectSelectors(fallbacks, catalog);

	const roles: RoleAssignment[] = Object.entries(modelRoles).map(([id, value]) => ({
		id,
		label: id,
		value: asModelValue(value) ?? "",
		source: relativeToRoot(tree, tree.configYml),
		hostOnly: false,
	}));

	const fallbackRows: RoleAssignment[] = Object.entries(fallbacks).map(([id, value]) => ({
		id,
		label: id,
		value: asModelValue(value) ?? [],
		source: relativeToRoot(tree, tree.configYml),
		hostOnly: false,
	}));

	const agents: AgentAssignment[] = [];
	for (const file of listAgentFiles(tree.agentsDir)) {
		const id = file.replace(/\.md$/, "");
		const text = readText(path.join(tree.agentsDir, file)) ?? "";
		const split = splitFrontmatter(text);
		const fm = parseYaml(split?.fm ?? null);
		const front = asModelValue(fm.model);
		const override = asModelValue(overrides[id]);
		if (front) collectSelectors(front, catalog);
		if (override) collectSelectors(override, catalog);
		agents.push({
			id,
			group: agentGroup(id),
			value: front ?? override,
			source: front
				? relativeToRoot(tree, path.join(tree.agentsDir, file))
				: override
					? `${relativeToRoot(tree, tree.configYml)}#task.agentModelOverrides`
					: relativeToRoot(tree, path.join(tree.agentsDir, file)),
			hasModelField: front !== null,
			hostOnly: false,
		});
	}

	const watchdogRows: WatchdogAssignment[] = [];
	const advisors = Array.isArray(watchdog.advisors) ? watchdog.advisors : [];
	advisors.forEach((entry, index) => {
		if (!entry || typeof entry !== "object") return;
		const rec = entry as Record<string, unknown>;
		const name = asString(rec.name) ?? `advisor-${index}`;
		const value = asString(rec.model) ?? "";
		if (value) catalog.add(value);
		watchdogRows.push({
			id: String(index),
			name,
			value,
			source: relativeToRoot(tree, tree.watchdogYml),
		});
	});

	const hermesText = readText(tree.hermesJson);
	let hermes: HermesAssignment = {
		llmModelOverride: null,
		llmThinkingOverride: null,
		source: relativeToRoot(tree, tree.hermesJson),
		present: hermesText !== null,
	};
	if (hermesText) {
		try {
			const json = JSON.parse(hermesText) as Record<string, unknown>;
			hermes = {
				llmModelOverride: asString(json.llmModelOverride),
				llmThinkingOverride: asString(json.llmThinkingOverride),
				source: relativeToRoot(tree, tree.hermesJson),
				present: true,
			};
			if (hermes.llmModelOverride) catalog.add(hermes.llmModelOverride);
		} catch {
			warnings.push("hermes-memory-config.json is not valid JSON.");
		}
	}

	if (macHost.modelRoles || vpsHost.modelRoles) {
		warnings.push("Host overlays are present. Host-only pins stay in hosts/*.yml.");
	}

	return {
		root: tree.root,
		kind: tree.kind,
		present: tree.present,
		git: tree.git,
		syncScript: fs.existsSync(tree.syncScript),
		warnings,
		catalog: [...catalog].sort((a, b) => a.localeCompare(b)),
		roles,
		fallbacks: fallbackRows,
		agents,
		watchdog: watchdogRows,
		hermes,
		hosts: { mac: fs.existsSync(tree.macHostYml), vps: fs.existsSync(tree.vpsHostYml) },
	};
}

export function readTree(tree?: OmpTree): ModelsAdminSnapshot {
	return loadSnapshot(tree ?? resolveOmpTree());
}
