import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import { applyChanges, buildPreview, parseApplyBody } from "../src/models-admin/apply";
import type { OmpTree } from "../src/models-admin/paths";

const SHARED = `# Shared OMP config
modelRoles:
  advisor: xai/grok-4:high  # keep
  default: anthropic/claude-sonnet-4:medium

retry:
  fallbackChains:
    advisor: []  # MUST stay empty

task:
  agentModelOverrides:
    scout: "@smol"
`;

function makeTree(): OmpTree {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-admin-"));
	const agentDir = path.join(root, "agent");
	fs.mkdirSync(path.join(agentDir, "agents"), { recursive: true });
	fs.mkdirSync(path.join(agentDir, "scripts"), { recursive: true });
	fs.mkdirSync(path.join(root, "hosts"), { recursive: true });
	fs.writeFileSync(path.join(agentDir, "config.yml"), SHARED);
	fs.writeFileSync(
		path.join(agentDir, "WATCHDOG.yml"),
		`advisors:\n  - name: primary\n    model: xai/grok-4:high\n`,
	);
	fs.writeFileSync(
		path.join(agentDir, "agents", "scout.md"),
		`---\nname: scout\nmodel: "@smol"\n---\nscout body\n`,
	);
	fs.writeFileSync(
		path.join(agentDir, "hermes-memory-config.json"),
		`${JSON.stringify({ llmModelOverride: "xai/grok-4:low" }, null, 2)}\n`,
	);
	return {
		root,
		agentDir,
		configYml: path.join(agentDir, "config.yml"),
		watchdogYml: path.join(agentDir, "WATCHDOG.yml"),
		agentsDir: path.join(agentDir, "agents"),
		hermesJson: path.join(agentDir, "hermes-memory-config.json"),
		modelsYml: path.join(agentDir, "models.yml"),
		hostsDir: path.join(root, "hosts"),
		macHostYml: path.join(root, "hosts", "mac.yml"),
		vpsHostYml: path.join(root, "hosts", "gapicore.yml"),
		syncScript: path.join(agentDir, "scripts", "sync-vps-omp.sh"),
		present: true,
		git: false,
		kind: "checkout",
	};
}

const trees: string[] = [];

afterEach(() => {
	for (const root of trees) fs.rmSync(root, { recursive: true, force: true });
	trees.length = 0;
});

describe("apply scope", () => {
	it("mac-only writes shared files and leaves the VPS overlay untouched", async () => {
		const tree = makeTree();
		trees.push(tree.root);
		const result = await applyChanges(
			[{ kind: "role", id: "default", value: "openai/gpt-4.1:high" }],
			"mac",
			"test",
			tree,
		);
		expect(result.applied).toBe(true);
		expect(result.git).toBeUndefined();
		expect(result.sync).toBeUndefined();
		const config = fs.readFileSync(tree.configYml, "utf8");
		expect(config).toContain("# Shared OMP config");
		expect(config).toContain("  default: openai/gpt-4.1:high");
		expect(config).toContain("    advisor: []  # MUST stay empty");
		expect(fs.existsSync(tree.vpsHostYml)).toBe(false);
	});

	it("vps-only writes hosts/gapicore.yml and does not rewrite shared config.yml", async () => {
		const tree = makeTree();
		trees.push(tree.root);
		const before = fs.readFileSync(tree.configYml, "utf8");
		const preview = buildPreview(
			[{ kind: "role", id: "default", value: "openai/gpt-4.1:high" }],
			"vps",
			tree,
		);
		expect(preview.files).toEqual(["hosts/gapicore.yml"]);
		await applyChanges([{ kind: "role", id: "default", value: "openai/gpt-4.1:high" }], "vps", "test", tree);
		expect(fs.readFileSync(tree.configYml, "utf8")).toBe(before);
		expect(fs.readFileSync(tree.vpsHostYml, "utf8")).toContain("  default: openai/gpt-4.1:high");
	});

	it("host-only pins never land in config.yml", async () => {
		const tree = makeTree();
		trees.push(tree.root);
		const before = fs.readFileSync(tree.configYml, "utf8");
		await applyChanges(
			[{ kind: "hostPin", id: "default", value: "google/gemini-2.5-pro:high", hostOnly: true }],
			"mac",
			"test",
			tree,
		);
		expect(fs.readFileSync(tree.configYml, "utf8")).toBe(before);
		expect(fs.readFileSync(tree.macHostYml, "utf8")).toContain("google/gemini-2.5-pro:high");
		expect(fs.readFileSync(tree.macHostYml, "utf8")).toContain("# host-only");
	});
});

describe("apply safety", () => {
	it("quotes @role aliases when writing WATCHDOG.yml", async () => {
		const tree = makeTree();
		trees.push(tree.root);
		await applyChanges([{ kind: "watchdog", id: "0", value: "@smol" }], "mac", "test", tree);
		expect(fs.readFileSync(tree.watchdogYml, "utf8")).toContain('model: "@smol"');
		expect(fs.readFileSync(tree.watchdogYml, "utf8")).not.toContain("model: @smol\n");
	});

	it("writes WATCHDOG.yml when the advisor role changes", async () => {
		const tree = makeTree();
		trees.push(tree.root);
		await applyChanges([{ kind: "role", id: "advisor", value: "openai/gpt-4.1:high" }], "mac", "test", tree);
		expect(fs.readFileSync(tree.configYml, "utf8")).toContain("  advisor: openai/gpt-4.1:high");
		expect(fs.readFileSync(tree.watchdogYml, "utf8")).toContain("    model: openai/gpt-4.1:high");
	});

	it("rejects agent ids that escape agentsDir", () => {
		const tree = makeTree();
		trees.push(tree.root);
		expect(() =>
			parseApplyBody({
				scope: "mac",
				changes: [{ kind: "agentFrontmatter", id: "../../README", value: "x" }],
			}),
		).toThrow(/valid agent id/);
		expect(() =>
			buildPreview([{ kind: "agentFrontmatter", id: "../../README", value: "x" }], "mac", tree),
		).toThrow(/Invalid agent id/);
		expect(fs.existsSync(path.join(tree.root, "README.md"))).toBe(false);
	});

	it("commits only the admin files when the index already has other staged work", async () => {
		const tree = makeTree();
		trees.push(tree.root);
		tree.git = true;
		await $`git -C ${tree.root} init`.quiet();
		await $`git -C ${tree.root} config user.email test@example.com`.quiet();
		await $`git -C ${tree.root} config user.name test`.quiet();
		await $`git -C ${tree.root} add -A`.quiet();
		await $`git -C ${tree.root} commit -m init`.quiet();
		fs.writeFileSync(path.join(tree.root, "leftover.txt"), "staged leftover\n");
		await $`git -C ${tree.root} add leftover.txt`.quiet();

		const result = await applyChanges(
			[{ kind: "role", id: "default", value: "openai/gpt-4.1:high" }],
			"both",
			"admin models",
			tree,
		);
		expect(result.applied).toBe(true);
		expect(result.git?.ok).toBe(true);
		const names = (await $`git -C ${tree.root} show --pretty=format: --name-only HEAD`.quiet()).text();
		expect(names).toContain("agent/config.yml");
		expect(names).not.toContain("leftover.txt");
		const staged = (await $`git -C ${tree.root} diff --cached --name-only`.quiet()).text();
		expect(staged).toContain("leftover.txt");
	});
});
