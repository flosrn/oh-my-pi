import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { SegmentContext } from "../src/status-line/segments";
import { renderSegment } from "../src/status-line/segments";
import { initTheme, theme } from "../src/theme";
import { setSymbolPreset } from "../src/theme/theme";

beforeAll(async () => {
	await initTheme();
});

function createModelContext(advisorActive: boolean): SegmentContext {
	return {
		session: {
			state: { model: { id: "test-model", name: "Test Model" } },
			isFastModeActive: () => false,
			isAutoThinking: false,
			autoResolvedThinkingLevel: () => undefined,
			isAdvisorActive: () => advisorActive,
			getAdvisorStatusOverview: () => ({
				configured: advisorActive,
				advisors: advisorActive ? [{ name: "default", status: "running", yielded: false }] : [],
			}),
		} as unknown as SegmentContext["session"],
		width: 120,
		compactThinkingLevel: false,
		options: {},
		planMode: null,
		loopMode: null,
		prewalk: null,
		goalMode: null,
		vibeMode: null,
		vim: null,
		collab: null,
		stream: null,
		recording: false,
		usageStats: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			orchestrationInput: 0,
			orchestrationOutput: 0,
			orchestrationCacheRead: 0,
			premiumRequests: 0,
			cost: 0,
			tokensPerSecond: null,
		},
		contextPercent: 0,
		contextTokens: 0,
		contextWindow: 0,
		autoCompactEnabled: false,
		compactionSpeculation: "idle",
		speculationBlinkOn: true,
		subagentCount: 0,
		activeMs: 0,
		turnElapsedMs: null,
		activeRepo: null,
		worktree: null,
		git: { branch: null, status: null, pr: null },
		usage: null,
	};
}

describe("status line stream segment", () => {
	it("renders the live viewer badge only while attached", () => {
		const ctx = createModelContext(false);
		ctx.stream = { viewers: 7 };
		expect(renderSegment("stream", ctx)).toEqual({
			content: theme.fg("thinkingHigh", "● LIVE 7"),
			visible: true,
		});
		ctx.stream = null;
		expect(renderSegment("stream", ctx)).toEqual({ content: "", visible: false });
	});
});

describe("status line model segment advisor badge", () => {
	it("appends a success-colored advisor symbol when all advisors run", () => {
		const rendered = renderSegment("model", createModelContext(true));
		expect(rendered.content).toContain("Test Model");
		expect(rendered.content).toContain(theme.fg("success", ` ${theme.icon.advisor}`));
	});

	it("colors the badge by the worst roster status", () => {
		const ctx = createModelContext(true);
		ctx.session.getAdvisorStatusOverview = () => ({
			configured: true,
			advisors: [
				{ name: "a", status: "running", yielded: false },
				{ name: "b", status: "quota_exhausted", yielded: false },
			],
		});
		expect(renderSegment("model", ctx).content).toContain(theme.fg("warning", ` ${theme.icon.advisor}`));
		ctx.session.getAdvisorStatusOverview = () => ({
			configured: true,
			advisors: [
				{ name: "a", status: "error", yielded: false },
				{ name: "b", status: "quota_exhausted", yielded: false },
			],
		});
		expect(renderSegment("model", ctx).content).toContain(theme.fg("error", ` ${theme.icon.advisor}`));
	});
	it("closes the eye once every advisor has yielded its review", () => {
		const ctx = createModelContext(true);
		ctx.session.getAdvisorStatusOverview = () => ({
			configured: true,
			advisors: [{ name: "default", status: "running", yielded: true }],
		});
		const rendered = renderSegment("model", ctx).content;
		expect(rendered).toContain(theme.fg("success", ` ${theme.icon.advisorClosed}`));
		// ASCII mode resolves both icons to `(adv)`, so absence is only provable
		// when the two tokens differ.
		if (theme.icon.advisorClosed !== theme.icon.advisor) {
			expect(rendered).not.toContain(theme.icon.advisor);
		}
	});

	it("keeps the eye open while any advisor may still comment", () => {
		const ctx = createModelContext(true);
		ctx.session.getAdvisorStatusOverview = () => ({
			configured: true,
			advisors: [
				{ name: "a", status: "running", yielded: true },
				{ name: "b", status: "running", yielded: false },
			],
		});
		const rendered = renderSegment("model", ctx).content;
		expect(rendered).toContain(theme.fg("success", ` ${theme.icon.advisor}`));
		if (theme.icon.advisorClosed !== theme.icon.advisor) {
			expect(rendered).not.toContain(theme.icon.advisorClosed);
		}
	});

	it("omits the badge when the advisor is inactive", () => {
		const rendered = renderSegment("model", createModelContext(false));
		expect(rendered.content).toContain("Test Model");
		expect(rendered.content).not.toContain(theme.icon.advisor);
	});
});

