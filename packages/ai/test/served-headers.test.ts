/**
 * A router that serves a request from a different target than the one asked
 * for can name that target in response headers. A provider opts in with
 * `servedHeaders`; each assistant message then carries the served provider,
 * model, account and failed-attempt count of the response that produced it,
 * never those of an earlier attempt.
 */
import { describe, expect, it } from "bun:test";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import type { AssistantMessage, Context, FetchImpl, Model, ServedHeaders } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";

const SERVED_HEADERS: ServedHeaders = {
	model: "x-served-model",
	provider: "x-served-provider",
	account: "x-served-account",
	fallbackAttempts: "x-served-attempts-failed",
};

const ALL_HEADERS: Record<string, string> = {
	"x-served-model": "claude-opus-5",
	"x-served-provider": "cc",
	"x-served-account": "alice@example.com",
	"x-served-attempts-failed": "2",
};

// Captured from OpenRouter → "Claude Platform on AWS" for anthropic/claude-opus-5;
// its cleartext header names `claude-opus-5`.
const OPUS_5_SIGNATURE =
	"CAISnAIKrgEIERgCKkBun5aw4pp8OwMcmPih8WPkWUcibrzQ8Jg5AooTtYTxb4OGtHksxfgAiCJWYNO0xqC4zVwgAFZ0nU0+5/QoKQStMg1jbGF1ZGUtb3B1cy01OAFCCHRoaW5raW5nWiQ0YzBmMDQ2Zi0yNWZkLTQ1ZmItYmZiMy1hMDhhOGUyNDljYTd6HnVwcm9mXzAxMUNlUVRqY1ZkV2lES1F4d0Zlc3BldqgBndWi1QYSDDfLtFY9SutE7G2OLhoMvcDeJZgBIoqoYb4IIjBvpyKZu6JlaYZEy4cKXscU+OxzGZkpQapVraxYNEwKypi+Dbvz9FD2bO0yHjFhi5kqGwmcLJKipAse80nNfJfANbVYCqh6yW6HgnkXAxgB";

const context: Context = {
	messages: [{ role: "user", content: "Say hi", timestamp: 0 }],
};

function anthropicModel(servedHeaders?: ServedHeaders): Model<"anthropic-messages"> {
	return buildModel({
		id: "claude-sonnet-5",
		name: "Router Sonnet",
		api: "anthropic-messages",
		provider: "router",
		baseUrl: "https://router.example.test",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_192,
		...(servedHeaders ? { servedHeaders } : {}),
	});
}

function completionsModel(servedHeaders?: ServedHeaders): Model<"openai-completions"> {
	return buildModel({
		id: "pool",
		name: "Router Pool",
		api: "openai-completions",
		provider: "router-oai",
		baseUrl: "https://router.example.test/v1",
		reasoning: true,
		compat: { thinkingFormat: "openai", supportsReasoningParams: true, supportsReasoningEffort: true },
		thinking: { mode: "effort", efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh] },
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
		...(servedHeaders ? { servedHeaders } : {}),
	});
}

function responsesModel(servedHeaders?: ServedHeaders): Model<"openai-responses"> {
	return buildModel({
		id: "pool",
		name: "Router Pool",
		api: "openai-responses",
		provider: "router-oai",
		baseUrl: "https://router.example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
		...(servedHeaders ? { servedHeaders } : {}),
	});
}

function sse(events: Record<string, unknown>[], named: boolean): string {
	return events
		.map(event =>
			named ? `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n` : `data: ${JSON.stringify(event)}\n\n`,
		)
		.join("");
}

function sseResponse(body: string, headers: Record<string, string>): Response {
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream", ...headers } });
}

function anthropicEvents(text: string, signature?: string): Record<string, unknown>[] {
	const usage = { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
	const thinking = signature
		? [
				{ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
				{ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } },
				{ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature } },
				{ type: "content_block_stop", index: 0 },
			]
		: [];
	const textIndex = signature ? 1 : 0;
	return [
		{ type: "message_start", message: { id: "msg_1", model: "claude-sonnet-5", usage } },
		...thinking,
		{ type: "content_block_start", index: textIndex, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: textIndex, delta: { type: "text_delta", text } },
		{ type: "content_block_stop", index: textIndex },
		{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { ...usage, output_tokens: 4 } },
		{ type: "message_stop" },
	];
}

function anthropicResponse(headers: Record<string, string>, signature?: string): Response {
	return sseResponse(sse(anthropicEvents("hi", signature), true), headers);
}

