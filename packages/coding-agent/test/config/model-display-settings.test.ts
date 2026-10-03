import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { type RawSettings, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	cfgModelDisplayAccountAliases,
	cfgModelDisplayProviderAliases,
} from "@oh-my-pi/pi-coding-agent/modes/settings";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { servedModelParts } from "@oh-my-pi/pi-tui/render/render-utils";
import { TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

describe("modelDisplay alias settings", () => {
	let state: SettingsTestState | undefined;
	let tempDir: TempDir;
	let agentDir: string;
	let cwd: string;

	beforeEach(() => {
		state = beginSettingsTest();
		tempDir = TempDir.createSync("@pi-model-display-aliases-");
		agentDir = tempDir.join("agent");
		cwd = tempDir.join("project");
		for (const dir of [agentDir, cwd]) fs.mkdirSync(dir, { recursive: true });
	});

	afterEach(() => {
		restoreSettingsTestState(state);
		state = undefined;
		AgentStorage.close();
		Bun.gc(true);
		tempDir.removeSync();
	});

	const configPath = () => path.join(agentDir, "config.yml");

	it("round-trips dotted email keys through load, get and set, and resolves them at render", async () => {
		await Bun.write(
			configPath(),
			YAML.stringify({
				modelDisplay: { accountAliases: { "first.last@example.com": "fl" }, providerAliases: { cx: "codex" } },
			}),
		);
		const settings = await Settings.loadIsolated({ agentDir, cwd });
		expect(cfgModelDisplayAccountAliases.get(settings)).toEqual({ "first.last@example.com": "fl" });

		cfgModelDisplayAccountAliases.setEntry(settings, "alice.b@example.com", "a");
		await settings.flush();
		const persisted = YAML.parse(await Bun.file(configPath()).text()) as RawSettings;
		expect(persisted).toEqual({
			modelDisplay: {
				accountAliases: { "first.last@example.com": "fl", "alice.b@example.com": "a" },
				providerAliases: { cx: "codex" },
			},
		});

		const reloaded = await Settings.loadIsolated({ agentDir, cwd });
		const aliases = {
			accountAliases: cfgModelDisplayAccountAliases.get(reloaded),
			providerAliases: cfgModelDisplayProviderAliases.get(reloaded),
		};
		expect(
			servedModelParts("task", { provider: "cx", model: "gpt-6-sol", account: "alice.b@example.com" }, aliases),
		).toEqual({ requested: "task", servedProvider: "codex", servedModel: "gpt-6-sol", alias: "a" });
		expect(servedModelParts("task", { account: "first.last@example.com" }, aliases).alias).toBe("fl");
	});
});
