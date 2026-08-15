import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	type AssistantMessage,
	coerceServiceTierByFamily,
	getPriorityPremiumRequests,
	resolveModelServiceTier,
	type ServiceTierByFamily,
	type ToolCall,
	type ToolResultMessage,
	type Usage,
} from "@oh-my-pi/pi-ai";
import { getSessionsDir, isEnoent, readLines } from "@oh-my-pi/pi-utils";
import type {
	AgentType,
	MessageStats,
	ParsedObservabilityEntry,
	ParsedSessionExit,
	ParsedSessionHeader,
	SessionCustomEntry,
	SessionEntry,
	SessionMessageEntry,
	SessionServiceTierChangeEntry,
	ToolCallStats,
	ToolResultLink,
	UserMessageLink,
	UserMessageStats,
} from "./types";
import { computeUserMessageMetrics } from "./user-metrics";

/** Basename of an advisor agent's transcript inside a session artifacts dir. */
const ADVISOR_TRANSCRIPT_BASENAME = "__advisor.jsonl";

/**
 * Classify which agent produced a transcript from its path within the sessions
 * directory. Layout: `<sessionsDir>/<project>/<file>.jsonl` is the `main`
 * agent; subagent and advisor transcripts live nested one level deeper inside
 * the session's artifacts dir (`<project>/<session>/<id>.jsonl`,
 * `<project>/<session>/__advisor.jsonl`). Any advisor transcript
 * (`__advisor.jsonl` or `__advisor.<slug>.jsonl`) — at any depth, including a
 * subagent's own advisor — counts as `advisor`; every other nested transcript
 * is a task `subagent`.
 */
export function classifyAgentType(sessionPath: string): AgentType {
	const base = path.basename(sessionPath);
	if (base === ADVISOR_TRANSCRIPT_BASENAME || (base.startsWith("__advisor.") && base.endsWith(".jsonl"))) {
		return "advisor";
	}
	const rel = path.relative(getSessionsDir(), sessionPath);
	// `<project>/<file>.jsonl` -> 2 segments. Deeper nesting is a subagent.
	return rel.split(path.sep).length <= 2 ? "main" : "subagent";
}

/**
 * Extract folder name from session filename.
 * Session files are named like: --work--pi--/timestamp_uuid.jsonl
 * The folder part uses -- as path separator.
 */
function extractFolderFromPath(sessionPath: string): string {
	const sessionsDir = getSessionsDir();
	const rel = path.relative(sessionsDir, sessionPath);
	const projectDir = rel.split(path.sep)[0];
	// Convert --work--pi-- to /work/pi
	return projectDir.replace(/^--/, "/").replace(/--/g, "/");
}

/**
 * Check if an entry is an assistant message.
 */
function isAssistantMessage(entry: SessionEntry): entry is SessionMessageEntry {
	if (entry.type !== "message") return false;
	const msgEntry = entry as SessionMessageEntry;
	// Legacy sessions (pre-id tracking) recorded message entries without an `id`.
	// They're not linkable and would violate the messages.entry_id NOT NULL
	// constraint, so skip them at the parser boundary.
	if (typeof msgEntry.id !== "string" || msgEntry.id.length === 0) return false;
	return msgEntry.message?.role === "assistant";
}

/**
 * Check if an entry is a user message (non-toolResult).
 */
function isUserMessage(entry: SessionEntry): entry is SessionMessageEntry {
	if (entry.type !== "message") return false;
	const msgEntry = entry as SessionMessageEntry;
	if (typeof msgEntry.id !== "string" || msgEntry.id.length === 0) return false;
	return msgEntry.message?.role === "user";
}

/**
 * Check if an entry is a service-tier change.
 */
function isServiceTierChange(entry: SessionEntry): entry is SessionServiceTierChangeEntry {
	return entry.type === "service_tier_change";
}

/**
 * Check if an entry is a tool-result message.
 */
function isToolResultMessage(entry: SessionEntry): entry is SessionMessageEntry {
	if (entry.type !== "message") return false;
	return (entry as SessionMessageEntry).message?.role === "toolResult";
}

function isCustomEntry(entry: SessionEntry): entry is SessionCustomEntry {
	return (
		entry.type === "custom" &&
		"id" in entry &&
		typeof entry.id === "string" &&
		"customType" in entry &&
		typeof entry.customType === "string"
	);
}

