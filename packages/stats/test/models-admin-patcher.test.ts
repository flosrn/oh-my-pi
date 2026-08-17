import { describe, expect, it } from "bun:test";
import {
	ensureAdvisorFallbackEmpty,
	setFrontmatterModel,
	setYamlPath,
	setYamlPaths,
	unifiedDiff,
} from "../src/models-admin/yaml-patch";

const SAMPLE = `# Shared OMP config — comments must survive
modelRoles:
  # primary chat
  advisor: xai/grok-4:high  # keep this
  default: anthropic/claude-sonnet-4:medium
  review: openai/gpt-4.1:low

retry:
  fallbackChains:
    advisor: []  # MUST stay empty
    default:
      - anthropic/claude-sonnet-4:medium
      - openai/gpt-4.1:low

task:
  agentModelOverrides:
    scout: "@smol"
    oracle: anthropic/claude-opus-4:high
`;

describe("comment-preserving YAML patcher", () => {
	it("keeps comments and key order when replacing a scalar", () => {
		const next = setYamlPath(SAMPLE, ["modelRoles", "advisor"], "openai/gpt-4.1:high");
		expect(next).toContain("# Shared OMP config — comments must survive");
		expect(next).toContain("  # primary chat");
		expect(next).toContain("  advisor: openai/gpt-4.1:high  # keep this");
		expect(next.indexOf("advisor:")).toBeLessThan(next.indexOf("default:"));
		expect(next.indexOf("default:")).toBeLessThan(next.indexOf("review:"));
		expect(next).toContain("  default: anthropic/claude-sonnet-4:medium");
	});

	it("forces retry.fallbackChains.advisor to stay []", () => {
		const attempted = setYamlPath(SAMPLE, ["retry", "fallbackChains", "advisor"], [
			"forbidden/should-not-land:low",
		]);
		expect(attempted).toContain("    advisor: []  # MUST stay empty");
		expect(attempted).not.toContain("forbidden/should-not-land:low");
		expect(ensureAdvisorFallbackEmpty("retry:\n  fallbackChains:\n    advisor:\n      - sneak\n")).toContain(
			"    advisor: []",
		);
	});

	it("replaces a block list without rewriting sibling comments", () => {
		const next = setYamlPath(SAMPLE, ["retry", "fallbackChains", "default"], [
			"google/gemini-2.5-pro:high",
		]);
		expect(next).toContain("    advisor: []  # MUST stay empty");
		expect(next).toContain("    default:");
		expect(next).toContain("      - google/gemini-2.5-pro:high");
		expect(next).not.toContain("anthropic/claude-sonnet-4:medium\n      - openai/gpt-4.1:low");
	});

	it("inserts a missing agent override under the existing map", () => {
		const next = setYamlPath(SAMPLE, ["task", "agentModelOverrides", "lfg-research"], "@smol");
		expect(next).toContain("    scout: \"@smol\"");
		expect(next).toContain("    oracle: anthropic/claude-opus-4:high");
		expect(next).toContain("    lfg-research: \"@smol\"");
		expect(next.indexOf("scout:")).toBeLessThan(next.indexOf("lfg-research:"));
	});

	it("patches agent frontmatter model as a string or a list", () => {
		const md = `---
name: scout
description: cheap look
model: "@smol"
---
# body stays
hello
`;
		const asString = setFrontmatterModel(md, "anthropic/claude-sonnet-4:low");
		expect(asString).toContain('model: anthropic/claude-sonnet-4:low');
		expect(asString).toContain("# body stays\nhello\n");

		const asList = setFrontmatterModel(md, ["openai/gpt-4.1:high", "openai/gpt-4.1:low"]);
		expect(asList).toContain("model:");
		expect(asList).toContain("  - openai/gpt-4.1:high");
		expect(asList).toContain("  - openai/gpt-4.1:low");
		expect(asList).toContain("---\n# body stays");
	});
});

describe("host overlay vs shared", () => {
	it("writes host pins into the overlay document, not shared config", () => {
		const shared = setYamlPaths(SAMPLE, [
			{ path: ["modelRoles", "default"], value: "anthropic/claude-sonnet-4:high" },
		]);
		expect(shared).toContain("  default: anthropic/claude-sonnet-4:high");
		expect(shared).toContain("# Shared OMP config");

		const overlaySrc = `# host-only pins
modelRoles:
  default: openai/gpt-4.1:low
`;
		const overlay = setYamlPath(overlaySrc, ["modelRoles", "default"], "openai/gpt-4.1:high");
		expect(overlay).toContain("# host-only pins");
		expect(overlay).toContain("  default: openai/gpt-4.1:high");
		expect(shared).not.toContain("openai/gpt-4.1:high");
	});

	it("preview diffs name the file that would change", () => {
		const after = setYamlPath(SAMPLE, ["modelRoles", "review"], "xai/grok-4:low");
		const diff = unifiedDiff("agent/config.yml", SAMPLE, after);
		expect(diff).toContain("--- a/agent/config.yml");
		expect(diff).toContain("+++ b/agent/config.yml");
		expect(diff).toContain("-  review: openai/gpt-4.1:low");
		expect(diff).toContain("+  review: xai/grok-4:low");
	});
});
