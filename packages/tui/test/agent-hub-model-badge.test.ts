import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { modelBadge } from "../src/overlays/agent-hub-renderer";
import type { AgentRecordLike, ServedTarget } from "../src/overlays/agent-hub-types";
import type { ObservableSession } from "../src/overlays/session-observer-registry";
import { setModelDisplayAliases } from "../src/render/render-utils";
import { initTheme, theme } from "../src/theme";

beforeAll(async () => {
	await initTheme();
});

afterEach(() => {
	setModelDisplayAliases({});
});

const codex: ServedTarget = { provider: "cx", model: "gpt-6-sol", account: "alice@example.com", fallbackAttempts: 1 };

function record(overrides: Partial<AgentRecordLike> = {}): AgentRecordLike {
	return {
		id: "Worker",
		displayName: "Worker",
		kind: "sub",
		status: "running",
		session: { thinkingLevel: ThinkingLevel.Medium } as unknown as AgentRecordLike["session"],
		sessionFile: null,
		createdAt: 0,
		lastActivity: 0,
		...overrides,
	};
}

function observed(progress: Record<string, unknown>): ObservableSession {
	return { id: "Worker", kind: "subagent", label: "Worker", progress } as unknown as ObservableSession;
}

const medium = () => theme.getThinkingBorderColor(ThinkingLevel.Medium)(theme.thinking.medium);

describe("agent hub model badge served target", () => {
	it("appends the served target and alias after the requested model", () => {
		setModelDisplayAliases({ accountAliases: { "alice@example.com": "a" } });
		const badge = modelBadge(record(), observed({ resolvedModel: "router/task", served: codex }));
		expect(Bun.stripANSI(badge ?? "")).toBe(`task → cx/gpt-6-sol${theme.sep.dot}a ${theme.thinking.medium}`);
		expect(badge).toContain(theme.fg("accent", "a"));
	});

	it("shows a handle's served model even when it is the expected one, and never hops", () => {
		setModelDisplayAliases({ accountAliases: { "alice@example.com": "a" } });
		const served = { provider: "cc", model: "claude-opus-5-5", account: "alice@example.com", fallbackAttempts: 2 };
		const badge = Bun.stripANSI(modelBadge(record(), observed({ resolvedModel: "router/opus-5.5", served })) ?? "");
		expect(badge).toBe(`opus-5.5 → cc/claude-opus-5-5${theme.sep.dot}a ${theme.thinking.medium}`);
		expect(badge).not.toContain(theme.icon.servedHops);
	});

	it("reads a parked agent's served target from its history and the main session's from its serving model", () => {
		const parked = record({
			status: "parked",
			session: null,
			history: { resolvedModel: "router/task", served: { model: "gpt-6-sol", account: "first.last@example.com" } },
		});
		expect(Bun.stripANSI(modelBadge(parked, undefined) ?? "")).toBe(`task → gpt-6-sol${theme.sep.dot}first.last`);

		const main = record({
			session: {
				thinkingLevel: undefined,
				servingModel: {
					selector: "router/task",
					isFallback: false,
					served: { provider: "cx", model: "gpt-6-sol" },
				},
			} as unknown as AgentRecordLike["session"],
		});
		expect(Bun.stripANSI(modelBadge(main, undefined) ?? "")).toBe("task → cx/gpt-6-sol");
	});

	it("keeps the retry-chain fallback rendering byte-identical", () => {
		const badge = modelBadge(
			record(),
			observed({ resolvedModel: "xai-oauth/grok-4.7", resolvedModelIsFallback: true, served: codex }),
		);
		expect(badge).toBe(`${theme.fg("warning", "fallback →")} ${theme.fg("muted", "xai-oauth/grok-4.7")} ${medium()}`);
	});

	it("renders byte-identically when nothing was served", () => {
		expect(modelBadge(record(), observed({ resolvedModel: "router/task" }))).toBe(
			`${theme.fg("muted", "task")} ${medium()}`,
		);
	});
});
