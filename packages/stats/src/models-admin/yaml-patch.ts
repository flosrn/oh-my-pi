/**
 * Surgical YAML edits that keep comments and key order.
 * Never dump the document with YAML.stringify — that wipes every comment.
 */

export type YamlScalar = string | number | boolean | null;
export type YamlPatchValue = YamlScalar | YamlScalar[];

const ADVISOR_FALLBACK_PATH = ["retry", "fallbackChains", "advisor"] as const;

export function isAdvisorFallbackPath(path: readonly string[]): boolean {
	return (
		path.length === ADVISOR_FALLBACK_PATH.length &&
		path[0] === "retry" &&
		path[1] === "fallbackChains" &&
		path[2] === "advisor"
	);
}

export function setYamlPath(source: string, path: readonly string[], value: YamlPatchValue): string {
	if (path.length === 0) throw new Error("YAML path must not be empty");
	const forced = isAdvisorFallbackPath(path) ? [] : value;
	const newline = source.includes("\r\n") ? "\r\n" : "\n";
	const endsWithNewline = /\r?\n$/.test(source);
	const lines = source.split(/\r?\n/);
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

	const node = findNode(lines, path);
	if (node) {
		applyValue(lines, node, forced, newline);
	} else {
		insertPath(lines, path, forced);
	}

	let out = lines.join(newline);
	if (endsWithNewline || source.length === 0) out += newline;
	return out;
}

export function setYamlPaths(
	source: string,
	updates: ReadonlyArray<{ path: readonly string[]; value: YamlPatchValue }>,
): string {
	let next = source;
	for (const update of updates) next = setYamlPath(next, update.path, update.value);
	return next;
}

export function ensureAdvisorFallbackEmpty(source: string): string {
	return setYamlPath(source, ADVISOR_FALLBACK_PATH, []);
}

export function splitFrontmatter(source: string): { fm: string; body: string } | null {
	if (!source.startsWith("---")) return null;
	const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/.exec(source);
	if (!match) return null;
	return { fm: match[1], body: source.slice(match[0].length) };
}

export function setFrontmatterModel(source: string, value: string | string[] | null): string {
	const split = splitFrontmatter(source);
	if (!split) {
		if (value === null) return source;
		const fm = setYamlPath("name: untitled\n", ["model"], value);
		return `---\n${fm.replace(/\n$/, "")}\n---\n${source}`;
	}
	const nextFm = value === null ? removeYamlKey(split.fm, ["model"]) : setYamlPath(split.fm, ["model"], value);
	const fmBlock = nextFm.replace(/\n$/, "");
	const body = split.body;
	return `---\n${fmBlock}\n---\n${body}`;
}

export function removeYamlKey(source: string, path: readonly string[]): string {
	const newline = source.includes("\r\n") ? "\r\n" : "\n";
	const endsWithNewline = /\r?\n$/.test(source);
	const lines = source.split(/\r?\n/);
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	const node = findNode(lines, path);
	if (!node) return source;
	lines.splice(node.keyLine, node.endLine - node.keyLine + 1);
	let out = lines.join(newline);
	if (endsWithNewline) out += newline;
	return out;
}

interface YamlNode {
	keyLine: number;
	endLine: number;
	indent: number;
	inline: boolean;
}

function findNode(lines: string[], path: readonly string[]): YamlNode | null {
	let searchFrom = 0;
	let searchUntil = lines.length - 1;
	let parentIndent = -1;
	let found: YamlNode | null = null;

	for (let depth = 0; depth < path.length; depth++) {
		const key = path[depth];
		found = null;
		let i = searchFrom;
		while (i <= searchUntil) {
			const parsed = parseLine(lines[i]);
			if (parsed.kind === "key" && parsed.key === key && parsed.indent > parentIndent) {
				const end = blockEnd(lines, i, parsed.indent, searchUntil);
				found = {
					keyLine: i,
					endLine: end,
					indent: parsed.indent,
					inline: parsed.hasInlineValue,
				};
				break;
			}
			if (parsed.kind === "key" && parsed.indent <= parentIndent && i > searchFrom) break;
			i++;
		}
		if (!found) return null;
		parentIndent = found.indent;
		searchFrom = found.keyLine + 1;
		searchUntil = found.endLine;
	}
	return found;
}

function blockEnd(lines: string[], keyLine: number, indent: number, limit: number): number {
	let end = keyLine;
	for (let i = keyLine + 1; i <= limit; i++) {
		const parsed = parseLine(lines[i]);
		if (parsed.kind === "blank" || parsed.kind === "comment") {
			if (i + 1 <= limit) {
				const next = parseLine(lines[i + 1]);
				if (next.kind !== "blank" && next.indent <= indent && next.kind !== "comment") break;
			}
			end = i;
			continue;
		}
		if (parsed.indent <= indent) break;
		end = i;
	}
	return end;
}

