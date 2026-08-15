import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { syncAllSessions } from "@oh-my-pi/omp-stats/aggregator";
import { getSessionsDir } from "@oh-my-pi/pi-utils";
import { handleApi } from "../src/server";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-core-projection-");

/**
 * R8's first owner is "a core JSONL entry", and the reader only ever honoured the
 * second one. These are the entry kinds a real transcript writes, with prose planted
 * in every field the projection must refuse to copy.
 */
const LEAD = "projection-lead";
const PROSE = [
	"PROSE-TOOL-ARGS",
	"PROSE-TOOL-INTENT",
	"PROSE-PEER-BODY",
	"PROSE-TODO-TASK",
	"PROSE-COMPACTION-SUMMARY",
	"PROSE-CHILD-RESULT",
];

async function api(pathname: string): Promise<Response> {
	return handleApi(new Request(`http://localhost${pathname}`));
}

interface Timeline {
	items: Array<{ entryId: string; kind: string; timestamp: number; payload?: Record<string, unknown> }>;
}

describe("core entry timeline projection", () => {
	it("projects tools, control changes, phases and peer traffic without copying any body", async () => {
		const dir = path.join(getSessionsDir(), "--tmp--projection");
		await fs.mkdir(dir, { recursive: true });
		const entries = [
			{
				type: "session",
				version: 3,
				id: LEAD,
				timestamp: "2026-08-15T10:00:00.000Z",
				cwd: "/tmp/project",
				title: "Projection",
			},
			{
				type: "model_change",
				id: "mc-1",
				parentId: null,
				timestamp: "2026-08-15T10:00:01.000Z",
				model: "anthropic/claude-opus-5",
			},
			{
				type: "model_change",
				id: "mc-2",
				parentId: "mc-1",
				timestamp: "2026-08-15T10:00:02.000Z",
				model: "xai-oauth/grok-4.5",
				role: "fast",
			},
			{
				type: "thinking_level_change",
				id: "tl-1",
				parentId: "mc-2",
				timestamp: "2026-08-15T10:00:03.000Z",
				thinkingLevel: "high",
				configured: "high",
			},
			{ type: "mode_change", id: "md-1", parentId: "tl-1", timestamp: "2026-08-15T10:00:04.000Z", mode: "plan" },
			{
				type: "custom",
				customType: "tool_execution_start",
				id: "ts-1",
				parentId: "md-1",
				timestamp: "2026-08-15T10:00:05.000Z",
				data: { toolCallId: "call-1", toolName: "bash", args: { command: PROSE[0] }, intent: PROSE[1] },
			},
			{
				// A device call: recorded as `write`, and the real name is in args.path.
				type: "custom",
				customType: "tool_execution_start",
				id: "ts-2",
				parentId: "ts-1",
				timestamp: "2026-08-15T10:00:06.000Z",
				data: { toolCallId: "call-2", toolName: "write", args: { path: "xd://browser" } },
			},
			{
				type: "custom",
				customType: "user_todo_edit",
				id: "td-1",
				parentId: "ts-2",
				timestamp: "2026-08-15T10:00:07.000Z",
				data: {
					phases: [
						{
							name: "Foundation",
							tasks: [
								{ content: PROSE[3], status: "completed" },
								{ content: PROSE[3], status: "pending" },
							],
						},
					],
				},
			},
			{
				type: "custom_message",
				customType: "peer-message",
				id: "pm-1",
				parentId: "td-1",
				timestamp: "2026-08-15T10:00:08.000Z",
				content: PROSE[2],
				details: { peer: "vps-migration", model: "claude-sonnet-5", attributed: true, messageId: "msg_abc123" },
			},
			{
				type: "custom_message",
				customType: "async-result",
				id: "ar-1",
				parentId: "pm-1",
				timestamp: "2026-08-15T10:00:09.000Z",
				content: PROSE[5],
				// Shape measured on real transcripts, not the one that felt likely.
				details: { jobs: [{ jobId: "IntentLayer", type: "task", label: "IntentLayer", durationMs: 74732 }] },
			},
			{
				type: "custom_message",
				customType: "skill-prompt",
				id: "sk-1",
				parentId: "ar-1",
				timestamp: "2026-08-15T10:00:10.000Z",
				content: 'The user has invoked the "ce-commit" skill, indicating they want you to follow its instructions.',
			},
			{
				type: "compaction",
				id: "cp-1",
				parentId: "sk-1",
				timestamp: "2026-08-15T10:00:11.000Z",
				tokensBefore: 205014,
				firstKeptEntryId: "ts-1",
				summary: PROSE[4],
			},
			{
				type: "custom",
				customType: "session_exit",
				id: "se-1",
				parentId: "cp-1",
				timestamp: "2026-08-15T10:00:12.000Z",
				data: { kind: "normal", recordedAt: "2026-08-15T10:00:12.000Z" },
			},
		];
		await Bun.write(
			path.join(dir, `2026-08-15_${LEAD}.jsonl`),
			`${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`,
		);
		await syncAllSessions({ workers: 1 });

		const timeline = (await (await api(`/api/sessions/${LEAD}/timeline?limit=100`)).json()) as Timeline;
		const byKind = new Map(timeline.items.map(item => [item.kind, item]));

		// Every core entry kind this transcript records now owns a timeline fact.
		expect([...byKind.keys()].sort()).toEqual([
			"child_result",
			"compaction",
			"mode_change",
			"model_change",
			"peer_message",
			"progress",
			"session_exit",
			"skill_prompt",
			"thinking_level_change",
			"tool_call",
		]);

		// The projection declares its owner and its rule version (R8). Two model_change
		// entries land, so the map keeps the later one - the routed `fast` role.
		expect(byKind.get("model_change")?.payload).toMatchObject({
			source: "core:model_change",
			rule: "core-projection@1",
			role: "fast",
		});
		expect(byKind.get("thinking_level_change")?.payload).toMatchObject({ thinkingLevel: "high", configured: "high" });
		expect(byKind.get("mode_change")?.payload).toMatchObject({ mode: "plan" });
		expect(byKind.get("compaction")?.payload).toMatchObject({ tokensBefore: 205014, firstKeptEntryId: "ts-1" });
		expect(byKind.get("session_exit")?.payload).toMatchObject({ exitKind: "normal" });
		expect(byKind.get("skill_prompt")?.payload).toMatchObject({ skill: "ce-commit" });
		expect(byKind.get("child_result")?.payload).toMatchObject({ jobs: ["IntentLayer"] });

		// A peer message is recorded as who spoke and under what model, never as its text.
		expect(byKind.get("peer_message")?.payload).toMatchObject({
			peer: "vps-migration",
			peerModel: "claude-sonnet-5",
			attributed: true,
			messageId: "msg_abc123",
		});

		// Phases carry names and per-status counts, not task text.
		expect(byKind.get("progress")?.payload?.phases).toEqual([
			{ name: "Foundation", total: 2, byStatus: { completed: 1, pending: 1 } },
		]);

		// A device call stops reading as a file write.
		const tools = timeline.items.filter(item => item.kind === "tool_call");
		expect(tools.map(item => item.payload?.tool)).toEqual(["bash", "write"]);
		expect(tools.map(item => item.payload?.device)).toEqual([null, "browser"]);

		// R27: not one planted body reached the wire.
		const wire = JSON.stringify(timeline);
		for (const prose of PROSE) expect(wire).not.toContain(prose);

		// Lifecycle and control facts reach the Logs tab; tool calls and phases do not.
		const logs = (await (await api(`/api/sessions/${LEAD}/logs?limit=50`)).json()) as Timeline;
		const logKinds = new Set(logs.items.map(item => item.kind));
		expect(logKinds.has("model_change")).toBe(true);
		expect(logKinds.has("compaction")).toBe(true);
		expect(logKinds.has("session_exit")).toBe(true);
		expect(logKinds.has("tool_call")).toBe(false);
		expect(logKinds.has("progress")).toBe(false);

		// A projection never invents Run membership (ADR 0024, R5).
		const runs = (await (await api("/api/runs")).json()) as { items: unknown[] };
		expect(runs.items).toHaveLength(0);
		const detail = (await (await api(`/api/sessions/${LEAD}`)).json()) as { runIds: string[] };
		expect(detail.runIds).toEqual([]);
	});
});