describe("status line model segment compact thinking level", () => {
	function createThinkingContext(compactThinkingLevel: boolean): SegmentContext {
		return {
			...createModelContext(false),
			compactThinkingLevel,
			session: {
				state: {
					model: { id: "test-model", name: "Test Model", thinking: true },
					thinkingLevel: ThinkingLevel.High,
				},
				isFastModeActive: () => false,
				isAutoThinking: false,
				autoResolvedThinkingLevel: () => undefined,
				isAdvisorActive: () => false,
				getAdvisorStatusOverview: () => ({ configured: false, advisors: [] }),
			} as unknown as SegmentContext["session"],
		};
	}

	it("trails the level as a ` · <level>` suffix when compact mode is off", () => {
		const display = theme.thinking.high;
		const modelPrefix = theme.icon.model ? `${theme.icon.model} ` : "";
		const rendered = renderSegment("model", createThinkingContext(false));
		expect(Bun.stripANSI(rendered.content)).toBe(`${modelPrefix}Test Model${theme.sep.dot}${display}`);
	});

	it("swaps the model icon for the level glyph and drops the suffix when compact", () => {
		const display = theme.thinking.high;
		const glyph = display.includes(" ") ? display.slice(0, display.indexOf(" ")) : display;
		const rendered = renderSegment("model", createThinkingContext(true));
		expect(Bun.stripANSI(rendered.content)).toBe(`${glyph} Test Model`);
		expect(Bun.stripANSI(rendered.content)).not.toContain(theme.sep.dot);
	});
});

