import type * as vscode from 'vscode';
import type { GrammarStats, RuleGrammarStats, SyntaxToken } from './engine';
import type { Analysis } from './highlight';
import { affixOf } from './affix';
import type { Affix } from './affix';
import { escapeAttribute, escapeHtml, isSingle, symbolBound } from './format';
import { isReference, tokensOnLine } from './syntax';

/**
 * The rule body, reduced to the shapes the summary indents. Lookaheads are already text, so they
 * stay leaves; references are not expanded, their own hover does that.
 */
type Expr =
	| { kind: 'sequence'; items: Expr[] }
	| { kind: 'option'; branches: Expr[]; affix?: Affix }
	| { kind: 'group'; label?: string; body: Expr; affix?: Affix }
	| { kind: 'reference'; text: string; name: string; affix?: Affix }
	| { kind: 'reserved'; text: string; name: string; affix?: Affix }
	| { kind: 'lookahead'; text: string; affix?: Affix }
	| { kind: 'literal'; text: string; affix?: Affix; start?: number; end?: number };

interface Line {
	indent: number;
	text: string;
}

/** Editor colours for the summary; `brackets` is cycled by group-paren depth. */
export interface SummaryPalette {
	name: string;
	affix: string;
	keyword: string;
	literal: string;
	selector: string;
	anchor: string;
	anchorBase: string;
	optional: string;
	lookahead: string;
	lookaheadText: string;
	brackets: string[];
}

const WIDTH = 72;

/**
 * Formats a rule's body as a coloured, indented block: larger groups and options open on their own
 * line, their contents are one level deeper, and repetition suffixes carry their bounds. The result
 * is a `<pre>` block of coloured `<span>`s, which the hover's trusted markdown renderer allows.
 */
export function ruleSummary(document: vscode.TextDocument, analysis: Analysis, stats: GrammarStats | undefined, definition: SyntaxToken, palette: SummaryPalette): string | undefined {
	const line = definition.line;
	const lineText = document.lineAt(line).text;
	const tokens = tokensOnLine(analysis.tokens, line);
	const colon = tokens.find((token) => (token.rule === 'ruleline' || token.rule === 'ruleline_final') && token.leaf === ':');
	if (colon === undefined) {
		return undefined;
	}
	const body = tokens.filter((token) => token.character >= colon.character + colon.length);
	if (body.length === 0) {
		return undefined;
	}
	const rules = rulesOf(stats);
	const parser = new BodyParser(body, lineText);
	const root = parser.parse();
	return renderSummary(root, rules, palette);
}

/** Formats the option whose `[` is at `open` in `analysis.tokens`, including its suffix. */
export function optionSummary(document: vscode.TextDocument, analysis: Analysis, stats: GrammarStats | undefined, open: number, palette: SummaryPalette): string | undefined {
	const start = analysis.tokens[open];
	if (start === undefined) {
		return undefined;
	}
	const lineText = document.lineAt(start.line).text;
	const tokens = tokensOnLine(analysis.tokens, start.line, start.character);
	const rules = rulesOf(stats);
	const parser = new BodyParser(tokens, lineText);
	const expr = parser.parseOption();
	if (expr === undefined || expr.kind !== 'option') {
		return undefined;
	}
	return renderSummary(expr, rules, palette);
}

function rulesOf(stats: GrammarStats | undefined): Map<string, RuleGrammarStats> {
	return new Map((stats?.rules ?? []).map((rule) => [rule.name, rule]));
}

function renderSummary(expr: Expr, rules: Map<string, RuleGrammarStats>, palette: SummaryPalette): string | undefined {
	const lines: Line[] = [];
	if (expr.kind === 'sequence') {
		// The root has no group delimiters, so width-wrapping it would make siblings look like
		// children of an unmarked group.
		renderSequence(expr, 0, 0, lines, rules, palette, false);
	} else {
		renderBlock(expr, 0, 0, lines, rules, palette);
	}
	const text = lines.map((entry) => `${'  '.repeat(entry.indent)}${entry.text}`).join('\n').trim();
	return text === '' ? undefined : `<pre>${text}</pre>`;
}

