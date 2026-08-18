import type {
	ObservabilityPage,
	ObservabilityRequest,
	RunDetail,
	RunSummary,
	SessionDetail,
	SessionSummary,
	SessionUsageSummary,
	TimelineItem,
	ToolUsageStats,
} from "../shared-types";
import type {
	BehaviorDashboardStats,
	CostDashboardStats,
	FolderStats,
	GainDashboardStats,
	MessageStats,
	ModelDashboardStats,
	OverviewStats,
	ProviderDashboardStats,
	RequestDetails,
	TimeRange,
	ToolDashboardStats,
} from "./types";

const API_BASE = "/api";

export class ApiError extends Error {
	status: number;
	endpoint: string;

	constructor(status: number, endpoint: string, message: string) {
		super(message);
		this.name = "ApiError";
		this.status = status;
		this.endpoint = endpoint;
	}
}

async function fetchJson<T>(endpoint: string, options?: RequestInit): Promise<T> {
	const res = await fetch(endpoint, options);
	if (!res.ok) {
		throw new ApiError(res.status, endpoint, `HTTP error ${res.status} on ${endpoint}`);
	}
	return res.json() as Promise<T>;
}

export async function getOverviewStats(range: TimeRange = "24h", signal?: AbortSignal): Promise<OverviewStats> {
	return fetchJson<OverviewStats>(`${API_BASE}/stats/overview?range=${encodeURIComponent(range)}`, {
		signal,
	});
}

export async function getModelDashboardStats(
	range: TimeRange = "24h",
	signal?: AbortSignal,
): Promise<ModelDashboardStats> {
	return fetchJson<ModelDashboardStats>(`${API_BASE}/stats/model-dashboard?range=${encodeURIComponent(range)}`, {
		signal,
	});
}

export async function getCostDashboardStats(
	range: TimeRange = "24h",
	signal?: AbortSignal,
): Promise<CostDashboardStats> {
	return fetchJson<CostDashboardStats>(`${API_BASE}/stats/costs?range=${encodeURIComponent(range)}`, { signal });
}

export async function getRecentRequests(limit = 50, signal?: AbortSignal): Promise<MessageStats[]> {
	return fetchJson<MessageStats[]>(`${API_BASE}/stats/recent?limit=${limit}`, { signal });
}

export async function getRecentErrors(
	range: TimeRange = "24h",
	limit = 50,
	signal?: AbortSignal,
): Promise<MessageStats[]> {
	return fetchJson<MessageStats[]>(`${API_BASE}/stats/errors?range=${encodeURIComponent(range)}&limit=${limit}`, {
		signal,
	});
}

export async function getRequestDetails(id: number, signal?: AbortSignal): Promise<RequestDetails> {
	return fetchJson<RequestDetails>(`${API_BASE}/request/${id}`, { signal });
}

export async function sync(signal?: AbortSignal): Promise<{ processed: number; files: number; totalMessages: number }> {
	return fetchJson<{ processed: number; files: number; totalMessages: number }>(`${API_BASE}/sync`, {
		signal,
		method: "POST",
	});
}

export async function getBehaviorDashboardStats(
	range: TimeRange = "24h",
	signal?: AbortSignal,
): Promise<BehaviorDashboardStats> {
	return fetchJson<BehaviorDashboardStats>(`${API_BASE}/stats/behavior?range=${encodeURIComponent(range)}`, {
		signal,
	});
}

export async function getFolderStats(range: TimeRange = "24h", signal?: AbortSignal): Promise<FolderStats[]> {
	return fetchJson<FolderStats[]>(`${API_BASE}/stats/folders?range=${encodeURIComponent(range)}`, { signal });
}

export async function getGainDashboardStats(
	range: TimeRange = "24h",
	project?: string | null,
	signal?: AbortSignal,
): Promise<GainDashboardStats> {
	const params = new URLSearchParams({ range });
	if (project) params.set("project", project);
	return fetchJson<GainDashboardStats>(`${API_BASE}/stats/gain?${params}`, { signal });
}

export async function getToolDashboardStats(
	range: TimeRange = "24h",
	signal?: AbortSignal,
): Promise<ToolDashboardStats> {
	return fetchJson<ToolDashboardStats>(`${API_BASE}/stats/tools?range=${encodeURIComponent(range)}`, { signal });
}

export async function getProviderDashboardStats(
	range: TimeRange = "24h",
	signal?: AbortSignal,
): Promise<ProviderDashboardStats> {
	return fetchJson<ProviderDashboardStats>(`${API_BASE}/stats/providers?range=${encodeURIComponent(range)}`, {
		signal,
	});
}

export interface ObservabilityListFilters {
	range?: TimeRange;
	status?: string | null;
	project?: string | null;
	failure?: boolean;
	q?: string | null;
	after?: string | null;
	limit?: number;
}

function observabilityListParams(filters: ObservabilityListFilters): URLSearchParams {
	const params = new URLSearchParams();
	if (filters.range) params.set("range", filters.range);
	if (filters.status) params.set("status", filters.status);
	if (filters.project) params.set("project", filters.project);
	if (filters.failure) params.set("failure", "true");
	if (filters.q) params.set("q", filters.q);
	if (filters.after) params.set("after", filters.after);
	if (filters.limit) params.set("limit", String(filters.limit));
	return params;
}

