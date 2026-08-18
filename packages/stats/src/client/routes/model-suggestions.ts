const OPUS_HIGH = "anthropic/claude-opus-5:high";
const OPUS_MEDIUM = "anthropic/claude-opus-5:medium";
const OPUS_XHIGH = "anthropic/claude-opus-5:xhigh";
const FABLE_XHIGH = "anthropic/claude-fable-5:xhigh";
const SONNET = "anthropic/claude-sonnet-5";
const SONNET_HIGH = "anthropic/claude-sonnet-5:high";
const DS = "alibaba-token-plan/deepseek-v4-flash-0731";
const DS_HIGH = `${DS}:high`;
const DS_MAX = `${DS}:max`;
const QWEN = "alibaba-token-plan/qwen3.8-max";
const GROK = "xai-oauth/grok-4.6";
const GROK_TINY = "xai-oauth/grok-4.20-0309-non-reasoning";
const COMPOSER = "xai-oauth/grok-composer-2.5-fast";
const SOL_HIGH = "openai-codex/gpt-5.6-sol:high";
const SOL_MEDIUM = "openai-codex/gpt-5.6-sol:medium";
const SOL_XHIGH = "openai-codex/gpt-5.6-sol:xhigh";
const TERRA = "openai-codex/gpt-5.6-terra";
const TERRA_HIGH = "openai-codex/gpt-5.6-terra:high";
const CURSOR_SONNET = "cursor/claude-sonnet-5-high";
const CURSOR_GROK = "cursor/cursor-grok-4.6-high-fast";

export const HERMES_THINKING = ["low", "medium", "high"];
export const HERMES_MODELS = [DS, DS_HIGH, DS_MAX];

const ROLE_SUGGESTIONS: Record<string, string[]> = {
	default: [OPUS_HIGH, OPUS_MEDIUM, GROK, SOL_HIGH],
	fast: [DS_MAX, DS_HIGH, SONNET, TERRA],
	smol: [SONNET_HIGH, SONNET, GROK, DS_MAX],
	tiny: [GROK_TINY, COMPOSER, TERRA],
	task: [OPUS_MEDIUM, OPUS_HIGH, GROK, SOL_MEDIUM],
	slow: [FABLE_XHIGH, OPUS_XHIGH, SOL_XHIGH, GROK],
	plan: [OPUS_XHIGH, OPUS_HIGH, SOL_HIGH, GROK],
	codex: [SOL_HIGH, SOL_MEDIUM, SOL_XHIGH, TERRA_HIGH],
	qwen: [QWEN, DS_MAX, GROK, SONNET],
	commit: [COMPOSER, TERRA, SONNET, GROK_TINY],
	designer: [OPUS_HIGH, CURSOR_SONNET, SOL_HIGH, GROK],
	advisor: [DS_HIGH, DS_MAX, DS],
	grok: [GROK, COMPOSER, GROK_TINY],
	cursor: [CURSOR_GROK, CURSOR_SONNET],
	deepseek: [DS_MAX, DS_HIGH, DS],
};

const AGENT_SUGGESTIONS: Record<string, string[]> = {
	scout: ["@smol", SONNET_HIGH, GROK],
	oracle: [SOL_HIGH, OPUS_HIGH, GROK],
	"lfg-babysit": [GROK, OPUS_MEDIUM, SOL_MEDIUM],
	"lfg-browser": [CURSOR_SONNET, SOL_MEDIUM, OPUS_MEDIUM],
};

const JUDGMENT_AGENTS: Record<string, true> = {
	"adversarial-document-reviewer": true,
	"adversarial-reviewer": true,
	"correctness-reviewer": true,
	"data-migration-reviewer": true,
	"deployment-verification-agent": true,
	"julik-frontend-races-reviewer": true,
	"reliability-reviewer": true,
	"security-lens-reviewer": true,
	"security-reviewer": true,
	"swift-ios-reviewer": true,
};

const LENS_AGENTS: Record<string, true> = {
	"design-lens-reviewer": true,
	"product-lens-reviewer": true,
	"scope-guardian-reviewer": true,
};

const JUDGMENT_MENU = [SOL_HIGH, SOL_MEDIUM, OPUS_MEDIUM];
const LENS_MENU = [CURSOR_SONNET, DS_MAX, OPUS_HIGH];
const MECHANICAL_MENU = [DS_MAX, DS_HIGH, SOL_MEDIUM];

export function suggestionsForRole(id: string): string[] {
	const key = id.includes("/") ? id.slice(0, id.indexOf("/")) : id;
	return ROLE_SUGGESTIONS[id] ?? ROLE_SUGGESTIONS[key] ?? ROLE_SUGGESTIONS.task;
}

export function suggestionsForAgent(id: string): string[] {
	if (AGENT_SUGGESTIONS[id]) return AGENT_SUGGESTIONS[id];
	if (JUDGMENT_AGENTS[id]) return JUDGMENT_MENU;
	if (LENS_AGENTS[id]) return LENS_MENU;
	return MECHANICAL_MENU;
}

export function pickerOptions(
	query: string,
	suggestions: readonly string[],
	catalog: readonly string[],
	current: string,
): string[] {
	const seen: Record<string, true> = {};
	const prescribed: string[] = [];
	for (const item of [current, ...suggestions]) {
		if (!item || seen[item]) continue;
		seen[item] = true;
		prescribed.push(item);
	}
	const needle = query.trim().toLowerCase();
	if (!needle) return prescribed;
	const hit = (item: string) => item.toLowerCase().includes(needle);
	const fromPrescribed = prescribed.filter(hit);
	const extra = catalog.filter(item => hit(item) && !seen[item]);
	return [...fromPrescribed, ...extra].slice(0, 40);
}
