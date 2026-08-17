import { useMemo, useState } from "react";
import {
	applyModelsAdmin,
	getModelsAdmin,
	previewModelsAdmin,
	type ModelsAdminApplyResult,
	type ModelsAdminChange,
	type ModelsAdminPreview,
	type ModelsAdminSnapshot,
} from "../api";
import { useResource } from "../data/useResource";
import { AsyncBoundary, DataTable, Panel, SegmentedControl, StatusPill } from "../ui";

export interface ModelsAdminRouteProps {
	active: boolean;
	refreshTrigger: number;
}

type Scope = "mac" | "vps" | "both";

function ModelPicker({
	value,
	catalog,
	onChange,
}: {
	value: string;
	catalog: string[];
	onChange: (next: string) => void;
}) {
	return (
		<input
			className="font-mono w-full min-w-0 rounded px-2 py-1 stats-text-primary"
			style={{
				background: "var(--stats-surface, transparent)",
				border: "1px solid var(--stats-border, currentColor)",
			}}
			list="models-admin-catalog-list"
			value={value}
			spellCheck={false}
			placeholder="provider/model:effort"
			onChange={event => onChange(event.target.value)}
		/>
	);
}

function formatValue(value: string | string[] | null | undefined): string {
	if (value == null) return "";
	return Array.isArray(value) ? value.join(", ") : value;
}

function parseValue(raw: string): string | string[] {
	if (raw.includes("\n")) return raw.split("\n").map(part => part.trim()).filter(Boolean);
	if (raw.includes(",") && raw.split(",").length > 1 && !raw.includes("provider")) {
		const parts = raw.split(",").map(part => part.trim()).filter(Boolean);
		if (parts.length > 1) return parts;
	}
	return raw.trim();
}

export function ModelsAdminRoute({ active, refreshTrigger }: ModelsAdminRouteProps) {
	const { data, error, loading, refetch } = useResource(
		["models-admin", refreshTrigger],
		signal => getModelsAdmin(signal),
		{ enabled: active },
	);
	const [drafts, setDrafts] = useState<Record<string, string>>({});
	const [scope, setScope] = useState<Scope>("both");
	const [commitMessage, setCommitMessage] = useState("chore(omp): update model assignments");
	const [preview, setPreview] = useState<ModelsAdminPreview | null>(null);
	const [result, setResult] = useState<ModelsAdminApplyResult | null>(null);
	const [busy, setBusy] = useState<"preview" | "apply" | null>(null);
	const [formError, setFormError] = useState<string | null>(null);
	const snapshot = data;
	const catalog = snapshot?.catalog ?? [];

	const setDraft = (key: string, value: string) => {
		setDrafts(prev => ({ ...prev, [key]: value }));
		setPreview(null);
		setResult(null);
	};

	const changes = useMemo(() => collectChanges(snapshot, drafts), [snapshot, drafts]);

	const runPreview = async () => {
		if (changes.length === 0) {
			setFormError("No assignment changes.");
			return;
		}
		setBusy("preview");
		setFormError(null);
		try {
			setPreview(await previewModelsAdmin({ scope, commitMessage, changes }));
		} catch (err) {
			setFormError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(null);
		}
	};

	const runApply = async () => {
		if (changes.length === 0) {
			setFormError("No assignment changes.");
			return;
		}
		setBusy("apply");
		setFormError(null);
		try {
			const next = await applyModelsAdmin({ scope, commitMessage, changes });
			setResult(next);
			setPreview(next);
			if (next.applied) {
				setDrafts({});
				await refetch();
			}
		} catch (err) {
			setFormError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(null);
		}
	};

	return (
		<div className="stats-route-container">
			<datalist id="models-admin-catalog-list">
				{catalog.map(model => (
					<option key={model} value={model} />
				))}
			</datalist>
			<Panel
				title="Models admin"
				subtitle="Change OMP assignments from the dashboard. The Models page stays read-only telemetry."
			>
				<AsyncBoundary
					loading={loading}
					error={error}
					data={snapshot}
					empty={!snapshot?.present}
					emptyText={snapshot?.warnings[0] ?? "No OMP tree found. Set OMP_HOME or open a gapilabs/omp checkout."}
				>
					{snapshot && (
						<div className="flex flex-col gap-3 min-w-0">
							<div className="flex flex-wrap gap-2">
								<StatusPill variant={snapshot.present ? "success" : "danger"}>
									{snapshot.kind} · {snapshot.root}
								</StatusPill>
								<StatusPill variant={snapshot.git ? "info" : "warning"}>
									{snapshot.git ? "git checkout" : "not a git repo"}
								</StatusPill>
								<StatusPill variant={snapshot.syncScript ? "info" : "warning"}>
									{snapshot.syncScript ? "sync script present" : "no sync script"}
								</StatusPill>
							</div>
							{snapshot.warnings.map(warning => (
								<div key={warning} className="stats-text-warning text-sm">
									{warning}
								</div>
							))}
						</div>
					)}
				</AsyncBoundary>
			</Panel>
			{snapshot?.present && (
				<ModelsAdminSections
					snapshot={snapshot}
					catalog={catalog}
					drafts={drafts}
					setDraft={setDraft}
					scope={scope}
					setScope={setScope}
					commitMessage={commitMessage}
					setCommitMessage={setCommitMessage}
					busy={busy}
					formError={formError}
					preview={preview}
					result={result}
					onPreview={() => void runPreview()}
					onApply={() => void runApply()}
				/>
			)}
		</div>
	);
}

