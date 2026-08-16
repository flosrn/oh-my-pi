import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { syncAllSessions } from "@oh-my-pi/omp-stats/aggregator";
import { listRuns, listSessions } from "@oh-my-pi/omp-stats/query";
import { getSessionsDir } from "@oh-my-pi/pi-utils";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-status-evidence-");

function header(id: string) {
	return { type: "session", version: 3, id, timestamp: "2026-08-13T10:00:00.000Z", cwd: "/tmp/project", title: id };
}
function assign(id: string, runId: string) {
	return {
		type: "custom",
		id,
		parentId: null,
		timestamp: "2026-08-13T10:01:00.000Z",
		customType: "observability",
		data: { v: 1, kind: "run_assignment", runId },
	};
}
function exit(id: string, kind: string) {
	return {
		type: "custom",
		id,
		parentId: null,
		timestamp: "2026-08-13T10:02:00.000Z",
		customType: "session_exit",
		data: { kind, reason: "quit", recordedAt: "2026-08-13T10:02:00.000Z" },
	};
}
async function createSession(id: string, entries: unknown[]): Promise<void> {
	const dir = path.join(getSessionsDir(), "--project-status");
	await fs.mkdir(dir, { recursive: true });
	await Bun.write(
		path.join(dir, `2026-08-13_${id}.jsonl`),
		`${[header(id), ...entries].map(JSON.stringify).join("\n")}\n`,
	);
}

describe("status is claimed from evidence", () => {
	it("leaves a session with no terminal event unknown, and never lets a run infer completion from it", async () => {
		// The defect this pins: `active` was the fallback for "no session_exit found", so it
		// accumulated on every session that was killed, crashed, or simply never wrote one -
		// measured 130 sessions active, 124 of them untouched for over 24 h. A file on disk
		// cannot witness a running process, so the absence of a terminal event is unknown.
		await createSession("no-exit", [assign("a1", "run_open")]);
		await createSession("clean-exit", [assign("a2", "run_done"), exit("e2", "normal")]);
		await createSession("killed", [assign("a3", "run_killed"), exit("e3", "aborted")]);
		await syncAllSessions({ workers: 1 });

		const byId = new Map((await listSessions()).items.map(item => [item.sessionId, item.status]));
		expect(byId.get("no-exit")).toBe("unknown");
		expect(byId.get("clean-exit")).toBe("completed");
		expect(byId.get("killed")).toBe("interrupted");
		expect([...byId.values()]).not.toContain("active");

		// The trap in the fix: the run derivation tested `status !== "active"`, which was
		// equivalent while `active` was the only non-terminal state. Kept as-is it would call
		// a run of entirely unknown sessions completed - the same overclaim, pointed at the
		// finish line instead of at liveness.
		const runs = new Map((await listRuns()).items.map(item => [item.runId, item.status]));
		expect(runs.get("run_open")).toBe("unknown");
		expect(runs.get("run_done")).toBe("completed");
		expect(runs.get("run_killed")).toBe("completed");
	});
});