function sequenceFetch(responses: (() => Response)[]): { fetch: FetchImpl; calls: () => number } {
	let count = 0;
	const fetch: FetchImpl = async () => {
		const next = responses[Math.min(count, responses.length - 1)];
		count += 1;
		return next();
	};
	return { fetch, calls: () => count };
}

function completionsResponse(headers: Record<string, string>, provider?: string): Response {
	const base = {
		id: "gen-1",
		object: "chat.completion.chunk",
		created: 0,
		model: "pool",
		...(provider ? { provider } : {}),
	};
	const body = `${sse(
		[
			{ ...base, choices: [{ index: 0, delta: { content: "hi" } }] },
			{
				...base,
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
			},
		],
		false,
	)}data: [DONE]\n\n`;
	return sseResponse(body, headers);
}

function responsesEvents(): Record<string, unknown>[] {
	return [
		{ type: "response.created", response: { id: "resp_1" } },
		{
			type: "response.output_item.added",
			item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
		},
		{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
		{ type: "response.output_text.delta", delta: "hi" },
		{
			type: "response.output_item.done",
			item: {
				type: "message",
				id: "msg_1",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: "hi" }],
			},
		},
		{
			type: "response.completed",
			response: {
				id: "resp_1",
				status: "completed",
				usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7, input_tokens_details: { cached_tokens: 0 } },
			},
		},
	];
}

function served(message: AssistantMessage) {
	return {
		upstreamModel: message.upstreamModel,
		upstreamProvider: message.upstreamProvider,
		upstreamAccount: message.upstreamAccount,
		upstreamFallbackAttempts: message.upstreamFallbackAttempts,
	};
}

const NONE = {
	upstreamModel: undefined,
	upstreamProvider: undefined,
	upstreamAccount: undefined,
	upstreamFallbackAttempts: undefined,
};

const noWait = async () => {};