function ModelsAdminSections(props: {
	snapshot: ModelsAdminSnapshot;
	catalog: string[];
	drafts: Record<string, string>;
	setDraft: (key: string, value: string) => void;
	scope: Scope;
	setScope: (scope: Scope) => void;
	commitMessage: string;
	setCommitMessage: (value: string) => void;
	busy: "preview" | "apply" | null;
	formError: string | null;
	preview: ModelsAdminPreview | null;
	result: ModelsAdminApplyResult | null;
	onPreview: () => void;
	onApply: () => void;
}) {
	const { snapshot, catalog, drafts, setDraft } = props;
	return (
		<>
			<Panel title="Roles" subtitle="modelRoles in agent/config.yml. Advisor also writes WATCHDOG.yml.">
				<AssignmentTable
					rows={snapshot.roles.map(item => ({
						id: item.id,
						label: item.id,
						value: drafts[`role:${item.id}`] ?? formatValue(item.value),
						meta: item.source,
					}))}
					catalog={catalog}
					onChange={(id, value) => setDraft(`role:${id}`, value)}
				/>
			</Panel>
			<Panel title="Fallback chains" subtitle="retry.fallbackChains. advisor stays empty.">
				<AssignmentTable
					rows={snapshot.fallbacks.map(item => ({
						id: item.id,
						label: item.id,
						value: drafts[`fallback:${item.id}`] ?? formatValue(item.value),
						meta: item.id === "advisor" ? "locked" : item.source,
						locked: item.id === "advisor",
					}))}
					catalog={catalog}
					onChange={(id, value) => setDraft(`fallback:${id}`, value)}
				/>
			</Panel>
			<Panel title="Agents" subtitle="Frontmatter model on agent/agents/*.md. Grouped by family.">
				{["core", "lfg", "lenses", "other"].map(group => {
					const rows = snapshot.agents.filter(agent => agent.group === group);
					if (rows.length === 0) return null;
					return (
						<div key={group} className="mb-4 min-w-0">
							<div className="stats-font-semibold mb-2 capitalize">{group}</div>
							<AssignmentTable
								rows={rows.map(item => ({
									id: item.id,
									label: item.id,
									value: drafts[`agent:${item.id}`] ?? formatValue(item.value),
									meta: item.hasModelField ? "frontmatter" : "no model field",
								}))}
								catalog={catalog}
								onChange={(id, value) => setDraft(`agent:${id}`, value)}
							/>
						</div>
					);
				})}
			</Panel>
			<Panel title="Watchdog" subtitle="WATCHDOG.yml advisors[].model wins over modelRoles.advisor.">
				<AssignmentTable
					rows={snapshot.watchdog.map(item => ({
						id: item.id,
						label: item.name,
						value: drafts[`watchdog:${item.id}`] ?? item.value,
						meta: item.source,
					}))}
					catalog={catalog}
					onChange={(id, value) => setDraft(`watchdog:${id}`, value)}
				/>
			</Panel>
			<Panel title="Hermes" subtitle="agent/hermes-memory-config.json">
				<div className="grid gap-3 md:grid-cols-2 min-w-0">
					<label className="flex flex-col gap-1 min-w-0">
						<span className="stats-mobile-card-label">llmModelOverride</span>
						<ModelPicker
							value={drafts["hermes:model"] ?? snapshot.hermes.llmModelOverride ?? ""}
							catalog={catalog}
							onChange={value => setDraft("hermes:model", value)}
						/>
					</label>
					<label className="flex flex-col gap-1 min-w-0">
						<span className="stats-mobile-card-label">llmThinkingOverride</span>
						<input
							className="font-mono w-full min-w-0 rounded px-2 py-1 stats-text-primary"
							style={{
								background: "var(--stats-surface, transparent)",
								border: "1px solid var(--stats-border, currentColor)",
							}}
							value={drafts["hermes:thinking"] ?? snapshot.hermes.llmThinkingOverride ?? ""}
							onChange={event => setDraft("hermes:thinking", event.target.value)}
						/>
					</label>
				</div>
			</Panel>
			<Panel title="Apply" subtitle="Preview diffs, then write. No process restart.">
				<div className="flex flex-col gap-3 min-w-0">
					<SegmentedControl
						value={props.scope}
						onChange={props.setScope}
						options={[
							{ value: "both", label: "Both", title: "Shared files, commit, sync script" },
							{ value: "mac", label: "Mac only", title: "Write local files only" },
							{ value: "vps", label: "VPS only", title: "Write hosts/gapicore.yml, commit, sync" },
						]}
					/>
					<label className="flex flex-col gap-1 min-w-0">
						<span className="stats-mobile-card-label">Commit message</span>
						<input
							className="w-full min-w-0 rounded px-2 py-1 stats-text-primary"
							style={{
								background: "var(--stats-surface, transparent)",
								border: "1px solid var(--stats-border, currentColor)",
							}}
							value={props.commitMessage}
							onChange={event => props.setCommitMessage(event.target.value)}
						/>
					</label>
					<div className="flex flex-wrap gap-2">
						<button type="button" className="stats-button" disabled={props.busy !== null} onClick={props.onPreview}>
							{props.busy === "preview" ? "Previewing…" : "Preview diffs"}
						</button>
						<button
							type="button"
							className="stats-button stats-button-primary"
							disabled={props.busy !== null}
							onClick={props.onApply}
						>
							{props.busy === "apply" ? "Applying…" : "Apply"}
						</button>
					</div>
					{props.formError && <div className="stats-text-danger text-sm">{props.formError}</div>}
					{props.result && (
						<div className="flex flex-col gap-2 min-w-0">
							<StatusPill variant={props.result.applied ? "success" : "warning"}>{props.result.message}</StatusPill>
							{props.result.git && (
								<pre className="stats-text-primary text-xs whitespace-pre-wrap break-words">
									git: {props.result.git.ok ? "ok" : "error"} {props.result.git.output}
								</pre>
							)}
							{props.result.sync && (
								<pre className="stats-text-primary text-xs whitespace-pre-wrap break-words">
									sync: {props.result.sync.ok ? "ok" : "error"} {props.result.sync.output}
								</pre>
							)}
						</div>
					)}
					{(props.preview?.diffs.length ?? 0) > 0 && (
						<div className="flex flex-col gap-3 min-w-0">
							<div className="stats-font-semibold">Preview</div>
							{props.preview?.files.map(file => (
								<div key={file} className="font-mono text-xs">
									{file}
								</div>
							))}
							{props.preview?.diffs.map(file => (
								<pre
									key={file.path}
									className="text-xs whitespace-pre-wrap break-words overflow-x-hidden rounded p-3"
									style={{
										background: "var(--stats-surface, transparent)",
										border: "1px solid var(--stats-border, currentColor)",
									}}
								>
									{file.diff}
								</pre>
							))}
						</div>
					)}
					<div className="text-sm stats-text-primary">
						Roles and advisor take effect on a new session. Agent pins take effect on the next task spawn.
					</div>
				</div>
			</Panel>
		</>
	);
}