function parseSessionHeader(entry: SessionEntry): ParsedSessionHeader | undefined {
	if (
		entry.type !== "session" ||
		!("id" in entry) ||
		typeof entry.id !== "string" ||
		!("timestamp" in entry) ||
		typeof entry.timestamp !== "string" ||
		!("cwd" in entry) ||
		typeof entry.cwd !== "string"
	) {
		return undefined;
	}
	return {
		id: entry.id,
		version: "version" in entry && typeof entry.version === "number" ? entry.version : 1,
		timestamp: entry.timestamp,
		cwd: entry.cwd,
		...("title" in entry && typeof entry.title === "string" ? { title: entry.title } : {}),
	};
}

function parseSessionExit(entry: SessionCustomEntry): ParsedSessionExit | undefined {
	if (
		entry.customType !== "session_exit" ||
		typeof entry.data !== "object" ||
		entry.data === null ||
		!("kind" in entry.data) ||
		typeof entry.data.kind !== "string" ||
		!("recordedAt" in entry.data) ||
		typeof entry.data.recordedAt !== "string"
	) {
		return undefined;
	}
	return { kind: entry.data.kind, recordedAt: entry.data.recordedAt, entryId: entry.id };
}

function parseObservabilityEntry(entry: SessionCustomEntry): ParsedObservabilityEntry | undefined {
	if (
		entry.customType !== "observability" ||
		typeof entry.data !== "object" ||
		entry.data === null ||
		Array.isArray(entry.data)
	) {
		return undefined;
	}
	return {
		entryId: entry.id,
		parentId: typeof entry.parentId === "string" ? entry.parentId : null,
		timestamp: entry.timestamp,
		payload: entry.data as Record<string, unknown>,
	};
}

/**
 * WHY A CORE ENTRY BECOMES A TIMELINE FACT.
 *
 * R8 gives a timeline fact four possible owners and the FIRST is "a core JSONL
 * entry". The domain contract is more specific still: tool identity is owned by
 * `tool_execution_start` + `toolResult`, model and thinking changes by "core control
 * entries", the child contract by `session_init`. Only the SECOND owner was ever
 * read - `customType: "observability"`, three lines above - and nothing outside this
 * branch's own runtime writes that customType. Measured: 600 indexed sessions, 0
 * rows in `obs_timeline`, while thirteen richer entry types sat unread in the very
 * files the parser had already opened. Timeline, Behavior and Logs rendered empty
 * against a transcript that recorded every tool, phase, model move and peer message.
 *
 * These projections are deterministic and carry `rule` + `source`, which is what R8
 * asks of an inferred projection. They never mint or infer Run membership:
 * `run_assignment` remains the only path to a Run (ADR 0024, R5), so nothing here
 * ever writes `runId`, and a session with no assignment stays unassigned.
 *
 * SOFT CONTENT STAYS OUT, by construction rather than by review. R27 omits prompts,
 * responses, code, private path segments and ordinary tool payloads from default
 * DTOs. So a projection carries identity and shape - tool name, resolved device,
 * phase names with per-status counts, a peer's name and model, the tokens a
 * compaction folded - and never a body: not `args`, not `intent`, not a peer
 * message's prose, not a todo item's text, not a compaction summary. Those live in
 * the transcript, which is where the reveal path reads them from.
 */
const CORE_PROJECTION_RULE = "core-projection@1";

/**
 * ONE cast, named and confined. A transcript entry is parsed JSON, so it is an
 * untyped record no matter how it is read; asserting the record shape once here and
 * runtime-checking every individual field below beats repeating an inline
 * `as { field?: unknown }` at each of a dozen optional reads - which would fabricate
 * a dozen unverified shapes instead of one honest boundary.
 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

function readString(source: unknown, key: string): string | undefined {
	const value = asRecord(source)?.[key];
	return typeof value === "string" ? value : undefined;
}

function readNumber(source: unknown, key: string): number | undefined {
	const value = asRecord(source)?.[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readArray(source: unknown, key: string): unknown[] | undefined {
	const value = asRecord(source)?.[key];
	return Array.isArray(value) ? value : undefined;
}

/**
 * Every `xd://` device call is recorded under the `write` tool, so a tool list built
 * from tool names alone reports devices as writes. Measured on one session: 6 of 6
 * "write" calls were `xd://browser` and `xd://memory_add`, and none was a file write.
 * The real name is in the call's own `args.path`, so the projection resolves it here
 * rather than leaving every consumer to re-derive it.
 */