describe("served headers on anthropic-messages", () => {
	it("records every declared header on the assistant message", async () => {
		const { fetch } = sequenceFetch([() => anthropicResponse(ALL_HEADERS)]);
		const result = await streamAnthropic(anthropicModel(SERVED_HEADERS), context, {
			apiKey: "sk-test",
			fetch,
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(result.model).toBe("claude-sonnet-5");
		expect(served(result)).toEqual({
			upstreamModel: "claude-opus-5",
			upstreamProvider: "cc",
			upstreamAccount: "alice@example.com",
			upstreamFallbackAttempts: 2,
		});
	});

	it("prefers the declared model header over the model named by a signed thinking block", async () => {
		const { fetch } = sequenceFetch([
			() => anthropicResponse({ ...ALL_HEADERS, "x-served-model": "claude-haiku-5" }, OPUS_5_SIGNATURE),
		]);
		const result = await streamAnthropic(anthropicModel(SERVED_HEADERS), context, {
			apiKey: "sk-test",
			fetch,
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(result.upstreamModel).toBe("claude-haiku-5");
	});

	it("drops every served field of an attempt that a retry replaced", async () => {
		const failedAttempt = () =>
			sseResponse(
				sse(
					[
						{
							type: "message_start",
							message: { id: "msg_0", model: "claude-sonnet-5", usage: { input_tokens: 1, output_tokens: 0 } },
						},
						{ type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
					],
					true,
				),
				ALL_HEADERS,
			);
		const { fetch, calls } = sequenceFetch([failedAttempt, () => anthropicResponse({})]);
		const result = await streamAnthropic(anthropicModel(SERVED_HEADERS), context, {
			apiKey: "sk-test",
			fetch,
			providerRetryWait: noWait,
		}).result();

		expect(calls()).toBe(2);
		expect(result.stopReason).toBe("stop");
		expect(served(result)).toEqual(NONE);
	});

	it("ignores the headers when the provider declares none", async () => {
		const { fetch } = sequenceFetch([() => anthropicResponse(ALL_HEADERS)]);
		const result = await streamAnthropic(anthropicModel(), context, { apiKey: "sk-test", fetch }).result();

		expect(result.stopReason).toBe("stop");
		expect(served(result)).toEqual(NONE);
	});

	it("leaves only the field whose header is missing unset", async () => {
		const { "x-served-account": _account, ...withoutAccount } = ALL_HEADERS;
		const { fetch } = sequenceFetch([() => anthropicResponse(withoutAccount)]);
		const result = await streamAnthropic(anthropicModel(SERVED_HEADERS), context, {
			apiKey: "sk-test",
			fetch,
		}).result();

		expect(served(result)).toEqual({
			upstreamModel: "claude-opus-5",
			upstreamProvider: "cc",
			upstreamAccount: undefined,
			upstreamFallbackAttempts: 2,
		});
	});

	it("strips control sequences and caps oversized values", async () => {
		const { fetch } = sequenceFetch([
			() =>
				anthropicResponse({
					...ALL_HEADERS,
					"x-served-account": "\x1b]52;c;ZXZpbA==\x07alice@example.com",
					"x-served-model": `claude  opus\t${"x".repeat(10_240)}`,
				}),
		]);
		const result = await streamAnthropic(anthropicModel(SERVED_HEADERS), context, {
			apiKey: "sk-test",
			fetch,
		}).result();

		expect(result.upstreamAccount).toBe("alice@example.com");
		expect(result.upstreamModel).toHaveLength(256);
		expect(result.upstreamModel?.startsWith("claude opus x")).toBe(true);
	});

	it.each(["abc", "-1", "1.5", ""])("drops a non-numeric or negative attempt count %p", async count => {
		const { fetch } = sequenceFetch([() => anthropicResponse({ ...ALL_HEADERS, "x-served-attempts-failed": count })]);
		const result = await streamAnthropic(anthropicModel(SERVED_HEADERS), context, {
			apiKey: "sk-test",
			fetch,
		}).result();

		expect(result.upstreamFallbackAttempts).toBeUndefined();
		expect(result.upstreamAccount).toBe("alice@example.com");
	});
});

describe("served headers on openai-completions", () => {
	it("records the declared headers and keeps them over an aggregator chunk provider", async () => {
		const { fetch } = sequenceFetch([() => completionsResponse(ALL_HEADERS, "Anthropic")]);
		const result = await streamOpenAICompletions(completionsModel(SERVED_HEADERS), context, {
			apiKey: "test-key",
			fetch,
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(served(result)).toEqual({
			upstreamModel: "claude-opus-5",
			upstreamProvider: "cc",
			upstreamAccount: "alice@example.com",
			upstreamFallbackAttempts: 2,
		});
	});

	it("keeps no account from a rejected response when the re-request lacks the header", async () => {
		const rejected = () =>
			new Response(
				JSON.stringify({
					error: {
						message: `invalid reasoning value: 'xhigh' (must be "high", "medium", "low", "max", or "none")`,
						type: "invalid_request_error",
						param: "reasoning_effort",
					},
				}),
				{ status: 400, headers: { "content-type": "application/json", ...ALL_HEADERS } },
			);
		const { "x-served-account": _account, ...withoutAccount } = ALL_HEADERS;
		const { fetch, calls } = sequenceFetch([rejected, () => completionsResponse(withoutAccount)]);
		const result = await streamOpenAICompletions(completionsModel(SERVED_HEADERS), context, {
			apiKey: "test-key",
			fetch,
			reasoning: "xhigh",
		}).result();

		expect(calls()).toBe(2);
		expect(result.stopReason).toBe("stop");
		expect(result.upstreamAccount).toBeUndefined();
		expect(result.upstreamModel).toBe("claude-opus-5");
	});

	it("still takes the aggregator chunk provider when the provider declares no headers", async () => {
		const { fetch } = sequenceFetch([() => completionsResponse(ALL_HEADERS, "Anthropic")]);
		const result = await streamOpenAICompletions(completionsModel(), context, { apiKey: "test-key", fetch }).result();

		expect(served(result)).toEqual({ ...NONE, upstreamProvider: "Anthropic" });
	});
});

describe("served headers on openai-responses", () => {
	it("records the declared headers", async () => {
		const { fetch } = sequenceFetch([() => sseResponse(sse(responsesEvents(), false), ALL_HEADERS)]);
		const result = await streamOpenAIResponses(responsesModel(SERVED_HEADERS), context, {
			apiKey: "test-key",
			fetch,
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(served(result)).toEqual({
			upstreamModel: "claude-opus-5",
			upstreamProvider: "cc",
			upstreamAccount: "alice@example.com",
			upstreamFallbackAttempts: 2,
		});
	});

	it("drops every served field of an attempt that a retry replaced", async () => {
		const truncated = () =>
			sseResponse(sse([{ type: "response.created", response: { id: "resp_0" } }], false), ALL_HEADERS);
		const { fetch, calls } = sequenceFetch([truncated, () => sseResponse(sse(responsesEvents(), false), {})]);
		const result = await streamOpenAIResponses(responsesModel(SERVED_HEADERS), context, {
			apiKey: "test-key",
			fetch,
			providerRetryWait: noWait,
		}).result();

		expect(calls()).toBe(2);
		expect(result.stopReason).toBe("stop");
		expect(served(result)).toEqual(NONE);
	});
});
