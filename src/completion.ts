import * as vscode from 'vscode';
import { BUILTIN_SPEC_NAMES, ENGINE_SPECS, builtinSpec, builtinStatus, engineSpec, specKindName, specShape } from './builtins';
import type { GrammarStats, RuleGrammarStats } from './engine';
import type { Analysis } from './highlight';
import { inlineCode, plainText, ruleFacts, sentence } from './format';

/** One suggestion, precomputed once per document version. */
export interface CompletionEntry {
	name: string;
	detail: string;
	documentation: string;
	kind: vscode.CompletionItemKind;
	sortText: string;
}

/** The suggestion tables the provider reads; one table per document version. */
export interface CompletionTable {
	anchors: CompletionEntry[];
	uncreated: CompletionEntry[];
	/** declared and built-in specs usable as `$[name]` references */
	specs: CompletionEntry[];
	/** everything usable as a `$name:` declaration, including engine specs */
	declarations: CompletionEntry[];
}

/** Definitions, specs and unresolved references read straight from the buffer. */
export interface CompletionSource {
	anchors: { name: string; body: string }[];
	uncreated: { name: string }[];
	specs: { name: string; body: string }[];
}

const RULE_LINE = /^\s*@(?!>)\s*(\w+)\s*\??\s*:(.*)$/;
const SPEC_LINE = /^\s*\$\s*(\w+)\s*:(.*)$/;
const REFERENCE = /@\s*(?!>)(\w+)/g;
const PLAIN_LOOKAHEAD = /@>(?!>)\s*[^\s[\]]+/g;
const OPTIONAL_LOOKAHEAD = /@>>\s*\[/g;
const COMMENT_LINE = /^\s*#/;

const byName = (a: { name: string }, b: { name: string }): number =>
	a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

/**
 * Reads what completion needs without the engine: a rule definition is `@name:` at the start of a
 * line, a spec declaration is `$name:`, and every other `@name` is a reference. A grammar that has
 * not been tokenized yet still completes from this.
 */
export function scanCompletions(text: string): CompletionSource {
	const anchors = new Map<string, string>();
	const specs = new Map<string, string[]>();
	const known = new Set<string>();
	const referenced = new Set<string>();

	for (const line of text.split(/\r?\n/)) {
		if (COMMENT_LINE.test(line)) {
			continue;
		}
		const spec = SPEC_LINE.exec(line);
		if (spec !== null) {
			const body = spec[2].trim();
			const list = specs.get(spec[1]);
			if (list === undefined) {
				specs.set(spec[1], [body]);
			} else {
				list.push(body);
			}
			// a spec body is a pattern, not grammar, so it contributes no references
			continue;
		}
		const rule = RULE_LINE.exec(line);
		let definitionAt = -1;
		if (rule !== null) {
			definitionAt = line.indexOf('@');
			known.add(rule[1]);
			if (!anchors.has(rule[1])) {
				anchors.set(rule[1], rule[2].trim());
			}
		}
		// lookahead contents are literal text, not references
		const probes = [...line.matchAll(PLAIN_LOOKAHEAD)].map((match) => [match.index, match.index + match[0].length]);
		const masked = [...probes, ...optionalLookaheadRanges(line)];
		for (const match of line.matchAll(REFERENCE)) {
			if (match.index === definitionAt || masked.some(([start, end]) => match.index >= start && match.index < end)) {
				continue;
			}
			referenced.add(match[1]);
		}
	}

	return {
		anchors: [...anchors].map(([name, body]) => ({ name, body })).sort(byName),
		uncreated: [...referenced].filter((name) => !known.has(name)).sort().map((name) => ({ name })),
		specs: [...specs].map(([name, bodies]) => ({ name, body: bodies.join(' | ') })).sort(byName),
	};
}

/**
 * Builds the tables the provider reads. `analysis` and `stats` are used only when they already
 * describe this version, so a completion never waits for an engine run.
 */
export function buildCompletionTable(text: string, analysis?: Analysis, stats?: GrammarStats): CompletionTable {
	const source = analysis === undefined ? scanCompletions(text) : fromAnalysis(text, analysis);
	const rules = new Map((stats?.rules ?? []).map((rule) => [rule.name, rule]));
	const declared = new Set(source.specs.map((spec) => spec.name));
	const declaredEntries = source.specs.map(declaredSpecEntry);
	// engine config specs are declarations only; they are not `$[name]` reserved references
	const referenceEntries = declaredEntries.filter((entry) => engineSpec(entry.name) === undefined);
	const builtinEntries = BUILTIN_SPEC_NAMES.filter((name) => !declared.has(name)).map(builtinEntry);
	const engineEntries = Object.keys(ENGINE_SPECS).filter((name) => !declared.has(name)).map(engineEntry);
	return {
		anchors: source.anchors.map((anchor) => anchorEntry(anchor, rules.get(anchor.name))),
		uncreated: source.uncreated.map(uncreatedEntry),
		specs: [...referenceEntries, ...builtinEntries],
		declarations: [...declaredEntries, ...builtinEntries, ...engineEntries],
	};
}

/** The engine's own definitions and references are authoritative; only the bodies come from text. */
function fromAnalysis(text: string, analysis: Analysis): CompletionSource {
	const scan = scanCompletions(text);
	const bodies = new Map(scan.anchors.map((anchor) => [anchor.name, anchor.body]));
	const known = new Set(analysis.definitions.map((definition) => definition.name));
	// lookahead branches are literal probe text, so `analyze` deliberately leaves them out
	const referenced = new Set(analysis.references.map((reference) => reference.name));
	const specs = new Map<string, string[]>();
	for (const spec of analysis.specs) {
		const list = specs.get(spec.name);
		if (list === undefined) {
			specs.set(spec.name, [spec.body.trim()]);
		} else {
			list.push(spec.body.trim());
		}
	}
	return {
		anchors: [...known].sort().map((name) => ({ name, body: bodies.get(name) ?? '' })),
		uncreated: [...referenced].filter((name) => !known.has(name)).sort().map((name) => ({ name })),
		specs: [...specs].map(([name, bodies]) => ({ name, body: bodies.join(' | ') })).sort(byName),
	};
}

function anchorEntry(anchor: { name: string; body: string }, rule?: RuleGrammarStats): CompletionEntry {
	return {
		name: anchor.name,
		detail: ruleDetail(rule),
		documentation: inlineCode(anchor.body === '' ? `@${anchor.name}` : `@${anchor.name}: ${anchor.body}`),
		kind: vscode.CompletionItemKind.Function,
		sortText: `0${anchor.name}`,
	};
}

function uncreatedEntry(anchor: { name: string }): CompletionEntry {
	return {
		name: anchor.name,
		detail: 'no definition',
		documentation: `${inlineCode(`@${anchor.name}`)} is referenced but never defined.`,
		kind: vscode.CompletionItemKind.Reference,
		sortText: `1${anchor.name}`,
	};
}

function declaredSpecEntry(spec: { name: string; body: string }): CompletionEntry {
	const builtin = builtinSpec(spec.name);
	const engine = engineSpec(spec.name);
	const shape = specShape(spec.name, spec.body);
	const type = specKindName(shape.kind);
	const summary = engine?.summary ?? builtin?.summary;
	const parts: string[] = [];
	if (spec.body !== '') {
		parts.push(inlineCode(spec.body));
	}
	parts.push(builtinStatus(spec.name));
	if (engine?.kind === 'number' && engine.default !== undefined) {
		parts.push(`default ${inlineCode(engine.default)}`);
	}
	if (engine?.kind === 'enum') {
		if (engine.values !== undefined) {
			parts.push(`one of ${engine.values.map(inlineCode).join(', ')}`);
		}
		if (engine.default !== undefined) {
			parts.push(`default ${inlineCode(engine.default)}`);
		}
	}
	return {
		name: spec.name,
		detail: summary === undefined ? type : `${type} · ${plainText(summary)}`,
		documentation: summary === undefined ? parts.join(' · ') : `${sentence(summary)}\n\n${parts.join(' · ')}`,
		kind: vscode.CompletionItemKind.Constant,
		sortText: `0${spec.name}`,
	};
}

function builtinEntry(name: string): CompletionEntry {
	const builtin = builtinSpec(name);
	if (builtin === undefined) {
		return {
			name,
			detail: 'spec',
			documentation: 'Built-in spec.',
			kind: vscode.CompletionItemKind.Constant,
			sortText: `1${name}`,
		};
	}
	return {
		name,
		detail: `${specKindName(builtin.kind)} · ${plainText(builtin.summary)}`,
		documentation: `${sentence(builtin.summary)}\n\n${builtin.overridable ? 'Overridable built-in.' : 'Built-in, cannot be overridden.'}`,
		kind: vscode.CompletionItemKind.Constant,
		sortText: `1${name}`,
	};
}

function engineEntry(name: string): CompletionEntry {
	const engine = ENGINE_SPECS[name];
	const parts = ['Engine spec'];
	if (engine.kind === 'number' && engine.default !== undefined) {
		parts.push(`default ${inlineCode(engine.default)}`);
	}
	if (engine.kind === 'enum') {
		if (engine.values !== undefined) {
			parts.push(`one of ${engine.values.map(inlineCode).join(', ')}`);
		}
		if (engine.default !== undefined) {
			parts.push(`default ${inlineCode(engine.default)}`);
		}
	}
	return {
		name,
		detail: `${specKindName(engine.kind)} · ${plainText(engine.summary)}`,
		documentation: `${sentence(engine.summary)}\n\n${parts.join(' · ')}`,
		kind: vscode.CompletionItemKind.Constant,
		sortText: `2${name}`,
	};
}

function ruleDetail(rule?: RuleGrammarStats): string {
	return rule === undefined ? 'rule' : ruleFacts(rule).join(' · ');
}

type CompletionContext =
	| { kind: 'anchor'; start: number; prefix: string; definition: boolean }
	| { kind: 'spec'; start: number; ignored: boolean }
	| { kind: 'declaration'; start: number }
	| { kind: 'specValue'; start: number; name: string }
	| { kind: 'lookahead'; start: number };

/** What the text before the cursor is trying to name. */
function resolveContext(before: string): CompletionContext | undefined {
	if (before.trimStart().startsWith('#') || insideLookahead(before)) {
		return undefined;
	}
	const emptyValue = /^\s*\$\s*(\w+)\s*:\s*$/.exec(before);
	const partialValue = /^\s*\$\s*(\w+)\s*:\s*(\w+)$/.exec(before);
	const value = emptyValue ?? partialValue;
	if (value !== null) {
		const engine = engineSpec(value[1]);
		if (engine?.kind === 'enum') {
			const typed = emptyValue === null ? value[2] : '';
			return { kind: 'specValue', start: before.length - typed.length, name: value[1] };
		}
		return undefined;
	}
	if (/^\s*\$\s*\w+\s*:/.test(before)) {
		return undefined;
	}
	const lookahead = /@>{1,2}$/.exec(before);
	if (lookahead !== null) {
		return { kind: 'lookahead', start: lookahead.index };
	}
	const spec = /\$\$?\[\w*$/.exec(before);
	if (spec !== null) {
		return { kind: 'spec', start: spec.index, ignored: before.startsWith('$$', spec.index) };
	}
	const reference = /\$\$?\w*$/.exec(before);
	if (reference !== null) {
		// a `$` that starts the line declares a spec; one inside a body references it
		if (!before.startsWith('$$', reference.index) && before.slice(0, reference.index).trim() === '') {
			return { kind: 'declaration', start: reference.index };
		}
		return { kind: 'spec', start: reference.index, ignored: before.startsWith('$$', reference.index) };
	}
	const anchor = /(?:(\w+):)?(\?)?@\w*$/.exec(before);
	if (anchor !== null) {
		const prefix = `${anchor[1] === undefined ? '' : `${anchor[1]}:`}${anchor[2] ?? ''}`;
		return {
			kind: 'anchor',
			start: anchor.index,
			prefix,
			definition: prefix === '' && before.slice(0, anchor.index).trim() === '',
		};
	}
	return undefined;
}

/** A lookahead's contents are literal text, so grammar completion stops inside one. */
function insideLookahead(before: string): boolean {
	if (insideOptionalLookahead(before)) {
		return true;
	}
	return /@>(?!>)\s*[^\s[\]]+$/.test(before);
}

function insideOptionalLookahead(before: string): boolean {
	let depth = 0;
	for (let index = 0; index < before.length; index++) {
		const char = before[index];
		if (char === '\\' && (before[index + 1] === '[' || before[index + 1] === ']')) {
			index++;
			continue;
		}
		if (depth === 0 && before.startsWith('@>>', index)) {
			let open = index + 3;
			while (open < before.length && (before[open] === ' ' || before[open] === '\t')) {
				open++;
			}
			if (before[open] === '[') {
				depth = 1;
				index = open;
			}
			continue;
		}
		if (depth > 0) {
			if (char === '[') {
				depth++;
			} else if (char === ']') {
				depth--;
			}
		}
	}
	return depth > 0;
}

function optionalLookaheadRanges(line: string): [number, number][] {
	const ranges: [number, number][] = [];
	for (const match of line.matchAll(OPTIONAL_LOOKAHEAD)) {
		const open = line.indexOf('[', match.index);
		let depth = 0;
		for (let index = open; index < line.length; index++) {
			if (line[index] === '\\' && (line[index + 1] === '[' || line[index + 1] === ']')) {
				index++;
				continue;
			}
			if (line[index] === '[') {
				depth++;
			} else if (line[index] === ']') {
				depth--;
				if (depth === 0) {
					ranges.push([match.index, index + 1]);
					break;
				}
			}
		}
	}
	return ranges;
}

/**
 * The end of what the item replaces: the rest of an existing name, plus the closing syntax
 * (`:`, `]`) the suggestion itself supplies, so editing in the middle of a token works.
 */
function contextEnd(line: string, column: number, context: CompletionContext): number {
	if (context.kind === 'anchor') {
		return wordEnd(line, column);
	}
	if (context.kind === 'lookahead') {
		let end = column;
		while (line[end] === '>') {
			end++;
		}
		return end;
	}
	if (context.kind === 'spec') {
		const end = wordEnd(line, column);
		let close = end;
		while (line[close] === ' ' || line[close] === '\t') {
			close++;
		}
		return line[close] === ']' ? close + 1 : end;
	}
	if (context.kind === 'specValue') {
		return wordEnd(line, column);
	}
	let end = wordEnd(line, column);
	let colon = end;
	while (line[colon] === ' ' || line[colon] === '\t') {
		colon++;
	}
	if (line[colon] !== ':') {
		return end;
	}
	end = colon + 1;
	while (line[end] === ' ' || line[end] === '\t') {
		end++;
	}
	return end;
}

function wordEnd(line: string, from: number): number {
	let index = from;
	while (index < line.length && /\w/.test(line[index])) {
		index++;
	}
	return index;
}

/**
 * Suggestions for the token at the cursor. The tables are already built, so this only turns them
 * into items and resolves the range to replace.
 */
export function provideCompletion(
	document: vscode.TextDocument,
	position: vscode.Position,
	table: CompletionTable,
	token: vscode.CancellationToken,
): vscode.CompletionItem[] {
	if (token.isCancellationRequested) {
		return [];
	}
	const line = document.lineAt(position.line).text;
	const context = resolveContext(line.slice(0, position.character));
	if (context === undefined) {
		return [];
	}
	const end = contextEnd(line, position.character, context);
	const range = new vscode.Range(position.line, context.start, position.line, end);
	const items: vscode.CompletionItem[] = [];

	switch (context.kind) {
		case 'anchor': {
			const entries = context.definition ? table.uncreated : table.anchors;
			for (const entry of entries) {
				if (token.isCancellationRequested) {
					return items;
				}
				const label = `${context.prefix}@${entry.name}${context.definition ? ':' : ''}`;
				const item = new vscode.CompletionItem(label, entry.kind);
				item.detail = context.definition ? 'new rule' : entry.detail;
				item.documentation = new vscode.MarkdownString(entry.documentation);
				item.filterText = label;
				item.insertText = context.definition ? `${label} ` : label;
				item.range = range;
				item.sortText = entry.sortText;
				items.push(item);
			}
			break;
		}
		case 'declaration': {
			for (const entry of table.declarations) {
				if (token.isCancellationRequested) {
					return items;
				}
				const label = `$${entry.name}:`;
				const item = new vscode.CompletionItem(label, entry.kind);
				item.detail = entry.detail;
				item.documentation = new vscode.MarkdownString(entry.documentation);
				item.filterText = label;
				item.insertText = `${label} `;
				item.range = range;
				item.sortText = entry.sortText;
				items.push(item);
			}
			break;
		}
		case 'spec': {
			for (const entry of table.specs) {
				for (const ignored of context.ignored ? [true] : [false, true]) {
					if (token.isCancellationRequested) {
						return items;
					}
					const label = `${ignored ? '$$' : '$'}[${entry.name}]`;
					const item = new vscode.CompletionItem(label, entry.kind);
					item.detail = ignored ? `${entry.detail} · ignored` : entry.detail;
					item.documentation = new vscode.MarkdownString(ignored ? `${entry.documentation} · the match is ignored` : entry.documentation);
					item.filterText = label;
					item.insertText = label;
					item.range = range;
					item.sortText = `${ignored ? '1' : '0'}${entry.sortText}`;
					items.push(item);
				}
			}
			break;
		}
		case 'specValue': {
			const engine = engineSpec(context.name);
			if (engine?.kind !== 'enum' || engine.values === undefined) {
				break;
			}
			const values = engine.default !== undefined && engine.values.includes(engine.default)
				? [engine.default, ...engine.values.filter((value) => value !== engine.default)]
				: engine.values;
			const documentation = new vscode.MarkdownString(sentence(engine.summary));
			if (engine.default !== undefined) {
				documentation.appendMarkdown(`\n\nDefault: ${inlineCode(engine.default)}.`);
			}
			for (const value of values) {
				if (token.isCancellationRequested) {
					return items;
				}
				const item = new vscode.CompletionItem(value, vscode.CompletionItemKind.EnumMember);
				item.detail = `enum · ${engine.summary}`;
				item.documentation = documentation;
				item.filterText = value;
				item.insertText = value;
				item.range = range;
				item.sortText = `0${value}`;
				items.push(item);
			}
			break;
		}
		case 'lookahead': {
			// an existing branch list is already complete; do not nest another one
			if (line.slice(end).trimStart().startsWith('[')) {
				break;
			}
			// `@>` is followed by a bare probe (`@>foo`); only `@>>` takes brackets
			const label = '@>>[]';
			const item = new vscode.CompletionItem(label, vscode.CompletionItemKind.Snippet);
			item.detail = 'optional lookahead';
			item.documentation = new vscode.MarkdownString('Zero width');
			item.filterText = label;
			item.insertText = new vscode.SnippetString('@>>[$0]');
			item.range = range;
			item.sortText = label;
			items.push(item);
			break;
		}
	}

	return items;
}