function resolveDevice(args: unknown): string | null {
	const target = readString(args, "path");
	const match = target?.match(/^xd:\/\/([a-z0-9_]+)/i);
	return match ? match[1] : null;
}

/**
 * Phase names and per-status counts, never a task's text. That is the whole progress
 * signal - which phases exist and how much of each is done - with no prose in it.
 */
function summarizePhases(data: unknown): Array<Record<string, unknown>> | undefined {
	const phases = readArray(data, "phases");
	if (!phases) return undefined;
	return phases.map(phase => {
		const tasks = readArray(phase, "tasks") ?? [];
		const byStatus: Record<string, number> = {};
		for (const task of tasks) {
			const status = readString(task, "status") ?? "unknown";
			byStatus[status] = (byStatus[status] ?? 0) + 1;
		}
		return { name: readString(phase, "name") ?? null, total: tasks.length, byStatus };
	});
}

function projectCustom(entry: SessionCustomEntry): Record<string, unknown> | undefined {
	switch (entry.customType) {
		case "tool_execution_start": {
			const tool = readString(entry.data, "toolName");
			if (!tool) return undefined;
			return {
				kind: "tool_call",
				source: "core:tool_execution_start",
				tool,
				device: resolveDevice(asRecord(entry.data)?.args),
				toolCallId: readString(entry.data, "toolCallId") ?? null,
			};
		}
		case "user_todo_edit": {
			const phases = summarizePhases(entry.data);
			if (!phases) return undefined;
			return { kind: "progress", source: "core:user_todo_edit", phases };
		}
		case "session_exit":
			return { kind: "session_exit", source: "core:session_exit", exitKind: readString(entry.data, "kind") ?? null };
		default:
			return undefined;
	}
}

function projectCustomMessage(entry: SessionEntry): Record<string, unknown> | undefined {
	const customType = readString(entry, "customType");
	const details = asRecord(entry)?.details;
	switch (customType) {
		case "peer-message":
			// The one place a session records that another session spoke to it. Name,
			// model and whether Orca attributed the sender - never the message body.
			return {
				kind: "peer_message",
				source: "core:custom_message/peer-message",
				peer: readString(details, "peer") ?? null,
				peerModel: readString(details, "model") || null,
				attributed: asRecord(details)?.attributed === true,
				messageId: readString(details, "messageId") ?? null,
			};
		case "async-result": {
			// Shape measured on real transcripts: `{ jobId, type, label, durationMs }`.
			// An unreadable entry is dropped rather than stringified - `String(job)` on an
			// object yields "[object Object]", which is a wrong value dressed as a real one.
			const jobs = readArray(details, "jobs");
			return {
				kind: "child_result",
				source: "core:custom_message/async-result",
				jobs: (jobs ?? [])
					.map(job => readString(job, "jobId") ?? readString(job, "label"))
					.filter(name => name !== undefined),
			};
		}
		case "advisor":
			return { kind: "advisor_message", source: "core:custom_message/advisor" };
		case "skill-prompt": {
			// The harness writes this sentence itself, so the name is structural rather
			// than parsed prose: `the "<name>" skill`.
			const content = readString(entry, "content") ?? "";
			const match = content.match(/the "([a-z0-9-]+)" skill/i);
			return { kind: "skill_prompt", source: "core:custom_message/skill-prompt", skill: match ? match[1] : null };
		}
		default:
			return undefined;
	}
}

function projectCorePayload(entry: SessionEntry): Record<string, unknown> | undefined {
	switch (entry.type) {
		case "model_change":
			// `role` names who moved the model, which is the only record of a route change.
			return {
				kind: "model_change",
				source: "core:model_change",
				model: readString(entry, "model") ?? null,
				role: readString(entry, "role") ?? null,
			};
		case "thinking_level_change":
			return {
				kind: "thinking_level_change",
				source: "core:thinking_level_change",
				thinkingLevel: readString(entry, "thinkingLevel") ?? null,
				configured: readString(entry, "configured") ?? null,
			};
		case "mode_change":
			return { kind: "mode_change", source: "core:mode_change", mode: readString(entry, "mode") ?? null };
		case "compaction":
			return {
				kind: "compaction",
				source: "core:compaction",
				tokensBefore: readNumber(entry, "tokensBefore") ?? null,
				firstKeptEntryId: readString(entry, "firstKeptEntryId") ?? null,
			};
		case "custom_message":
			return projectCustomMessage(entry);
		default:
			return undefined;
	}
}