class BodyParser {
	private index = 0;

	constructor(private readonly tokens: SyntaxToken[], private readonly line: string) { }

	parse(): Expr {
		const items = this.sequence(() => false);
		return { kind: 'sequence', items };
	}

	parseOption(): Expr | undefined {
		return this.element();
	}

	private sequence(stop: (token: SyntaxToken) => boolean): Expr[] {
		const items: Expr[] = [];
		while (this.index < this.tokens.length) {
			const token = this.tokens[this.index];
			if (stop(token)) {
				break;
			}
			if (token.rule === 'suffix') {
				if (this.affixes(items, token)) {
					this.attach(items, affixOf(token.value));
				} else {
					this.add(items, this.literal(token));
				}
				this.index++;
				continue;
			}
			const expr = this.element();
			if (expr === undefined) {
				break;
			}
			this.add(items, expr);
		}
		return items;
	}

	private element(): Expr | undefined {
		const token = this.tokens[this.index];
		if (isReference(token)) {
			return this.reference();
		}
		switch (token.rule) {
			case 'optional_lookahead':
				return token.leaf === 'at' ? this.optionalLookahead() : undefined;
			case 'plain_lookahead':
				return token.leaf === 'at' ? this.plainLookahead() : undefined;
			case 'optional':
				return token.leaf === 'lbracket' ? this.option() : undefined;
			case 'group':
				return token.leaf === 'lparen' || token.leaf === 'word' ? this.group() : undefined;
			case 'reserved':
				return token.leaf === 'dollar' ? this.reserved() : undefined;
			case 'simple':
			case 'escaped':
			case 'at_alone':
			case 'dollar_alone':
				this.index++;
				return this.literal(token);
			default:
				return undefined;
		}
	}

	private literal(token: SyntaxToken): Expr {
		return { kind: 'literal', text: token.value, start: token.character, end: token.character + token.length };
	}

	private add(items: Expr[], expr: Expr): void {
		const last = items[items.length - 1];
		if (last?.kind === 'literal' && expr.kind === 'literal'
			&& last.affix === undefined && expr.affix === undefined
			&& last.end !== undefined && expr.start !== undefined && last.end === expr.start) {
			last.text += expr.text;
			last.end = expr.end;
			return;
		}
		items.push(expr);
	}

	/**
	 * A suffix only modifies a construct. Literal symbols such as `+` or `*` tokenize as suffixes
	 * too, so an adjacent suffix belongs to the literal (`:-:`); a separated one can modify it.
	 */
	private affixes(items: Expr[], token: SyntaxToken): boolean {
		const last = items[items.length - 1];
		if (last === undefined) {
			return false;
		}
		if (last.kind === 'literal') {
			return last.end !== undefined && last.end < token.character;
		}
		return last.kind === 'reference' || last.kind === 'reserved' || last.kind === 'group' || last.kind === 'option' || last.kind === 'lookahead';
	}

	private optionalLookahead(): Expr {
		const start = this.tokens[this.index];
		this.index++; // @
		this.index++; // >
		this.index++; // >
		this.index++; // [
		let depth = 1;
		while (this.index < this.tokens.length) {
			const token = this.tokens[this.index];
			if (token.leaf === 'lbracket') {
				depth++;
			} else if (token.leaf === 'rbracket') {
				depth--;
				if (depth === 0) {
					break;
				}
			}
			this.index++;
		}
		const close = this.tokens[this.index];
		const end = close === undefined ? start.character + start.length : close.character + close.length;
		const text = this.line.slice(start.character, end);
		if (close !== undefined) {
			this.index++;
		}
		const affix = this.takeAffix();
		return { kind: 'lookahead', text, affix };
	}

