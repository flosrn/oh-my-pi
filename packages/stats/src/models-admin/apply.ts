import * as fs from "node:fs";
import * as path from "node:path";
import { $ } from "bun";
import { type OmpTree, relativeToRoot, resolveOmpTree } from "./paths";
import type { ApplyResult, ApplyScope, ModelChange, PreviewResult } from "./types";
import { APPLY_EFFECT } from "./types";
import { ensureAdvisorFallbackEmpty, formatScalar, setFrontmatterModel, setYamlPath, unifiedDiff } from "./yaml-patch";

interface FileEdit {
	abs: string;
	rel: string;
	before: string;
	after: string;
}

function hostFile(tree: OmpTree, scope: ApplyScope): string {
	if (scope === "mac") return tree.macHostYml;
	if (scope === "vps") return tree.vpsHostYml;
	return tree.macHostYml;
}

function ensureAdvisor(text: string): string {
	if (!text.trim()) return text;
	try {
		return ensureAdvisorFallbackEmpty(text);
	} catch {
		return text;
	}
}

const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function resolveAgentMarkdown(tree: OmpTree, id: string): string {
	if (!AGENT_ID.test(id)) throw new Error(`Invalid agent id: ${id}`);
	const agentsDir = path.resolve(tree.agentsDir);
	const file = path.resolve(agentsDir, `${id}.md`);
	if (!file.startsWith(`${agentsDir}${path.sep}`) || path.basename(file) !== `${id}.md`) {
		throw new Error(`Invalid agent id: ${id}`);
	}
	if (!fs.existsSync(file)) throw new Error(`Unknown agent: ${id}`);
	return file;
}