describe("status line model segment served target", () => {
	const aliases = { accountAliases: { "alice@example.com": "a" } };
	const handle = {
		id: "opus-5.5",
		name: "Opus 5.5",
		provider: "router",
		thinking: true,
		expectedUpstreamModel: "claude-opus-5-5",
	};
	const pool = { id: "task", name: "Task", provider: "router", thinking: true };

	function assistant(model: { id: string; provider: string }, served: Record<string, unknown>) {
		return { role: "assistant", provider: model.provider, model: model.id, content: [], ...served };
	}

	function createServedContext(
		model: Record<string, unknown>,
		messages: unknown[],
		overrides: Partial<SegmentContext> = {},
		slowModeLabel?: string,
	): SegmentContext {
		return {
			...createModelContext(false),
			modelDisplayAliases: aliases,
			...overrides,
			session: {
				state: { model, thinkingLevel: ThinkingLevel.Medium, messages },
				isFastModeActive: () => false,
				isAutoThinking: false,
				autoResolvedThinkingLevel: () => undefined,
				isAdvisorActive: () => false,
				getAdvisorStatusOverview: () => ({ configured: false, advisors: [] }),
				getAnthropicSlowModeLabel: () => slowModeLabel,
			} as unknown as SegmentContext["session"],
		};
	}

	const plain = (ctx: SegmentContext) => Bun.stripANSI(renderSegment("model", ctx).content);

	it("shows only the alias when a handle card is served its expected model", () => {
		const base = plain(createServedContext(handle, []));
		const ctx = createServedContext(handle, [
			assistant(handle, {
				upstreamProvider: "cc",
				upstreamModel: "claude-opus-5-5",
				upstreamAccount: "alice@example.com",
			}),
		]);
		expect(plain(ctx)).toBe(`${base}${theme.sep.dot}a`);
		expect(renderSegment("model", ctx).content).toContain(theme.fg("accent", "a"));
	});

	it("shows the served target, alias and hops for a pool card, before the slow-mode label", () => {
		const messages = [
			assistant(pool, {
				upstreamProvider: "cx",
				upstreamModel: "gpt-6-sol",
				upstreamAccount: "alice@example.com",
				upstreamFallbackAttempts: 1,
			}),
		];
		const base = plain(createServedContext(pool, []));
		expect(plain(createServedContext(pool, messages))).toBe(`${base} → cx/gpt-6-sol${theme.sep.dot}a ↻1`);
		const rendered = renderSegment("model", createServedContext(pool, messages, {}, "wrap-up")).content;
		expect(rendered).toContain(theme.fg("warning", " ↻1"));
		expect(Bun.stripANSI(rendered)).toBe(`${base} → cx/gpt-6-sol${theme.sep.dot}a ↻1${theme.sep.dot}wrap-up`);
	});

	it("marks router retries on a handle card and omits the marker at zero", () => {
		const base = plain(createServedContext(handle, []));
		const served = { upstreamModel: "claude-opus-5-5", upstreamAccount: "alice@example.com" };
		expect(plain(createServedContext(handle, [assistant(handle, { ...served, upstreamFallbackAttempts: 1 })]))).toBe(
			`${base}${theme.sep.dot}a ↻1`,
		);
		expect(plain(createServedContext(handle, [assistant(handle, { ...served, upstreamFallbackAttempts: 0 })]))).toBe(
			`${base}${theme.sep.dot}a`,
		);
	});

	it("shows a misrouted handle's served model", () => {
		const base = plain(createServedContext(handle, []));
		const ctx = createServedContext(handle, [
			assistant(handle, {
				upstreamProvider: "cc",
				upstreamModel: "claude-sonnet-5",
				upstreamAccount: "alice@example.com",
			}),
		]);
		expect(plain(ctx)).toBe(`${base} → cc/claude-sonnet-5${theme.sep.dot}a`);
	});

	it("renders the new card exactly as before after a model switch", () => {
		const base = plain(createServedContext(pool, []));
		const ctx = createServedContext(pool, [
			assistant(handle, { upstreamModel: "claude-opus-5-5", upstreamAccount: "alice@example.com" }),
		]);
		expect(renderSegment("model", ctx).content).toBe(renderSegment("model", createServedContext(pool, [])).content);
		expect(plain(ctx)).toBe(base);
	});

	it("renders the local part of an unmapped account", () => {
		const base = plain(createServedContext(handle, []));
		const ctx = createServedContext(handle, [
			assistant(handle, { upstreamModel: "claude-opus-5-5", upstreamAccount: "first.last@example.com" }),
		]);
		expect(plain(ctx)).toBe(`${base}${theme.sep.dot}first.last`);
	});

	it("omits absent parts without dangling separators", () => {
		const base = plain(createServedContext(pool, []));
		expect(
			plain(createServedContext(pool, [assistant(pool, { upstreamProvider: "cx", upstreamModel: "gpt-6-sol" })])),
		).toBe(`${base} → cx/gpt-6-sol`);
		expect(plain(createServedContext(pool, [assistant(pool, { upstreamModel: "gpt-6-sol" })]))).toBe(
			`${base} → gpt-6-sol`,
		);
		expect(
			plain(
				createServedContext(pool, [
					assistant(pool, { upstreamProvider: "cx", upstreamAccount: "alice@example.com" }),
				]),
			),
		).toBe(`${base}${theme.sep.dot}a`);
	});

	it("renders byte-identically when the last turn carries no served fields", () => {
		const native = { id: "grok-4.7", name: "Grok 4.7", provider: "xai-oauth", thinking: true };
		const ctx = createServedContext(native, [assistant(native, {})]);
		expect(renderSegment("model", ctx).content).toBe(renderSegment("model", createServedContext(native, [])).content);
	});

	it("drops the arrow first, then hops, and the alias last", () => {
		const messages = [
			assistant(pool, {
				upstreamProvider: "cx",
				upstreamModel: "gpt-6-sol",
				upstreamAccount: "alice@example.com",
				upstreamFallbackAttempts: 2,
			}),
		];
		const base = plain(createServedContext(pool, []));
		const at = (modelServedDrop: number) => plain(createServedContext(pool, messages, { modelServedDrop }));
		expect(at(1)).toBe(`${base}${theme.sep.dot}a ↻2`);
		expect(at(2)).toBe(`${base}${theme.sep.dot}a`);
		expect(at(3)).toBe(base);
	});
});

describe("status line served markers under the ASCII symbol preset", () => {
	afterAll(async () => {
		await setSymbolPreset("unicode");
	});

	it("renders the served arrow and hop marker as ASCII fallbacks", async () => {
		await setSymbolPreset("ascii");
		const model = { id: "task", name: "Task", provider: "router" };
		const ctx: SegmentContext = {
			...createModelContext(false),
			modelDisplayAliases: { accountAliases: { "alice@example.com": "a" } },
			session: {
				state: {
					model,
					messages: [
						{
							role: "assistant",
							provider: "router",
							model: "task",
							upstreamProvider: "cx",
							upstreamModel: "gpt-6-sol",
							upstreamAccount: "alice@example.com",
							upstreamFallbackAttempts: 1,
						},
					],
				},
				isFastModeActive: () => false,
				isAutoThinking: false,
				autoResolvedThinkingLevel: () => undefined,
				getAdvisorStatusOverview: () => ({ configured: false, advisors: [] }),
			} as unknown as SegmentContext["session"],
		};
		expect(Bun.stripANSI(renderSegment("model", ctx).content)).toEndWith(` -> cx/gpt-6-sol${theme.sep.dot}a x1`);
	});
});