	private plainLookahead(): Expr {
		const start = this.tokens[this.index];
		this.index++; // @
		this.index++; // >
		const probe = this.tokens[this.index];
		const end = probe === undefined ? start.character + start.length : probe.character + probe.length;
		const text = this.line.slice(start.character, end);
		if (probe !== undefined) {
			this.index++;
		}
		return { kind: 'lookahead', text };
	}

	private option(): Expr {
		this.index++; // [
		const branches: Expr[] = [];
		for (;;) {
			const items = this.sequence((token) => token.leaf === 'pipe' || token.leaf === 'rbracket' || (token.rule === 'optional' && token.leaf === 'affix'));
			branches.push({ kind: 'sequence', items });
			const token = this.tokens[this.index];
			if (token === undefined) {
				break;
			}
			if (token.rule === 'optional' && token.leaf === 'affix') {
				if (this.affixes(items, token)) {
					this.attach(items, affixOf(token.value));
				} else {
					this.add(items, this.literal(token));
				}
				this.index++;
				if (this.tokens[this.index]?.leaf === 'rbracket') {
					this.index++;
				}
				break;
			}
			if (token.leaf === 'pipe') {
				this.index++;
				continue;
			}
			if (token.leaf === 'rbracket') {
				this.index++;
				break;
			}
			break;
		}
		const affix = this.takeAffix();
		return { kind: 'option', branches, affix };
	}

	private group(): Expr {
		let label: string | undefined;
		if (this.tokens[this.index].leaf === 'word') {
			const word = this.tokens[this.index];
			const colon = this.tokens[this.index + 1];
			const open = this.tokens[this.index + 2];
			if (colon?.leaf === ':' && open?.leaf === 'lparen') {
				label = word.value;
				this.index += 3;
			} else {
				this.index++;
				return { kind: 'literal', text: word.value };
			}
		} else {
			this.index++; // (
		}
		const body: Expr = { kind: 'sequence', items: this.sequence((token) => token.leaf === 'rparen' || token.rule === 'close_paren') };
		if (this.index < this.tokens.length) {
			this.index++; // )
		}
		const affix = this.takeAffix();
		return { kind: 'group', label, body, affix };
	}

	private reserved(): Expr {
		const start = this.tokens[this.index];
		let end = start;
		let name = '';
		while (this.index < this.tokens.length && this.tokens[this.index].rule === 'reserved') {
			const token = this.tokens[this.index];
			end = token;
			if (token.leaf === 'word') {
				name = token.value;
			}
			this.index++;
			if (token.leaf === 'rbracket') {
				break;
			}
		}
		const text = this.line.slice(start.character, end.character + end.length);
		const affix = this.takeAffix();
		return { kind: 'reserved', text, name, affix };
	}

	private reference(): Expr {
		const start = this.tokens[this.index];
		const rule = start.rule;
		let end = start;
		let name = '';
		let seenAt = false;
		while (this.index < this.tokens.length && this.tokens[this.index].rule === rule) {
			const token = this.tokens[this.index];
			end = token;
			if (token.leaf === 'at') {
				seenAt = true;
			} else if (seenAt && token.leaf === 'word') {
				name = token.value;
				this.index++;
				break;
			}
			this.index++;
		}
		const text = this.line.slice(start.character, end.character + end.length);
		const affix = this.takeAffix();
		return { kind: 'reference', text, name, affix };
	}

	private takeAffix(): Affix | undefined {
		const token = this.tokens[this.index];
		if (token === undefined || token.rule !== 'suffix') {
			return undefined;
		}
		this.index++;
		return affixOf(token.value);
	}

	private attach(items: Expr[], affix: Affix): void {
		const last = items[items.length - 1];
		if (last === undefined || last.kind === 'sequence') {
			return;
		}
		last.affix = last.affix === undefined ? affix : { ...affix, text: `${last.affix.text}${affix.text}` };
	}
}