function projectCoreEntry(
	entry: SessionEntry,
	payload: Record<string, unknown> | undefined,
): ParsedObservabilityEntry | undefined {
	if (!payload) return undefined;
	const entryId = readString(entry, "id");
	const timestamp = readString(entry, "timestamp");
	if (!entryId || !timestamp) return undefined;
	return {
		entryId,
		parentId: readString(entry, "parentId") ?? null,
		timestamp,
		payload: { ...payload, rule: CORE_PROJECTION_RULE },
	};
}

/**
 * Extract plain text from a user message content payload.
 */
function extractUserText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (block && typeof block === "object" && (block as { type?: unknown }).type === "text") {
			const text = (block as { text?: unknown }).text;
			if (typeof text === "string") parts.push(text);
		}
	}
	return parts.join("");
}

/**
 * Build user-message stats from an entry. Returns null for empty/synthetic content.
 */
function extractUserStats(sessionFile: string, folder: string, entry: SessionMessageEntry): UserMessageStats | null {
	const msg = entry.message as { role: "user"; content?: unknown; synthetic?: boolean };
	if (msg.role !== "user" || msg.synthetic) return null;
	const text = extractUserText(msg.content);
	if (!text.trim()) return null;
	const metrics = computeUserMessageMetrics(text);
	const ts = Date.parse(entry.timestamp);
	return {
		sessionFile,
		entryId: entry.id,
		folder,
		timestamp: Number.isFinite(ts) ? ts : 0,
		model: null,
		provider: null,
		chars: metrics.chars,
		words: metrics.words,
		yelling: metrics.yelling,
		profanity: metrics.profanity,
		anguish: metrics.anguish,
		negation: metrics.negation,
		repetition: metrics.repetition,
		blame: metrics.blame,
	};
}

/**
 * Extract stats from an assistant message entry.
 *
 * Session JSONL on disk is not guaranteed to match the current
 * `AssistantMessage` shape: crash-truncated turns, sessions written by older
 * versions, and foreign producers all flow through this parser. Every field
 * returned here feeds a NOT NULL column in stats.db, so malformed entries are
 * coerced (missing `stopReason`, token counts, `timestamp`) or skipped
 * (missing `model`/`provider`/`api`/`usage`) instead of crashing the whole
 * sync with a constraint violation.
 */
function extractStats(
	sessionFile: string,
	folder: string,
	entry: SessionMessageEntry,
	currentServiceTier: ServiceTierByFamily | undefined,
	agentType: AgentType,
): MessageStats | null {
	const msg = entry.message as AssistantMessage;
	if (msg?.role !== "assistant") return null;
	if (typeof msg.model !== "string" || typeof msg.provider !== "string" || typeof msg.api !== "string") return null;
	const rawUsage = msg.usage as Partial<Usage> | undefined;
	if (!rawUsage || typeof rawUsage !== "object") return null;

	// Backfill: when the session recorded `priority` as the active service tier
	// at this point but the AI usage payload was captured before priority
	// requests were folded into `premiumRequests`, derive the count here so the
	// "Premium Reqs" stat aggregates priority traffic on re-sync. Trust any
	// non-zero value already in `usage.premiumRequests` (Copilot multipliers or
	// the new AI code path) and only synthesise when the field is missing/zero.
	const recorded = rawUsage.premiumRequests ?? 0;
	const model = { provider: msg.provider, api: msg.api, id: msg.model };
	const tier = resolveModelServiceTier(currentServiceTier, model);
	const derived = recorded > 0 ? recorded : getPriorityPremiumRequests(tier, model);
	const wellFormed =
		typeof rawUsage.input === "number" &&
		typeof rawUsage.output === "number" &&
		typeof rawUsage.cacheRead === "number" &&
		typeof rawUsage.cacheWrite === "number" &&
		typeof rawUsage.totalTokens === "number";
	const usage: Usage =
		wellFormed && derived === recorded
			? (rawUsage as Usage)
			: {
					...rawUsage,
					input: rawUsage.input ?? 0,
					output: rawUsage.output ?? 0,
					cacheRead: rawUsage.cacheRead ?? 0,
					cacheWrite: rawUsage.cacheWrite ?? 0,
					totalTokens: rawUsage.totalTokens ?? 0,
					cost: rawUsage.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					premiumRequests: derived,
				};

	return {
		sessionFile,
		entryId: entry.id,
		folder,
		model: msg.model,
		provider: msg.provider,
		api: msg.api,
		timestamp: coerceEntryTimestamp(msg.timestamp, entry),
		duration: msg.duration ?? null,
		ttft: msg.ttft ?? null,
		// A message persisted without a terminal stop reason never completed
		// normally: classify by whether it carried an error.
		stopReason: msg.stopReason ?? (msg.errorMessage ? "error" : "aborted"),
		errorMessage: msg.errorMessage ?? null,
		usage,
		agentType,
	};
}