function applyValue(lines: string[], node: YamlNode, value: YamlPatchValue, _newline: string): void {
	const keyLine = lines[node.keyLine];
	const parsed = parseLine(keyLine);
	const comment = parsed.trailingComment ?? "";

	if (Array.isArray(value)) {
		if (value.length === 0) {
			lines[node.keyLine] = `${" ".repeat(parsed.indent)}${parsed.key}: []${comment}`;
			if (node.endLine > node.keyLine) lines.splice(node.keyLine + 1, node.endLine - node.keyLine);
			return;
		}
		lines[node.keyLine] = `${" ".repeat(parsed.indent)}${parsed.key}:${comment}`;
		const itemIndent = " ".repeat(parsed.indent + 2);
		const items = value.map(item => `${itemIndent}- ${formatScalar(item)}`);
		lines.splice(node.keyLine + 1, node.endLine - node.keyLine, ...items);
		return;
	}

	lines[node.keyLine] = `${" ".repeat(parsed.indent)}${parsed.key}: ${formatScalar(value)}${comment}`;
	if (node.endLine > node.keyLine) lines.splice(node.keyLine + 1, node.endLine - node.keyLine);
}

function insertPath(lines: string[], path: readonly string[], value: YamlPatchValue | Record<string, never>): void {
	if (path.length === 1) {
		const indent = detectRootIndent(lines);
		appendAt(lines, lines.length, renderKey(path[0], value, indent));
		return;
	}

	const parentPath = path.slice(0, -1);
	const leaf = path[path.length - 1];
	let parent = findNode(lines, parentPath);
	if (!parent) {
		insertPath(lines, parentPath, {});
		parent = findNode(lines, parentPath);
		if (!parent) throw new Error(`Failed to create YAML parent ${parentPath.join(".")}`);
		// empty map parent is a key with no children; we will append under it
	}
	const childIndent = parent.indent + 2;
	const insertAt = parent.endLine + 1;
	const block = renderKey(leaf, value, childIndent);
	appendAt(lines, insertAt, block);
}

function renderKey(key: string, value: YamlPatchValue | Record<string, never>, indent: number): string[] {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		return [`${" ".repeat(indent)}${key}:`];
	}
	if (Array.isArray(value)) {
		if (value.length === 0) return [`${" ".repeat(indent)}${key}: []`];
		return [`${" ".repeat(indent)}${key}:`, ...value.map(item => `${" ".repeat(indent + 2)}- ${formatScalar(item)}`)];
	}
	return [`${" ".repeat(indent)}${key}: ${formatScalar(value as YamlScalar)}`];
}

function appendAt(lines: string[], index: number, block: string[]): void {
	lines.splice(index, 0, ...block);
}

function detectRootIndent(lines: string[]): number {
	for (const line of lines) {
		const parsed = parseLine(line);
		if (parsed.kind === "key") return parsed.indent;
	}
	return 0;
}

export function formatScalar(value: YamlScalar): string {
	if (value === null) return "null";
	if (typeof value === "boolean") return value ? "true" : "false";
	if (typeof value === "number") return String(value);
	if (value === "") return '""';
	if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(value) || /[\n\r#]/.test(value) || value !== value.trim()) {
		return JSON.stringify(value);
	}
	return value;
}

interface ParsedLine {
	indent: number;
	kind: "blank" | "comment" | "key" | "list" | "other";
	key?: string;
	hasInlineValue: boolean;
	trailingComment?: string;
}

function parseLine(raw: string): ParsedLine {
	const indent = raw.match(/^ */)?.[0].length ?? 0;
	const trimmed = raw.trim();
	if (!trimmed) return { indent, kind: "blank", hasInlineValue: false };
	if (trimmed.startsWith("#")) return { indent, kind: "comment", hasInlineValue: false };
	if (trimmed.startsWith("- ")) return { indent, kind: "list", hasInlineValue: false };

	const keyMatch = /^([A-Za-z0-9_.@/-]+)\s*:(.*)$/.exec(trimmed);
	if (!keyMatch) return { indent, kind: "other", hasInlineValue: false };

	const rest = keyMatch[2] ?? "";
	const hash = findUnquotedHash(rest);
	let valuePart = rest;
	let commentSuffix: string | undefined;
	if (hash === -1) {
		valuePart = rest.trim();
	} else {
		let start = hash;
		while (start > 0 && rest[start - 1] === " ") start--;
		valuePart = rest.slice(0, start).trim();
		commentSuffix = rest.slice(start);
	}
	return {
		indent,
		kind: "key",
		key: keyMatch[1],
		hasInlineValue: valuePart.length > 0,
		trailingComment: commentSuffix || undefined,
	};
}

function findUnquotedHash(text: string): number {
	let quote: '"' | "'" | null = null;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (quote) {
			if (ch === "\\" && quote === '"') {
				i++;
				continue;
			}
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === '"' || ch === "'") quote = ch;
		else if (ch === "#") return i;
	}
	return -1;
}

export function unifiedDiff(filename: string, before: string, after: string): string {
	if (before === after) return "";
	const a = before.split(/\r?\n/);
	const b = after.split(/\r?\n/);
	if (a[a.length - 1] === "") a.pop();
	if (b[b.length - 1] === "") b.pop();

	const lines = [`--- a/${filename}`, `+++ b/${filename}`];
	// Simple whole-file hunk: enough for preview, avoids a third-party diff dep.
	const start = 1;
	lines.push(`@@ -${start},${a.length} +${start},${b.length} @@`);
	for (const line of a) lines.push(`-${line}`);
	for (const line of b) lines.push(`+${line}`);
	return `${lines.join("\n")}\n`;
}
