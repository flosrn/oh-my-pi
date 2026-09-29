/**
 * A router serving a combo reports which provider, model and account answered
 * on each assistant message (`upstream*`). The session's attribution carries
 * that as `servingModel.served`, and the executor publishes it on the
 * subagent's progress so the Agent Hub and jobs rows can show who served —
 * always the latest settled turn, never a stale one.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { TurnRecovery, type TurnRecoveryHost } from "@oh-my-pi/pi-coding-agent/session/turn-recovery";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentProgress, SingleResult } from "@oh-my-pi/pi-tui/tools/task";
import { createSessionDefaults } from "../helpers/session-defaults";

const COMBO = buildModel({
	provider: "router",
	id: "task",
	name: "task",
	api: "openai-completions",
	baseUrl: "https://router.example.test",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8192,
});

function turn(served: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "answered" }],
		stopReason: "stop",
		...served,
	} as AssistantMessage;
}

function recoveryFor(model: Model, sessionId: string): TurnRecovery {
	return new TurnRecovery({
		model: () => model,
		thinkingLevel: () => undefined,
		sessionManager: { getSessionId: () => sessionId },
		settings: Settings.isolated({}),
		modelRegistry: {},
		configWarnings: [],
	} as unknown as TurnRecoveryHost);
}

describe("served target on the session attribution", () => {
	it("captures the settled message's served fields", async () => {
		const recovery = recoveryFor(COMBO, "served-capture");
		await recovery.onAssistantSettledSuccessfully(
			turn({
				upstreamProvider: "cc",
				upstreamModel: "claude-opus-5-5",
				upstreamAccount: "alice@example.com",
				upstreamFallbackAttempts: 1,
			}),
		);
		expect(recovery.servingModel?.served).toEqual({
			provider: "cc",
			model: "claude-opus-5-5",
			account: "alice@example.com",
			fallbackAttempts: 1,
		});
	});

	it("clears the served target when the next turn is served natively", async () => {
		const recovery = recoveryFor(COMBO, "served-clear");
		await recovery.onAssistantSettledSuccessfully(
			turn({ upstreamModel: "gpt-6-sol", upstreamAccount: "alice@example.com" }),
		);
		await recovery.onAssistantSettledSuccessfully(turn());
		expect(recovery.servingModel?.served).toBeUndefined();
	});

	it("keeps the served target of the last productive turn across an empty one", async () => {
		const recovery = recoveryFor(COMBO, "served-empty");
		await recovery.onAssistantSettledSuccessfully(turn({ upstreamModel: "gpt-6-sol" }));
		await recovery.onAssistantSettledSuccessfully({ ...turn(), content: [] } as AssistantMessage);
		expect(recovery.servingModel?.served).toEqual({ model: "gpt-6-sol" });
	});
});

describe("subagent progress carries the served target", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	async function runTurns(turns: AssistantMessage[]): Promise<{ snapshots: AgentProgress[]; result: SingleResult }> {
		const snapshots: AgentProgress[] = [];
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async () => {
			const recovery = recoveryFor(COMBO, "served-progress");
			const listeners: Array<(event: { type: string; [key: string]: unknown }) => void> = [];
			const session = {
				...createSessionDefaults(),
				agent: { state: { systemPrompt: ["test"] } },
				state: { messages: [] },
				model: COMBO,
				extensionRunner: undefined,
				sessionManager: { appendSessionInit: () => {} },
				getActiveToolNames: () => ["yield"],
				getEnabledToolNames: () => ["yield"],
				subscribe: (listener: (event: { type: string; [key: string]: unknown }) => void) => {
					listeners.push(listener);
					return () => {};
				},
				prompt: async () => {
					const emit = (event: { type: string; [key: string]: unknown }): void => {
						for (const listener of listeners) listener(event);
					};
					for (const message of turns) {
						await recovery.onAssistantSettledSuccessfully(message);
						emit({ type: "turn_end", message, toolResults: [] });
					}
					emit({
						type: "tool_execution_end",
						toolCallId: "tool-yield",
						toolName: "yield",
						result: { content: [{ type: "text", text: "Result submitted." }], details: { status: "success" } },
						isError: false,
					});
				},
			};
			Object.defineProperty(session, "servingModel", { get: () => recovery.servingModel });
			return {
				session: session as unknown as AgentSession,
				extensionsResult: {},
				setToolUIContext: () => {},
			} as never;
		});

		const settings = Settings.isolated({});
		settings.setModelRole("default", "router/task");
		const result = await runSubprocess({
			cwd: "/tmp",
			agent: { name: "task", description: "test", systemPrompt: "test", source: "bundled" },
			task: "work",
			index: 0,
			id: "served-progress",
			modelOverride: "router/task",
			settings,
			modelRegistry: {
				refresh: async () => {},
				getAvailable: () => [COMBO],
				getApiKey: async () => "test-key",
			} as never,
			enableLsp: false,
			onProgress: progress => {
				snapshots.push({ ...progress });
			},
		});
		return { snapshots, result };
	}

	it("publishes the served target and follows a later turn on another account", async () => {
		const { snapshots, result } = await runTurns([
			turn({ upstreamProvider: "cc", upstreamModel: "claude-opus-5-5", upstreamAccount: "alice@example.com" }),
			turn({ upstreamProvider: "cc", upstreamModel: "claude-opus-5-5", upstreamAccount: "bob@example.com" }),
		]);
		const accounts = snapshots.map(snapshot => snapshot.served?.account).filter(account => account !== undefined);
		expect(accounts).toContain("alice@example.com");
		expect(accounts.at(-1)).toBe("bob@example.com");
		expect(result.served).toEqual({ provider: "cc", model: "claude-opus-5-5", account: "bob@example.com" });
	});

	it("drops the served target once a turn is served natively", async () => {
		const { snapshots, result } = await runTurns([
			turn({ upstreamProvider: "cx", upstreamModel: "gpt-6-sol", upstreamAccount: "alice@example.com" }),
			turn(),
		]);
		expect(snapshots.some(snapshot => snapshot.served?.model === "gpt-6-sol")).toBe(true);
		expect(snapshots.at(-1)?.served).toBeUndefined();
		expect(result.served).toBeUndefined();
	});
});