function renderSequence(expr: Expr, indent: number, depth: number, lines: Line[], rules: Map<string, RuleGrammarStats>, palette: SummaryPalette, wrap = true): void {
	if (expr.kind !== 'sequence') {
		return;
	}
	const before = lines.length;
	renderItems(expr.items, indent, depth, lines, rules, palette, wrap);
	if (lines.length === before) {
		lines.push({ indent, text: annotation('empty') });
	}
}

/** Lays out a flat run; nested runs wrap at the display width. */
function renderItems(items: Expr[], indent: number, depth: number, lines: Line[], rules: Map<string, RuleGrammarStats>, palette: SummaryPalette, wrap: boolean): void {
	let current = '';
	const flush = (): void => {
		if (current !== '') {
			lines.push({ indent, text: current });
			current = '';
		}
	};
	for (const item of items) {
		const inline = inlineOf(item, rules, palette, depth);
		if (inline === undefined) {
			flush();
			renderBlock(item, indent, depth, lines, rules, palette);
			continue;
		}
		if (current === '') {
			current = inline;
		} else if (wrap && visibleLength(current) + 1 + visibleLength(inline) > WIDTH) {
			flush();
			current = inline;
		} else {
			current += ` ${inline}`;
		}
	}
	flush();
}

/** The one-line form of a node, or `undefined` when it must open into a block. */
function inlineOf(expr: Expr, rules: Map<string, RuleGrammarStats>, palette: SummaryPalette, depth: number): string | undefined {
	switch (expr.kind) {
		case 'literal':
			return `${colored(expr.text, palette.literal)}${affixText(expr.affix, palette)}${affixNote(expr.affix)}`;
		case 'reference': {
			const note = expr.affix === undefined ? referenceNote(expr, rules) : affixNote(expr.affix);
			return `${referenceText(expr.text, palette)}${affixText(expr.affix, palette)}${note}`;
		}
		case 'reserved':
			return `${reservedText(expr.text, palette)}${affixText(expr.affix, palette)}${affixNote(expr.affix)}`;
		case 'lookahead':
			return `${lookaheadText(expr.text, palette)}${affixText(expr.affix, palette)}${boundsNote('  [zero width]')}`;
		case 'group': {
			if (expr.body.kind !== 'sequence' || expr.body.items.length !== 1) {
				return undefined;
			}
			const child = inlineOf(expr.body.items[0], rules, palette, depth + 1);
			if (child === undefined) {
				return undefined;
			}
			const label = expr.label === undefined ? '' : `${colored(expr.label, palette.name)}${colored(':', palette.affix)}`;
			const bracket = bracketColor(depth, palette);
			return `${label}${colored('(', bracket)}${child}${colored(')', bracket)}${affixText(expr.affix, palette)}${affixNote(expr.affix)}`;
		}
		case 'option':
		case 'sequence':
			return undefined;
	}
}

function renderBlock(expr: Expr, indent: number, depth: number, lines: Line[], rules: Map<string, RuleGrammarStats>, palette: SummaryPalette): void {
	if (expr.kind === 'group') {
		const label = expr.label === undefined ? '' : `${colored(expr.label, palette.name)}${colored(':', palette.affix)}`;
		lines.push({ indent, text: `${label}${colored('(', bracketColor(depth, palette))}` });
		renderSequence(expr.body, indent + 1, depth + 1, lines, rules, palette);
		lines.push({ indent, text: `${colored(')', bracketColor(depth, palette))}${affixText(expr.affix, palette)}${affixNote(expr.affix)}` });
		return;
	}
	if (expr.kind === 'option') {
		lines.push({ indent, text: colored('[', palette.optional) });
		expr.branches.forEach((branch, branchIndex) => {
			const branchLines: Line[] = [];
			renderSequence(branch, indent + 1, depth, branchLines, rules, palette);
			branchLines.forEach((line, lineIndex) => {
				const text = branchIndex > 0 && lineIndex === 0 ? `${colored('| ', palette.optional)}${line.text}` : line.text;
				lines.push({ indent: line.indent, text });
			});
		});
		lines.push({ indent, text: `${colored(']', palette.optional)}${affixText(expr.affix, palette)}${affixNote(expr.affix)}` });
	}
}