export async function getSessions(
	filters: ObservabilityListFilters,
	signal?: AbortSignal,
): Promise<ObservabilityPage<SessionSummary>> {
	return fetchJson(`${API_BASE}/sessions?${observabilityListParams(filters)}`, { signal });
}

export async function getSession(id: string, signal?: AbortSignal): Promise<SessionDetail> {
	return fetchJson(`${API_BASE}/sessions/${encodeURIComponent(id)}`, { signal });
}

export async function getRuns(
	filters: ObservabilityListFilters,
	signal?: AbortSignal,
): Promise<ObservabilityPage<RunSummary>> {
	return fetchJson(`${API_BASE}/runs?${observabilityListParams(filters)}`, { signal });
}

export async function getRun(id: string, signal?: AbortSignal): Promise<RunDetail> {
	return fetchJson(`${API_BASE}/runs/${encodeURIComponent(id)}`, { signal });
}

export async function getObservabilityTimeline(
	kind: "sessions" | "runs",
	id: string,
	after?: string | null,
	signal?: AbortSignal,
): Promise<ObservabilityPage<TimelineItem>> {
	const params = new URLSearchParams({ limit: "100" });
	if (after) params.set("after", after);
	return fetchJson(`${API_BASE}/${kind}/${encodeURIComponent(id)}/timeline?${params}`, { signal });
}

export async function revealObservabilityFields(
	kind: "sessions" | "runs",
	id: string,
	fields: string[],
	signal?: AbortSignal,
): Promise<unknown> {
	return fetchJson(`${API_BASE}/${kind}/${encodeURIComponent(id)}/reveal`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ fields }),
		signal,
	});
}

export async function getResourceRequests(
	kind: "sessions" | "runs",
	id: string,
	options: { errorsOnly?: boolean; limit?: number } = {},
	signal?: AbortSignal,
): Promise<ObservabilityPage<ObservabilityRequest>> {
	const params = new URLSearchParams({ limit: String(options.limit ?? 100) });
	if (options.errorsOnly) params.set("errors", "true");
	return fetchJson(`${API_BASE}/${kind}/${encodeURIComponent(id)}/requests?${params}`, { signal });
}

export async function getResourceTools(
	kind: "sessions" | "runs",
	id: string,
	signal?: AbortSignal,
): Promise<ObservabilityPage<ToolUsageStats> & { usage: SessionUsageSummary }> {
	return fetchJson(`${API_BASE}/${kind}/${encodeURIComponent(id)}/tools`, { signal });
}

export async function getResourceUsage(
	kind: "sessions" | "runs",
	id: string,
	signal?: AbortSignal,
): Promise<SessionUsageSummary> {
	return fetchJson(`${API_BASE}/${kind}/${encodeURIComponent(id)}/usage`, { signal });
}

export type ModelsAdminScope = "mac" | "vps" | "both";

export interface ModelsAdminChange {
	kind:
		| "role"
		| "fallback"
		| "agentOverride"
		| "agentFrontmatter"
		| "watchdog"
		| "hermesModel"
		| "hermesThinking"
		| "hostPin";
	id: string;
	value: string | string[] | null;
	hostOnly?: boolean;
}

export interface ModelsAdminSnapshot {
	root: string;
	kind: "home" | "checkout" | "override" | "missing";
	present: boolean;
	git: boolean;
	syncScript: boolean;
	warnings: string[];
	catalog: string[];
	roles: Array<{ id: string; label: string; value: string | string[]; source: string; hostOnly: boolean }>;
	fallbacks: Array<{ id: string; label: string; value: string | string[]; source: string; hostOnly: boolean }>;
	agents: Array<{
		id: string;
		group: string;
		value: string | string[] | null;
		source: string;
		hasModelField: boolean;
		hostOnly: boolean;
	}>;
	watchdog: Array<{ id: string; name: string; value: string; source: string }>;
	hermes: {
		llmModelOverride: string | null;
		llmThinkingOverride: string | null;
		source: string;
		present: boolean;
	};
	hosts: { mac: boolean; vps: boolean };
}

export interface ModelsAdminPreview {
	scope: ModelsAdminScope;
	diffs: Array<{ path: string; diff: string }>;
	files: string[];
	warnings: string[];
	effect: string;
}

export interface ModelsAdminApplyResult extends ModelsAdminPreview {
	applied: boolean;
	git?: { ok: boolean; output: string };
	sync?: { ok: boolean; output: string };
	message: string;
}

export async function getModelsAdmin(signal?: AbortSignal): Promise<ModelsAdminSnapshot> {
	return fetchJson<ModelsAdminSnapshot>(`${API_BASE}/models-admin`, { signal });
}

export async function previewModelsAdmin(
	body: { scope: ModelsAdminScope; commitMessage: string; changes: ModelsAdminChange[] },
	signal?: AbortSignal,
): Promise<ModelsAdminPreview> {
	return fetchJson<ModelsAdminPreview>(`${API_BASE}/models-admin/preview`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
		signal,
	});
}

export async function applyModelsAdmin(
	body: { scope: ModelsAdminScope; commitMessage: string; changes: ModelsAdminChange[] },
	signal?: AbortSignal,
): Promise<ModelsAdminApplyResult> {
	return fetchJson<ModelsAdminApplyResult>(`${API_BASE}/models-admin/apply`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
		signal,
	});
}