function AssignmentTable({
	rows,
	catalog,
	onChange,
}: {
	rows: Array<{ id: string; label: string; value: string; meta?: string; locked?: boolean }>;
	catalog: string[];
	onChange: (id: string, value: string) => void;
}) {
	return (
		<DataTable
			columns={[
				{ key: "label", header: "Name", render: item => <span className="font-mono">{item.label}</span> },
				{
					key: "value",
					header: "Model",
					render: item =>
						item.locked ? (
							<StatusPill variant="info">[] locked</StatusPill>
						) : (
							<ModelPicker value={item.value} catalog={catalog} onChange={value => onChange(item.id, value)} />
						),
				},
				{
					key: "meta",
					header: "Source",
					render: item => <span className="font-mono text-xs">{item.meta}</span>,
				},
			]}
			data={rows}
			keyExtractor={item => item.id}
			renderMobileCard={item => (
				<div className="stats-mobile-card">
					<div className="stats-mobile-card-header mb-2">
						<div className="stats-font-semibold">{item.label}</div>
					</div>
					{item.locked ? (
						<StatusPill variant="info">[] locked</StatusPill>
					) : (
						<ModelPicker value={item.value} catalog={catalog} onChange={value => onChange(item.id, value)} />
					)}
				</div>
			)}
			emptyText="Nothing to show"
		/>
	);
}

