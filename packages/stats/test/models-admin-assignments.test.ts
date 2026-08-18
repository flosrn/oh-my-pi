import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadSnapshot } from "../src/models-admin/assignments";
import type { OmpTree } from "../src/models-admin/paths";

function makeTree(): OmpTree {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-admin-cat-"));
	const agentDir = path.join(root, "agent");
	fs.mkdirSync(path.join(agentDir, "agents"), { recursive: true });
	fs.mkdirSync(path.join(root, "hosts"), { recursive: true });
	fs.writeFileSync(
		path.join(agentDir, "config.yml"),
		`modelRoles:\n  default: anthropic/claude-sonnet-4:medium\n`,
	);
	fs.writeFileSync(
		path.join(agentDir, "models.yml"),
		`providers:
  clinepass:
    baseUrl: http://127.0.0.1:8787/v1
    apiKey: CLINE_API_KEY
    headers:
      Authorization: Bearer sk-secret
    models:
      - id: cline-pass/deepseek-v4-flash
        name: DeepSeek V4 Flash (ClinePass)
`,
	);
	fs.writeFileSync(path.join(agentDir, "WATCHDOG.yml"), `advisors:\n  - name: primary\n    model: "@smol"\n`);
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

describe("models-admin catalog", () => {
	it("keeps model ids and omits credentials and endpoints", () => {
		const tree = makeTree();
		trees.push(tree.root);
		const snapshot = loadSnapshot(tree);
		expect(snapshot.catalog).toContain("cline-pass/deepseek-v4-flash");
		expect(snapshot.catalog).toContain("anthropic/claude-sonnet-4:medium");
		expect(snapshot.catalog).toContain("@smol");
		expect(snapshot.catalog).not.toContain("CLINE_API_KEY");
		expect(snapshot.catalog).not.toContain("http://127.0.0.1:8787/v1");
		expect(snapshot.catalog).not.toContain("Bearer sk-secret");
		expect(snapshot.catalog).not.toContain("DeepSeek V4 Flash (ClinePass)");
	});
});
