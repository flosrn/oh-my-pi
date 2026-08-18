import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";

export interface OmpTree {
	root: string;
	agentDir: string;
	configYml: string;
	watchdogYml: string;
	agentsDir: string;
	hermesJson: string;
	modelsYml: string;
	hostsDir: string;
	macHostYml: string;
	vpsHostYml: string;
	syncScript: string;
	present: boolean;
	git: boolean;
	kind: "home" | "checkout" | "override" | "missing";
}

function exists(p: string): boolean {
	try {
		return fs.existsSync(p);
	} catch {
		return false;
	}
}

function looksLikeOmpTree(root: string): boolean {
	return (
		exists(path.join(root, "agent", "config.yml")) ||
		exists(path.join(root, "agent", "config.yaml")) ||
		exists(path.join(root, "agent", "agents")) ||
		exists(path.join(root, "hosts"))
	);
}

function firstExisting(candidates: string[]): string {
	return candidates.find(exists) ?? candidates[0];
}

function defaultHomeRoot(): string {
	try {
		const require = createRequire(import.meta.url);
		const utils = require("@oh-my-pi/pi-utils") as { getConfigRootDir?: () => string; getAgentDir?: () => string };
		if (typeof utils.getConfigRootDir === "function") return utils.getConfigRootDir();
	} catch {
		// Cloud/Mac may not have the utils package resolvable from this file.
	}
	return path.join(os.homedir(), ".omp");
}

export function resolveOmpTree(override = process.env.OMP_HOME ?? process.env.OMP_RUNTIME_ROOT): OmpTree {
	const candidates: Array<{ root: string; kind: OmpTree["kind"] }> = [];
	if (override?.trim()) candidates.push({ root: path.resolve(override.trim()), kind: "override" });
	candidates.push({ root: defaultHomeRoot(), kind: "home" });
	const cwd = process.cwd();
	if (looksLikeOmpTree(cwd)) candidates.push({ root: cwd, kind: "checkout" });
	const parent = path.dirname(cwd);
	if (looksLikeOmpTree(parent)) candidates.push({ root: parent, kind: "checkout" });

	const hit =
		candidates.find(c => looksLikeOmpTree(c.root)) ??
		({ root: candidates[0]?.root ?? path.join(os.homedir(), ".omp"), kind: "missing" as const });
	const root = hit.root;
	const present = looksLikeOmpTree(root);
	const agentDir = path.join(root, "agent");

	return {
		root,
		agentDir,
		configYml: firstExisting([path.join(agentDir, "config.yml"), path.join(agentDir, "config.yaml")]),
		watchdogYml: path.join(agentDir, "WATCHDOG.yml"),
		agentsDir: path.join(agentDir, "agents"),
		hermesJson: path.join(agentDir, "hermes-memory-config.json"),
		modelsYml: firstExisting([path.join(agentDir, "models.yml"), path.join(root, "models.yml")]),
		hostsDir: path.join(root, "hosts"),
		macHostYml: path.join(root, "hosts", "mac.yml"),
		vpsHostYml: path.join(root, "hosts", "gapicore.yml"),
		syncScript: path.join(agentDir, "scripts", "sync-vps-omp.sh"),
		present,
		git: exists(path.join(root, ".git")),
		kind: present ? hit.kind : "missing",
	};
}

export function relativeToRoot(tree: OmpTree, absPath: string): string {
	return path.relative(tree.root, absPath).split(path.sep).join("/");
}