function setWatchdogModel(source: string, index: number, model: string): string {
	const quoted = formatScalar(model);
	const lines = source.split(/\r?\n/);
	let advisorsIndent = -1;
	let seen = -1;
	let itemIndent = -1;
	for (let i = 0; i < lines.length; i++) {
		const match = /^( *)advisors\s*:/.exec(lines[i]);
		if (match && advisorsIndent === -1) {
			advisorsIndent = match[1].length;
			continue;
		}
		if (advisorsIndent === -1) continue;
		const item = /^( *)-\s+/.exec(lines[i]);
		if (item && item[1].length > advisorsIndent) {
			seen++;
			itemIndent = item[1].length;
			if (seen === index) {
				for (let j = i; j < lines.length; j++) {
					const modelLine = /^( *)model\s*:/.exec(lines[j]);
					if (modelLine && modelLine[1].length > itemIndent) {
						const suffix = /(#.*)$/.exec(lines[j]);
						lines[j] = `${modelLine[1]}model: ${quoted}${suffix ? ` ${suffix[1]}` : ""}`;
						return lines.join("\n");
					}
					if (j > i && /^( *)-\s+/.test(lines[j])) break;
				}
				lines.splice(i + 1, 0, `${" ".repeat(itemIndent + 2)}model: ${quoted}`);
				return lines.join("\n");
			}
		}
		if (/^\S/.test(lines[i]) && !lines[i].startsWith(" ") && i > 0 && advisorsIndent === 0) break;
	}
	throw new Error(`WATCHDOG.yml has no advisors[${index}]`);
}

function patchHermes(text: string, field: "llmModelOverride" | "llmThinkingOverride", value: string | null): string {
	const json = text.trim() ? (JSON.parse(text) as Record<string, unknown>) : {};
	if (value === null || value === "") delete json[field];
	else json[field] = value;
	return `${JSON.stringify(json, null, 2)}\n`;
}

function upsertEdit(edits: Map<string, FileEdit>, tree: OmpTree, abs: string, mutate: (text: string) => string): void {
	const existing = edits.get(abs);
	const before = existing?.before ?? (fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : "");
	const current = existing?.after ?? before;
	const after = mutate(current);
	edits.set(abs, { abs, rel: relativeToRoot(tree, abs), before, after });
}

function applyChange(tree: OmpTree, edits: Map<string, FileEdit>, scope: ApplyScope, change: ModelChange): void {
	const hostOnly = Boolean(change.hostOnly) || scope === "vps";
	const sharedConfig = () =>
		upsertEdit(edits, tree, tree.configYml, text => {
			let next = text || "";
			if (change.kind === "role") next = setYamlPath(next, ["modelRoles", change.id], change.value ?? "");
			else if (change.kind === "fallback") {
				next = setYamlPath(next, ["retry", "fallbackChains", change.id], change.value ?? []);
			} else if (change.kind === "agentOverride") {
				next = setYamlPath(next, ["task", "agentModelOverrides", change.id], change.value ?? "");
			}
			return ensureAdvisor(next);
		});

	const overlay = (file: string) =>
		upsertEdit(edits, tree, file, text => {
			const base = text || "# host-only OMP overlay\n";
			if (change.kind === "role" || change.kind === "hostPin") {
				return ensureAdvisor(setYamlPath(base, ["modelRoles", change.id], change.value ?? ""));
			}
			if (change.kind === "fallback") {
				return ensureAdvisor(setYamlPath(base, ["retry", "fallbackChains", change.id], change.value ?? []));
			}
			if (change.kind === "agentOverride" || change.kind === "agentFrontmatter") {
				return ensureAdvisor(setYamlPath(base, ["task", "agentModelOverrides", change.id], change.value ?? ""));
			}
			if (change.kind === "hermesModel") {
				return setYamlPath(base, ["hermes", "llmModelOverride"], change.value ?? "");
			}
			if (change.kind === "hermesThinking") {
				return setYamlPath(base, ["hermes", "llmThinkingOverride"], change.value ?? "");
			}
			if (change.kind === "watchdog") {
				return setYamlPath(base, ["watchdog", "advisors", change.id, "model"], change.value ?? "");
			}
			return base;
		});

	if (hostOnly) {
		if (scope === "both") {
			overlay(tree.macHostYml);
			overlay(tree.vpsHostYml);
		} else {
			overlay(hostFile(tree, scope));
		}
		return;
	}

	if (scope === "vps") {
		overlay(tree.vpsHostYml);
		return;
	}

	if (change.kind === "role" || change.kind === "fallback" || change.kind === "agentOverride") {
		sharedConfig();
		if (change.kind === "role" && change.id === "advisor" && fs.existsSync(tree.watchdogYml)) {
			upsertEdit(edits, tree, tree.watchdogYml, text => setWatchdogModel(text, 0, String(change.value ?? "")));
		}
		return;
	}
	if (change.kind === "agentFrontmatter") {
		const file = resolveAgentMarkdown(tree, change.id);
		upsertEdit(edits, tree, file, text => setFrontmatterModel(text, change.value));
		return;
	}
	if (change.kind === "watchdog") {
		upsertEdit(edits, tree, tree.watchdogYml, text => {
			if (!text) throw new Error("WATCHDOG.yml is missing");
			const next = setWatchdogModel(text, Number(change.id), String(change.value ?? ""));
			if (change.id === "0") {
				upsertEdit(edits, tree, tree.configYml, cfg =>
					ensureAdvisor(setYamlPath(cfg || "", ["modelRoles", "advisor"], change.value ?? "")),
				);
			}
			return next;
		});
		return;
	}
	if (change.kind === "hermesModel") {
		upsertEdit(edits, tree, tree.hermesJson, text => patchHermes(text, "llmModelOverride", asNullable(change.value)));
		return;
	}
	if (change.kind === "hermesThinking") {
		upsertEdit(edits, tree, tree.hermesJson, text =>
			patchHermes(text, "llmThinkingOverride", asNullable(change.value)),
		);
		return;
	}
	if (change.kind === "hostPin") {
		overlay(scope === "vps" ? tree.vpsHostYml : tree.macHostYml);
	}
}

function asNullable(value: ModelChange["value"]): string | null {
	if (value == null) return null;
	return Array.isArray(value) ? (value[0] ?? null) : value;
}

export function buildPreview(changes: ModelChange[], scope: ApplyScope, tree = resolveOmpTree()): PreviewResult {
	const warnings: string[] = [];
	if (!tree.present) warnings.push(`OMP tree not found at ${tree.root}.`);
	const edits = new Map<string, FileEdit>();
	for (const change of changes) applyChange(tree, edits, scope, change);

	const diffs: PreviewResult["diffs"] = [];
	const files: string[] = [];
	for (const edit of edits.values()) {
		if (edit.before === edit.after) continue;
		files.push(edit.rel);
		const diff = unifiedDiff(edit.rel, edit.before, edit.after);
		if (diff) diffs.push({ path: edit.rel, diff });
	}
	if (scope !== "mac" && !tree.git) warnings.push(`${tree.root} is not a git checkout; commit/sync will fail.`);
	if ((scope === "both" || scope === "vps") && !fs.existsSync(tree.syncScript)) {
		warnings.push(`sync-vps-omp.sh is not at ${tree.syncScript}.`);
	}
	return { scope, diffs, files, warnings, effect: APPLY_EFFECT };
}

export function plannedEdits(changes: ModelChange[], scope: ApplyScope, tree = resolveOmpTree()): FileEdit[] {
	const edits = new Map<string, FileEdit>();
	for (const change of changes) applyChange(tree, edits, scope, change);
	return [...edits.values()].filter(edit => edit.before !== edit.after);
}

async function runGit(tree: OmpTree, files: string[], message: string): Promise<{ ok: boolean; output: string }> {
	if (files.length === 0) return { ok: true, output: "No files to commit." };
	const add = await $`git -C ${tree.root} add -- ${files}`.quiet().nothrow();
	if (add.exitCode !== 0) {
		return { ok: false, output: add.text().trim() || `git add failed (${add.exitCode})` };
	}
	// --only + pathspec keeps any pre-staged leftover out of this commit.
	const commit = await $`git -C ${tree.root} commit --only -m ${message} -- ${files}`.quiet().nothrow();
	if (commit.exitCode !== 0) {
		return { ok: false, output: commit.text().trim() || `git commit failed (${commit.exitCode})` };
	}
	return { ok: true, output: commit.text().trim() };
}

async function runSync(tree: OmpTree): Promise<{ ok: boolean; output: string }> {
	if (!fs.existsSync(tree.syncScript)) {
		return { ok: false, output: `Missing ${tree.syncScript}` };
	}
	const result = await $`bash ${tree.syncScript}`.cwd(tree.root).quiet().nothrow();
	const output = result.text().trim();
	if (result.exitCode !== 0) return { ok: false, output: output || `sync-vps-omp.sh exited ${result.exitCode}` };
	return { ok: true, output };
}

export async function applyChanges(
	changes: ModelChange[],
	scope: ApplyScope,
	commitMessage: string,
	tree = resolveOmpTree(),
): Promise<ApplyResult> {
	const preview = buildPreview(changes, scope, tree);
	const edits = plannedEdits(changes, scope, tree);
	if (edits.length === 0) {
		return { ...preview, applied: false, message: "Nothing to apply." };
	}

	for (const edit of edits) {
		fs.mkdirSync(path.dirname(edit.abs), { recursive: true });
		fs.writeFileSync(edit.abs, edit.after, "utf8");
	}

	let git: ApplyResult["git"];
	let sync: ApplyResult["sync"];
	if (scope === "both" || scope === "vps") {
		git = await runGit(tree, preview.files, commitMessage.trim() || "chore(omp): update model assignments");
		if (git.ok && fs.existsSync(tree.syncScript)) sync = await runSync(tree);
		else if (!fs.existsSync(tree.syncScript)) sync = { ok: false, output: `Missing ${tree.syncScript}` };
	}

	const parts = [APPLY_EFFECT];
	if (git && !git.ok) parts.push(`Git error: ${git.output}`);
	if (sync && !sync.ok) parts.push(`Sync error: ${sync.output}`);
	if (git?.ok && sync?.ok) parts.push("Committed and synced.");
	else if (scope === "mac") parts.push("Wrote local files only (no git, no VPS sync).");

	return {
		...preview,
		applied: true,
		git,
		sync,
		message: parts.join(" "),
	};
}

export function parseApplyBody(body: unknown): { changes: ModelChange[]; scope: ApplyScope; commitMessage: string } {
	if (!body || typeof body !== "object") throw new Error("JSON body required");
	const rec = body as Record<string, unknown>;
	const scope = rec.scope === "mac" || rec.scope === "vps" || rec.scope === "both" ? rec.scope : "both";
	const commitMessage = typeof rec.commitMessage === "string" ? rec.commitMessage : "";
	if (!Array.isArray(rec.changes)) throw new Error("changes must be an array");
	const changes: ModelChange[] = rec.changes.map((raw, index) => {
		if (!raw || typeof raw !== "object") throw new Error(`changes[${index}] must be an object`);
		const item = raw as Record<string, unknown>;
		const kind = item.kind;
		if (
			kind !== "role" &&
			kind !== "fallback" &&
			kind !== "agentOverride" &&
			kind !== "agentFrontmatter" &&
			kind !== "watchdog" &&
			kind !== "hermesModel" &&
			kind !== "hermesThinking" &&
			kind !== "hostPin"
		) {
			throw new Error(`changes[${index}].kind is invalid`);
		}
		if (typeof item.id !== "string" || !item.id) throw new Error(`changes[${index}].id is required`);
		if (kind === "agentFrontmatter" || kind === "agentOverride") {
			if (!AGENT_ID.test(item.id)) throw new Error(`changes[${index}].id is not a valid agent id`);
		}
		if (kind === "watchdog" && !/^\d+$/.test(item.id)) {
			throw new Error(`changes[${index}].id must be a watchdog advisor index`);
		}
		const value = item.value;
		if (
			value !== null &&
			typeof value !== "string" &&
			!(Array.isArray(value) && value.every(entry => typeof entry === "string"))
		) {
			throw new Error(`changes[${index}].value must be a string, string list, or null`);
		}
		return {
			kind,
			id: item.id,
			value: value as ModelChange["value"],
			hostOnly: item.hostOnly === true,
		};
	});
	return { changes, scope, commitMessage };
}