/** Message timestamp, falling back to the entry's ISO timestamp, then 0. */
function coerceEntryTimestamp(timestamp: number | undefined, entry: SessionMessageEntry): number {
	if (typeof timestamp === "number" && Number.isFinite(timestamp)) return timestamp;
	const ts = Date.parse(entry.timestamp);
	return Number.isFinite(ts) ? ts : 0;
}

/**
 * Extract one {@link ToolCallStats} per `toolCall` content block of an
 * assistant message. Returns an empty array for turns without tool calls.
 */
function extractToolCalls(
	sessionFile: string,
	folder: string,
	entry: SessionMessageEntry,
	agentType: AgentType,
): ToolCallStats[] {
	const msg = entry.message as AssistantMessage;
	if (msg?.role !== "assistant" || !Array.isArray(msg.content)) return [];
	// `tool_calls` columns are NOT NULL: skip turns that can't be attributed
	// (malformed persisted entries — see extractStats) and blocks missing ids.
	if (typeof msg.model !== "string" || typeof msg.provider !== "string") return [];

	const blocks = msg.content.filter(
		(block): block is ToolCall =>
			block !== null &&
			typeof block === "object" &&
			block.type === "toolCall" &&
			typeof block.id === "string" &&
			typeof block.name === "string",
	);
	if (blocks.length === 0) return [];

	return blocks.map(block => {
		let argsChars = 0;
		try {
			argsChars = JSON.stringify(block.arguments ?? {}).length;
		} catch {
			// Non-serializable arguments (shouldn't happen in persisted JSONL); size unknown.
		}
		return {
			sessionFile,
			entryId: entry.id,
			toolCallId: block.id,
			folder,
			toolName: block.name,
			model: msg.model,
			provider: msg.provider,
			timestamp: coerceEntryTimestamp(msg.timestamp, entry),
			agentType,
			callsInTurn: blocks.length,
			argsChars,
		};
	});
}

/**
 * Build the result linkage for a `toolResult` entry: text characters fed back
 * into context plus the error flag, keyed to the originating call.
 */
function extractToolResultLink(sessionFile: string, entry: SessionMessageEntry): ToolResultLink | null {
	const msg = entry.message as ToolResultMessage;
	if (msg.role !== "toolResult" || typeof msg.toolCallId !== "string" || msg.toolCallId.length === 0) return null;
	let resultChars = 0;
	if (Array.isArray(msg.content)) {
		for (const block of msg.content) {
			if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
				resultChars += block.text.length;
			}
		}
	}
	return {
		sessionFile,
		toolCallId: msg.toolCallId,
		resultChars,
		isError: msg.isError === true,
	};
}

const LF = 0x0a;
const CR = 0x0d;
const jsonLineDecoder = new TextDecoder();

function parseJsonLine(bytes: Uint8Array, start: number, end: number): SessionEntry | null {
	while (end > start && bytes[end - 1] === CR) end--;
	if (end <= start) return null;
	try {
		return JSON.parse(jsonLineDecoder.decode(bytes.subarray(start, end))) as SessionEntry;
	} catch {
		return null;
	}
}

