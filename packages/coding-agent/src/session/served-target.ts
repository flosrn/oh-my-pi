import type { ServedTarget } from "@oh-my-pi/pi-tui/overlays/agent-hub-types";

/** The `upstream*` fields an assistant message may carry, as persisted or live. */
interface UpstreamFields {
	upstreamProvider?: unknown;
	upstreamModel?: unknown;
	upstreamAccount?: unknown;
	upstreamFallbackAttempts?: unknown;
}

function buildServedTarget(
	provider: unknown,
	model: unknown,
	account: unknown,
	fallbackAttempts: unknown,
): ServedTarget | undefined {
	let served: ServedTarget | undefined;
	if (typeof provider === "string" && provider) (served ??= {}).provider = provider;
	if (typeof model === "string" && model) (served ??= {}).model = model;
	if (typeof account === "string" && account) (served ??= {}).account = account;
	if (typeof fallbackAttempts === "number" && Number.isInteger(fallbackAttempts) && fallbackAttempts >= 0) {
		(served ??= {}).fallbackAttempts = fallbackAttempts;
	}
	return served;
}

/**
 * Served target an assistant message reports, or `undefined` when it carries
 * no `upstream*` field — a natively served turn has none, so taking this from
 * each settled turn clears a previous turn's target instead of leaving it stale.
 * Accepts raw persisted records, so every field is type-checked.
 */
export function servedTargetFromMessage(message: UpstreamFields): ServedTarget | undefined {
	return buildServedTarget(
		message.upstreamProvider,
		message.upstreamModel,
		message.upstreamAccount,
		message.upstreamFallbackAttempts,
	);
}

/** Reads a served target back from untyped progress details. */
export function parseServedTarget(value: unknown): ServedTarget | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	return buildServedTarget(record.provider, record.model, record.account, record.fallbackAttempts);
}
