export type ApplyScope = "mac" | "vps" | "both";

export type AssignmentKind =
	| "role"
	| "fallback"
	| "agentOverride"
	| "agentFrontmatter"
	| "watchdog"
	| "hermesModel"
	| "hermesThinking"
	| "hostPin";

export type ModelValue = string | string[] | null;

export interface ModelChange {
	kind: AssignmentKind;
	id: string;
	value: ModelValue;
	/** Host-only pins never land in shared config.yml. */
	hostOnly?: boolean;
}

export interface RoleAssignment {
	id: string;
	label: string;
	value: string | string[];
	source: string;
	hostOnly: boolean;
}

export interface AgentAssignment {
	id: string;
	group: string;
	value: ModelValue;
	source: string;
	hasModelField: boolean;
	hostOnly: boolean;
}

export interface WatchdogAssignment {
	id: string;
	name: string;
	value: string;
	source: string;
}

export interface HermesAssignment {
	llmModelOverride: string | null;
	llmThinkingOverride: string | null;
	source: string;
	present: boolean;
}

export interface ModelsAdminSnapshot {
	root: string;
	kind: "home" | "checkout" | "override" | "missing";
	present: boolean;
	git: boolean;
	syncScript: boolean;
	warnings: string[];
	catalog: string[];
	roles: RoleAssignment[];
	fallbacks: RoleAssignment[];
	agents: AgentAssignment[];
	watchdog: WatchdogAssignment[];
	hermes: HermesAssignment;
	hosts: { mac: boolean; vps: boolean };
}

export interface FileDiff {
	path: string;
	diff: string;
}

export interface PreviewResult {
	scope: ApplyScope;
	diffs: FileDiff[];
	files: string[];
	warnings: string[];
	effect: string;
}

export interface ApplyResult extends PreviewResult {
	applied: boolean;
	git?: { ok: boolean; output: string };
	sync?: { ok: boolean; output: string };
	message: string;
}

export const APPLY_EFFECT =
	"Roles and advisor take effect on a new session. Agent pins take effect on the next task spawn.";