function visitSessionEntriesLenient(bytes: Uint8Array, visit: (entry: SessionEntry) => void): number {
	let cursor = 0;
	let read = 0;

	while (cursor < bytes.length) {
		const newline = bytes.indexOf(LF, cursor);
		const hasNewline = newline !== -1;
		const lineEnd = hasNewline ? newline : bytes.length;
		const entry = parseJsonLine(bytes, cursor, lineEnd);
		if (entry) {
			visit(entry);
			read = hasNewline ? newline + 1 : lineEnd;
		} else if (hasNewline) {
			read = newline + 1;
		} else {
			break;
		}
		cursor = hasNewline ? newline + 1 : lineEnd;
	}

	return read;
}

function parseSessionEntriesLenient(bytes: Uint8Array): { entries: SessionEntry[]; read: number } {
	const entries: SessionEntry[] = [];
	const read = visitSessionEntriesLenient(bytes, entry => entries.push(entry));
	return { entries, read };
}

function scanLastServiceTier(bytes: Uint8Array): ServiceTierByFamily | undefined {
	let currentServiceTier: ServiceTierByFamily | undefined;
	visitSessionEntriesLenient(bytes, entry => {
		if (isServiceTierChange(entry)) currentServiceTier = coerceServiceTierByFamily(entry.serviceTier);
	});
	return currentServiceTier;
}

function scanSessionMetadata(bytes: Uint8Array): { header?: ParsedSessionHeader; title?: string } {
	let header: ParsedSessionHeader | undefined;
	let title: string | undefined;
	visitSessionEntriesLenient(bytes, entry => {
		const parsedHeader = parseSessionHeader(entry);
		if (parsedHeader) header = parsedHeader;
		if (entry.type === "title" && "title" in entry && typeof entry.title === "string") title = entry.title;
	});
	return { header, title };
}
/**
 * Parse a session file and extract all assistant message stats.
 * Uses incremental reading with offset tracking.
 *
 * Service-tier carry-over: `currentServiceTier` is a session-scoped piece of
 * state derived from `service_tier_change` entries that affects whether
 * subsequent OpenAI assistant replies count as premium requests. Incremental
 * syncs that resume past the most-recent tier change would otherwise lose
 * that state and silently record `premiumRequests = 0` for priority traffic
 * (the coding-agent stopped folding the tier into `usage.premiumRequests`
 * after 13f59162e — the parser is now the sole source of truth). When
 * `fromOffset > 0` we therefore scan the bytes preceding `fromOffset`
 * for the latest service-tier value before parsing the unprocessed tail.
 * The scan only keeps the current tier and does not materialize prefix
 * entries, preserving offset-based memory behavior for large sessions.
 */
