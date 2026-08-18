import { describe, expect, it } from "bun:test";
import { pickerOptions, suggestionsForAgent, suggestionsForRole } from "../src/client/routes/model-suggestions";

describe("model suggestions", () => {
	it("keeps the current pin first and does not filter on empty query", () => {
		const options = pickerOptions(
			"",
			suggestionsForRole("advisor"),
			["cline-pass/kimi-k3", "anthropic/claude-opus-5:high"],
			"alibaba-token-plan/deepseek-v4-flash-0731:high",
		);
		expect(options[0]).toBe("alibaba-token-plan/deepseek-v4-flash-0731:high");
		expect(options).toEqual([
			"alibaba-token-plan/deepseek-v4-flash-0731:high",
			"alibaba-token-plan/deepseek-v4-flash-0731:max",
			"alibaba-token-plan/deepseek-v4-flash-0731",
		]);
		expect(options).not.toContain("cline-pass/kimi-k3");
	});

	it("opens typed overflow from the full catalog", () => {
		const options = pickerOptions(
			"kimi",
			suggestionsForRole("default"),
			["cline-pass/kimi-k3", "anthropic/claude-opus-5:high"],
			"anthropic/claude-opus-5:high",
		);
		expect(options).toContain("cline-pass/kimi-k3");
	});

	it("classifies scout vs mechanical vs judgment agents", () => {
		expect(suggestionsForAgent("scout")[0]).toBe("@smol");
		expect(suggestionsForAgent("code-quality-reviewer")[0]).toContain("deepseek");
		expect(suggestionsForAgent("security-reviewer")[0]).toContain("gpt-5.6-sol");
	});
});
