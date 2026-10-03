import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { cfgModelDisplayAccountAliases } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { statusLineHost } from "@oh-my-pi/pi-coding-agent/modes/status-line-host";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { StatusLineComponent } from "@oh-my-pi/pi-tui/status-line";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";
import { StatusLineTestComponents } from "./helpers/status-line";

const servedTurn = {
	role: "assistant",
	provider: "router",
	model: "task",
	content: [],
	upstreamProvider: "cx",
	upstreamModel: "gpt-6-sol",
	upstreamAccount: "alice@example.com",
	upstreamFallbackAttempts: 1,
};

describe("status line served target on a narrow bar", () => {
	const statusLines = new StatusLineTestComponents();

	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		await initTheme();
	});

	afterEach(() => {
		statusLines.dispose();
		resetSettingsForTest();
	});

	function modelOnlyBar(messages: unknown[]): StatusLineComponent {
		const model = {
			id: "task",
			name: "Task",
			provider: "router",
			contextWindow: 100_000,
			servedHeaders: { model: "x-served-model" },
		};
		const session = {
			state: { messages, model },
			messages,
			model,
			systemPrompt: [],
			agent: { state: { tools: [] } },
			skills: [],
			isStreaming: false,
			isAutoThinking: false,
			autoResolvedThinkingLevel: () => undefined,
			isFastModeActive: () => false,
			isAdvisorActive: () => false,
			getAdvisorStatusOverview: () => ({ configured: false, advisors: [] }),
			getAsyncJobSnapshot: () => ({ running: [] }),
			settings: { get: () => false },
			modelRegistry: { isUsingOAuth: () => false },
			getContextUsage: () => undefined,
		} as unknown as ConstructorParameters<typeof StatusLineComponent>[0];
		const component = statusLines.track(new StatusLineComponent(session, statusLineHost));
		component.updateSettings({
			preset: "custom",
			leftSegments: ["model"],
			rightSegments: [],
			sessionAccent: false,
			accountAliases: { "alice@example.com": "a" },
		});
		return component;
	}

	/** The model group alone: the bar pads to its width with a trailing rule. */
	const modelGroup = (component: StatusLineComponent, width: number) =>
		stripVTControlCharacters(component.getTopBorder(width).content).replace(/[─\s]+$/, "");

	it("drops the arrow first, then the hop marker, and keeps the alias to the end", () => {
		const bare = modelGroup(modelOnlyBar([]), 200);
		const full = modelGroup(modelOnlyBar([servedTurn]), 200);
		expect(full).toContain(`Task → cx/gpt-6-sol${theme.sep.dot}a ↻1`);

		const noArrow = modelGroup(modelOnlyBar([servedTurn]), Bun.stringWidth(full) - 1);
		expect(noArrow).toContain(`Task${theme.sep.dot}a ↻1`);
		expect(noArrow).not.toContain("→");

		const aliasOnly = modelGroup(modelOnlyBar([servedTurn]), Bun.stringWidth(noArrow) - 1);
		expect(aliasOnly).toContain(`Task${theme.sep.dot}a`);
		expect(aliasOnly).not.toContain("↻");

		expect(modelGroup(modelOnlyBar([servedTurn]), Bun.stringWidth(aliasOnly) - 1)).toBe(bare);
	});
});

describe("InteractiveMode status line after an alias edit", () => {
	let authStorage: AuthStorage;
	let mode: InteractiveMode;
	let session: AgentSession;
	let tempDir: TempDir;

	beforeEach(async () => {
		vi.spyOn(process.stdout, "write").mockReturnValue(true);
		vi.spyOn(process.stdin, "resume").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "pause").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "setEncoding").mockReturnValue(process.stdin);
		if (typeof process.stdin.setRawMode === "function") {
			vi.spyOn(process.stdin, "setRawMode").mockReturnValue(process.stdin);
		}
		await initTheme();
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-status-line-served-alias-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const registered = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!registered) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		const model = { ...registered, servedHeaders: { account: "x-served-account" } };
		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [],
					messages: [
						{
							...servedTurn,
							api: model.api,
							provider: model.provider,
							model: model.id,
							stopReason: "stop",
							timestamp: Date.now(),
							usage: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: 0,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
							},
						} as never,
					],
				},
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			// Production sessions share the global instance the settings UI edits.
			settings: Settings.instance,
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");
		vi.spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});
	});

	afterEach(async () => {
		mode?.stop();
		vi.restoreAllMocks();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	it("re-renders the served account under its new alias", async () => {
		await mode.init();
		const bar = () => stripVTControlCharacters(mode.statusLine.getTopBorder(240).content);
		expect(bar()).toContain(`${theme.sep.dot}alice ↻1`);

		cfgModelDisplayAccountAliases.set(settings, { "alice@example.com": "a" });
		// Live UI settings apply once per microtask.
		await Promise.resolve();
		expect(bar()).toContain(`${theme.sep.dot}a ↻1`);
		expect(bar()).not.toContain("alice");
	});
});
