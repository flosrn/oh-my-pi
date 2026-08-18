import { useEffect, useId, useMemo, useRef, useState } from "react";
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
import { AsyncBoundary, Panel, SegmentedControl, StatusPill } from "../ui";

export interface ModelsAdminRouteProps {
	active: boolean;
	refreshTrigger: number;
}

type Scope = "mac" | "vps" | "both";

function filterCatalog(query: string, catalog: string[]): string[] {
	const needle = query.trim().toLowerCase();
	if (!needle) return catalog;
	return catalog.filter(item => item.toLowerCase().includes(needle));
}

function ModelPicker({
	value,
	catalog,
	onChange,
}: {
	value: string;
	catalog: string[];
	onChange: (next: string) => void;
}) {
	const [open, setOpen] = useState(false);
	const [highlight, setHighlight] = useState(0);
	const rootRef = useRef<HTMLDivElement>(null);
	const listId = useId();
	const matches = useMemo(() => filterCatalog(value, catalog).slice(0, 40), [catalog, value]);

	useEffect(() => {
		if (!open) return;
		const onDoc = (event: MouseEvent) => {
			if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
		};
		document.addEventListener("mousedown", onDoc);
		return () => document.removeEventListener("mousedown", onDoc);
	}, [open]);

	const pick = (next: string) => {
		onChange(next);
		setOpen(false);
	};

	return (
		<div className="stats-combobox" ref={rootRef}>
			<input
				className="stats-combobox-input"
				value={value}
				spellCheck={false}
				autoComplete="off"
				role="combobox"
				aria-expanded={open}
				aria-controls={listId}
				aria-autocomplete="list"
				placeholder="provider/model:effort"
				title={value}
				onFocus={() => {
					setOpen(true);
					setHighlight(0);
				}}
				onChange={event => {
					onChange(event.target.value);
					setOpen(true);
					setHighlight(0);
				}}
				onKeyDown={event => {
					if (event.key === "Escape") {
						setOpen(false);
						return;
					}
					if (event.key === "ArrowDown") {
						event.preventDefault();
						setOpen(true);
						setHighlight(index => Math.min(index + 1, Math.max(matches.length - 1, 0)));
						return;
					}
					if (event.key === "ArrowUp") {
						event.preventDefault();
						setHighlight(index => Math.max(index - 1, 0));
						return;
					}
					if (event.key === "Enter" && open && matches[highlight]) {
						event.preventDefault();
						pick(matches[highlight]);
					}
				}}
			/>
			{open && matches.length > 0 && (
				<ul className="stats-combobox-list" id={listId} role="listbox">
					{matches.map((item, index) => (
						<li
							key={item}
							role="option"
							aria-selected={index === highlight}
							className={index === highlight ? "is-active" : undefined}
							onMouseDown={event => {
								event.preventDefault();
								pick(item);
							}}
							onMouseEnter={() => setHighlight(index)}
						>
							{item}
						</li>
					))}
				</ul>
			)}
		</div>
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
		<div className="stats-route-container space-y-6">
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
	if (rows.length === 0) return <div className="stats-table-empty">Nothing to show</div>;
	return (
		<div className="stats-assign-table">
			<div className="stats-assign-head">
				<div>Name</div>
				<div>Model</div>
				<div>Source</div>
			</div>
			{rows.map(item => (
				<div key={item.id} className="stats-assign-row">
					<div className="stats-assign-name">{item.label}</div>
					<div className="stats-assign-model">
						{item.locked ? (
							<StatusPill variant="info">[] locked</StatusPill>
						) : (
							<ModelPicker value={item.value} catalog={catalog} onChange={value => onChange(item.id, value)} />
						)}
					</div>
					<div className="stats-assign-source" title={item.meta}>
						{item.meta}
					</div>
				</div>
			))}
		</div>
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
