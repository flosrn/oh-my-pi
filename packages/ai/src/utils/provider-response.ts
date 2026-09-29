import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { Api, AssistantMessage, Model, ProviderResponseMetadata, StreamOptions } from "../types";

/** Longest served-target value kept; a header is untrusted and lands in the TUI. */
const SERVED_VALUE_MAX_CHARS = 256;

export function normalizeProviderResponse(
	response: Response,
	requestId?: string | null,
	metadata?: Record<string, unknown>,
): ProviderResponseMetadata {
	const headers: Record<string, string> = {};
	response.headers.forEach((value, key) => {
		headers[key.toLowerCase()] = value;
	});
	const providerResponse: ProviderResponseMetadata = {
		status: response.status,
		headers,
	};
	if (requestId !== undefined) providerResponse.requestId = requestId;
	if (metadata !== undefined) providerResponse.metadata = metadata;
	return providerResponse;
}

export async function notifyProviderResponse(
	options: Pick<StreamOptions, "onResponse"> | undefined,
	response: Response,
	model?: Model<Api>,
	requestId?: string | null,
	metadata?: Record<string, unknown>,
): Promise<void> {
	if (!options?.onResponse) return;
	await options.onResponse(normalizeProviderResponse(response, requestId, metadata), model);
}

function readServedHeader(headers: Headers, name: string | undefined): string | undefined {
	if (!name) return undefined;
	let raw: string | null;
	try {
		raw = headers.get(name);
	} catch {
		// An invalid header name (e.g. from a runtime-registered provider) must not fail the turn.
		return undefined;
	}
	if (raw === null) return undefined;
	const text = sanitizeText(raw).replace(/\s+/g, " ").trim();
	if (text.length === 0) return undefined;
	if (text.length <= SERVED_VALUE_MAX_CHARS) return text;
	// Cut on a code-point boundary so the cap never leaves a lone surrogate.
	const boundaryUnit = text.charCodeAt(SERVED_VALUE_MAX_CHARS - 1);
	const isHighSurrogate = boundaryUnit >= 0xd800 && boundaryUnit <= 0xdbff;
	return text.slice(0, isHighSurrogate ? SERVED_VALUE_MAX_CHARS - 1 : SERVED_VALUE_MAX_CHARS);
}

/** Forget the served target of an attempt a retry is about to replace. */
export function clearServedTarget(output: AssistantMessage): void {
	output.upstreamModel = undefined;
	output.upstreamProvider = undefined;
	output.upstreamAccount = undefined;
	output.upstreamFallbackAttempts = undefined;
}

/**
 * Record the served target a router reports in the response headers the
 * model's provider declares via `servedHeaders`. Runs once per response, so
 * every re-request replaces the previous response's values instead of
 * inheriting them; a header value also wins over any later inference, which
 * only fills fields left unset. Providers without the declaration are left
 * untouched.
 */
export function captureServedTarget(output: AssistantMessage, response: Response, model: Model<Api>): void {
	const declared = model.servedHeaders;
	if (!declared) return;
	const { headers } = response;
	output.upstreamModel = readServedHeader(headers, declared.model);
	output.upstreamProvider = readServedHeader(headers, declared.provider);
	output.upstreamAccount = readServedHeader(headers, declared.account);
	// A count is a non-negative integer; anything else is dropped, never guessed.
	const attempts = readServedHeader(headers, declared.fallbackAttempts);
	const count = attempts !== undefined && /^\d+$/.test(attempts) ? Number(attempts) : undefined;
	output.upstreamFallbackAttempts = count !== undefined && Number.isSafeInteger(count) ? count : undefined;
}