function collectChanges(snapshot: ModelsAdminSnapshot | null, drafts: Record<string, string>): ModelsAdminChange[] {
	if (!snapshot) return [];
	const changes: ModelsAdminChange[] = [];
	for (const role of snapshot.roles) {
		const next = drafts[`role:${role.id}`];
		if (next !== undefined && next !== formatValue(role.value)) {
			changes.push({ kind: "role", id: role.id, value: parseValue(next) });
		}
	}
	for (const chain of snapshot.fallbacks) {
		if (chain.id === "advisor") continue;
		const next = drafts[`fallback:${chain.id}`];
		if (next !== undefined && next !== formatValue(chain.value)) {
			const parsed = parseValue(next);
			changes.push({ kind: "fallback", id: chain.id, value: Array.isArray(parsed) ? parsed : [parsed] });
		}
	}
	for (const agent of snapshot.agents) {
		const next = drafts[`agent:${agent.id}`];
		if (next !== undefined && next !== formatValue(agent.value)) {
			changes.push({ kind: "agentFrontmatter", id: agent.id, value: parseValue(next) });
		}
	}
	for (const advisor of snapshot.watchdog) {
		const next = drafts[`watchdog:${advisor.id}`];
		if (next !== undefined && next !== advisor.value) {
			changes.push({ kind: "watchdog", id: advisor.id, value: next });
		}
	}
	if (drafts["hermes:model"] !== undefined && drafts["hermes:model"] !== (snapshot.hermes.llmModelOverride ?? "")) {
		changes.push({ kind: "hermesModel", id: "llmModelOverride", value: drafts["hermes:model"] });
	}
	if (
		drafts["hermes:thinking"] !== undefined &&
		drafts["hermes:thinking"] !== (snapshot.hermes.llmThinkingOverride ?? "")
	) {
		changes.push({ kind: "hermesThinking", id: "llmThinkingOverride", value: drafts["hermes:thinking"] });
	}
	return changes;
}
