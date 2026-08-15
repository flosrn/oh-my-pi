import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { syncAllSessions } from "@oh-my-pi/omp-stats/aggregator";
import { getSessionsDir } from "@oh-my-pi/pi-utils";
import { handleApi } from "../src/server";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-usage-rollup-");

/**
 * A Session's spend is the spend of its actor transcripts, not of its lead file.
 *
 * Measured on a real session before this existed: the page showed 107 requests /
 * $17.90 while 336 / $29.57 had been spent, and the two models doing the dispatched
 * work appeared nowhere. The contract already required the other arithmetic -
 * "Recursive totals sum those observations once."
 */
const LEAD = "rollup-lead";
const DIR = "--tmp--rollup";

function usage(totalTokens: number, cost: number) {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	};
}

function assistant(id: string, model: string, totalTokens: number, cost: number) {
	return {
		type: "message",
		id,
		timestamp: "2026-08-13T10:01:00.000Z",
		message: {
			role: "assistant",
			api: "anthropic-messages",
			provider: "anthropic",
			model,
			content: [],
			usage: usage(totalTokens, cost),
			stopReason: "stop",
			timestamp: Date.parse("2026-08-13T10:01:00.000Z"),
		},
	};
}

function header(id: string) {
	return {
		type: "session",
		version: 3,
		id,
		timestamp: "2026-08-13T10:00:00.000Z",
		cwd: "/tmp/project",
		title: "Rollup session",
	};
}

async function writeTranscript(file: string, id: string, entries: unknown[]): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	await Bun.write(file, `${[header(id), ...entries].map(entry => JSON.stringify(entry)).join("\n")}\n`);
}

async function api(pathname: string): Promise<Response> {
	return handleApi(new Request(`http://localhost${pathname}`));
}

interface Rollup {
	rule: string;
	own: { requests: number; totalTokens: number; cost: number };
	related: Array<{
		executionId: string;
		kind: string;
		name: string | null;
		usage: { requests: number; totalTokens: number; cost: number };
	}>;
}

interface Usage {
	requests: number;
	totalTokens: number;
	cost: number;
	byModel: Array<{ model: string; requests: number }>;
}

describe("recursive usage rollup", () => {
	it("counts the lead, its subagents and its advisor once each", async () => {
		const root = path.join(getSessionsDir(), DIR);
		const lead = path.join(root, `2026-08-13_${LEAD}.jsonl`);
		const stem = path.join(root, `2026-08-13_${LEAD}`);

		// Lead: 2 requests, 100 tokens, $1.
		await writeTranscript(lead, LEAD, [
			assistant("lead-1", "claude-opus-5", 60, 0.6),
			assistant("lead-2", "claude-opus-5", 40, 0.4),
		]);
		// A dispatched subagent and the advisor - related transcripts of that Session (R2),
		// classified by their place in the lead's stem directory (KTD19).
		await writeTranscript(path.join(stem, "Scout.jsonl"), "scout-exec", [
			assistant("scout-1", "claude-sonnet-5", 30, 0.3),
		]);
		await writeTranscript(path.join(stem, "__advisor.default.jsonl"), "advisor-exec", [
			assistant("advisor-1", "grok-4.5", 10, 0.1),
		]);

		await syncAllSessions({ workers: 1 });

		const detail = (await (await api(`/api/sessions/${LEAD}`)).json()) as {
			usage: Usage;
			usageRollup: Rollup;
			relatedExecutions: Array<{ executionId: string; kind: string; name: string | null }>;
		};

		// The lead alone is what every number used to mean, and it is still reachable.
		expect(detail.usageRollup.own.requests).toBe(2);
		expect(detail.usageRollup.own.totalTokens).toBe(100);

		// R29: a compact DTO omits `sessionFile`. Reading the related transcripts' paths to
		// build this rollup put an absolute path one careless spread away from the wire.
		expect(JSON.stringify(detail)).not.toContain("sessionFile");
		expect(JSON.stringify(detail)).not.toContain(getSessionsDir());
		// Each child is named, so a timeline row can say WHICH child acted.
		expect(detail.relatedExecutions.map(item => item.name).sort()).toEqual(["Scout", "__advisor.default"]);

		// The flat numbers are now the recursive total.
		expect(detail.usage.requests).toBe(4);
		expect(detail.usage.totalTokens).toBe(140);
		expect(detail.usage.cost).toBeCloseTo(1.4, 6);

		// Sum once: no observation is attributed twice.
		const relatedRequests = detail.usageRollup.related.reduce((sum, member) => sum + member.usage.requests, 0);
		expect(detail.usageRollup.own.requests + relatedRequests).toBe(detail.usage.requests);

		// The models doing dispatched work are visible in the total.
		expect(detail.usage.byModel.map(item => item.model).sort()).toEqual([
			"claude-opus-5",
			"claude-sonnet-5",
			"grok-4.5",
		]);

		// Related transcripts stay related, never sibling Sessions (R2).
		const sessions = (await (await api("/api/sessions")).json()) as { items: Array<{ sessionId: string }> };
		expect(sessions.items.map(item => item.sessionId)).toEqual([LEAD]);

		// Same arithmetic on the usage endpoint the Tokens tab reads.
		const usageResponse = (await (await api(`/api/sessions/${LEAD}/usage`)).json()) as {
			requests: number;
			rollup: Rollup;
		};
		expect(usageResponse.requests).toBe(4);
		expect(usageResponse.rollup.own.requests).toBe(2);

		// The request LIST stays on the lead unless recursive scope is asked for: it has
		// no execution column yet, and a flat mix of lead, scout and advisor reads as soup.
		const own = (await (await api(`/api/sessions/${LEAD}/requests`)).json()) as { items: unknown[] };
		expect(own.items).toHaveLength(2);
		const recursive = (await (await api(`/api/sessions/${LEAD}/requests?scope=recursive`)).json()) as {
			items: unknown[];
		};
		expect(recursive.items).toHaveLength(4);

		// Tools aggregate by name, so they are recursive with no flag.
		const tools = (await (await api(`/api/sessions/${LEAD}/tools`)).json()) as { usage: { requests: number } };
		expect(tools.usage.requests).toBe(4);
	});
});