export interface ParseSessionResult {
	stats: MessageStats[];
	userStats: UserMessageStats[];
	userLinks: UserMessageLink[];
	toolCalls: ToolCallStats[];
	toolResults: ToolResultLink[];
	header?: ParsedSessionHeader;
	sessionExit?: ParsedSessionExit;
	observability: ParsedObservabilityEntry[];
	newOffset: number;
}
export async function parseSessionFile(sessionPath: string, fromOffset = 0): Promise<ParseSessionResult> {
	let bytes: Uint8Array;
	try {
		bytes = await Bun.file(sessionPath).bytes();
	} catch (err) {
		if (isEnoent(err))
			return {
				stats: [],
				userStats: [],
				userLinks: [],
				toolCalls: [],
				toolResults: [],
				observability: [],
				newOffset: fromOffset,
			};
		throw err;
	}

	const folder = extractFolderFromPath(sessionPath);
	const agentType = classifyAgentType(sessionPath);
	const stats: MessageStats[] = [];
	const userStats: UserMessageStats[] = [];
	const userLinks: UserMessageLink[] = [];
	const toolCalls: ToolCallStats[] = [];
	const toolResults: ToolResultLink[] = [];
	const observability: ParsedObservabilityEntry[] = [];
	let sessionExit: ParsedSessionExit | undefined;
	const metadata = scanSessionMetadata(bytes);
	const header = metadata.header
		? { ...metadata.header, ...(metadata.title !== undefined ? { title: metadata.title } : {}) }
		: undefined;
	const userByEntryId = new Map<string, UserMessageStats>();
	const start = Math.max(0, Math.min(fromOffset, bytes.length));
	const unprocessed = bytes.subarray(start);
	const { entries, read } = parseSessionEntriesLenient(unprocessed);
	let currentServiceTier: ServiceTierByFamily | undefined;
	if (start > 0) {
		currentServiceTier = scanLastServiceTier(bytes.subarray(0, start));
	}
	for (const entry of entries) {
		if (isCustomEntry(entry)) {
			const parsedExit = parseSessionExit(entry);
			if (parsedExit) sessionExit = parsedExit;
			const parsedObservability = parseObservabilityEntry(entry);
			if (parsedObservability) observability.push(parsedObservability);
			// A declared observability fact wins; otherwise the core entry owns itself.
			else {
				const projected = projectCoreEntry(entry, projectCustom(entry));
				if (projected) observability.push(projected);
			}
			continue;
		}
		const projectedCore = projectCoreEntry(entry, projectCorePayload(entry));
		if (projectedCore) {
			observability.push(projectedCore);
			continue;
		}
		if (isServiceTierChange(entry)) {
			currentServiceTier = coerceServiceTierByFamily(entry.serviceTier);
			continue;
		}
		if (isUserMessage(entry)) {
			const userMsg = extractUserStats(sessionPath, folder, entry);
			if (userMsg) {
				userStats.push(userMsg);
				userByEntryId.set(entry.id, userMsg);
			}
			continue;
		}
		if (isToolResultMessage(entry)) {
			const link = extractToolResultLink(sessionPath, entry);
			if (link) toolResults.push(link);
			continue;
		}
		if (isAssistantMessage(entry)) {
			const msgStats = extractStats(sessionPath, folder, entry, currentServiceTier, agentType);
			if (msgStats) stats.push(msgStats);
			toolCalls.push(...extractToolCalls(sessionPath, folder, entry, agentType));
			// Link assistant's responding model back to the user message it answered.
			const parentId = (entry as SessionMessageEntry).parentId;
			if (parentId) {
				const msg = entry.message as AssistantMessage;
				if (msg.model && msg.provider) {
					// Emit unconditionally. The aggregator's UPDATE is guarded by
					// `model IS NULL` so this is idempotent: a no-op for already
					// linked rows, a fix-up for fresh inserts (which start NULL
					// because the user row is recorded before its reply lands) and
					// for cross-pass orphans whose parent was committed by an
					// earlier incremental sync.
					userLinks.push({
						sessionFile: sessionPath,
						entryId: parentId,
						model: msg.model,
						provider: msg.provider,
					});
				}
			}
		}
	}

	return {
		stats,
		userStats,
		userLinks,
		toolCalls,
		toolResults,
		header,
		sessionExit,
		observability,
		newOffset: start + read,
	};
}

/**
 * List all session directories (folders).
 */
export async function listSessionFolders(): Promise<string[]> {
	try {
		const sessionsDir = getSessionsDir();
		const entries = await fs.readdir(sessionsDir, { withFileTypes: true });
		return entries.filter(e => e.isDirectory()).map(e => path.join(sessionsDir, e.name));
	} catch {
		return [];
	}
}

/**
 * List all session files in a folder.
 */
export async function listSessionFiles(folderPath: string): Promise<string[]> {
	try {
		const entries = await fs.readdir(folderPath, { recursive: true, withFileTypes: true });
		return entries.filter(e => e.isFile() && e.name.endsWith(".jsonl")).map(e => path.join(e.parentPath, e.name));
	} catch {
		return [];
	}
}

/**
 * List all session files across all folders.
 */
export async function listAllSessionFiles(): Promise<string[]> {
	const folders = await listSessionFolders();
	const allFiles: string[] = [];

	for (const folder of folders) {
		const files = await listSessionFiles(folder);
		allFiles.push(...files);
	}

	return allFiles;
}

/**
 * Find a specific entry in a session file.
 */
export async function getSessionEntry(sessionPath: string, entryId: string): Promise<SessionEntry | null> {
	try {
		for await (const line of readLines(Bun.file(sessionPath).stream())) {
			const entry = parseJsonLine(line, 0, line.length);
			if (entry && "id" in entry && entry.id === entryId) {
				return entry;
			}
		}
	} catch (err) {
		if (isEnoent(err)) return null;
		throw err;
	}
	return null;
}