function affixText(affix: Affix | undefined, palette: SummaryPalette): string {
	return affix === undefined ? '' : colored(affix.text, palette.affix);
}

/** Brackets carry bounds; smaller, muted text keeps them apart from grammar syntax. */
function affixNote(affix: Affix | undefined): string {
	if (affix === undefined) {
		return '';
	}
	if (affix.low === 1 && affix.high === 1 && !affix.ignored) {
		return '';
	}
	const once = affix.low === 1 && affix.high === 1;
	const parts = [`${symbolBound(affix.low, affix.high)} repeat${once ? '' : 's'}`];
	if (affix.ignored) {
		parts.push('ignored');
	}
	return boundsNote(`  [${parts.join(', ')}]`);
}

function referenceNote(expr: Expr & { kind: 'reference' }, rules: Map<string, RuleGrammarStats>): string {
	const rule = rules.get(expr.name);
	if (rule === undefined || isSingle(rule)) {
		return '';
	}
	return boundsNote(`  [${symbolBound(rule.low ?? 0, rule.high)} symbols]`);
}

function referenceText(text: string, palette: SummaryPalette): string {
	const at = text.lastIndexOf('@');
	if (at === -1) {
		return colored(text, palette.anchor);
	}
	const before = text.slice(0, at);
	let html = '';
	if (before !== '') {
		const colon = before.indexOf(':');
		if (colon === -1) {
			html += colored(before, palette.affix);
		} else {
			html += colored(before.slice(0, colon), palette.name);
			html += colored(before.slice(colon), palette.affix);
		}
	}
	html += colored('@', palette.anchorBase);
	html += colored(text.slice(at + 1), palette.anchor);
	return html;
}

function reservedText(text: string, palette: SummaryPalette): string {
	const open = text.indexOf('[');
	const close = text.lastIndexOf(']');
	if (open === -1 || close <= open) {
		return colored(text, palette.selector);
	}
	return `${colored(text.slice(0, open + 1), palette.selector)}${colored(text.slice(open + 1, close), palette.keyword)}${colored(text.slice(close), palette.selector)}`;
}

function lookaheadText(text: string, palette: SummaryPalette): string {
	const open = text.indexOf('[');
	if (open !== -1) {
		return `${colored(text.slice(0, open), palette.lookahead)}${colored(text.slice(open), palette.lookaheadText)}`;
	}
	const marker = text.startsWith('@>') ? '@>' : '';
	return `${colored(marker, palette.lookahead)}${colored(text.slice(marker.length), palette.lookaheadText)}`;
}

function bracketColor(depth: number, palette: SummaryPalette): string {
	if (palette.brackets.length === 0) {
		return palette.literal;
	}
	return palette.brackets[depth % palette.brackets.length] ?? palette.literal;
}

function colored(text: string, raw: string): string {
	const value = raw.trim();
	const color = /^#[0-9a-fA-F]+$/.test(value) || /^var\(--vscode(-[a-zA-Z0-9]+)+\)$/.test(value)
		? value
		: 'var(--vscode-editor-foreground)';
	return `<span style="color:${escapeAttribute(color)};">${escapeHtml(text)}</span>`;
}

function annotation(text: string): string {
	return `<span style="color:var(--vscode-descriptionForeground);">${escapeHtml(text)}</span>`;
}

/** Muted, smaller text for bounds; `<small>` keeps it near the main text's centre. */
function boundsNote(text: string): string {
	return `<small>${annotation(text)}</small>`;
}

function visibleLength(html: string): number {
	return html.replace(/<[^>]*>/g, '').length;
}
