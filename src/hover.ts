import * as vscode from 'vscode';
import { builtinSpec, BUILTIN_SPEC_NAMES } from './builtins';
import { GrammarStats, RuleGrammarStats, SyntaxToken } from './engine';
import { Analysis } from './highlight';
import { ruleFlags, symbolBound } from './format';

/**
 * Hover for a `.ct` grammar. The engine's tokens say what the token under the cursor is; the static
 * grammar stats say what the named rule expands to.
 */
export function provideHover(
	document: vscode.TextDocument,
	analysis: Analysis,
	stats: GrammarStats | undefined,
	position: vscode.Position,
): vscode.Hover | undefined {
	const index = tokenIndexAt(analysis.tokens, position);
	if (index === -1) {
		return undefined;
	}
	const token = analysis.tokens[index];
	const previous = index > 0 ? analysis.tokens[index - 1] : undefined;
	const md = new vscode.MarkdownString();
	md.isTrusted = true;

	switch (token.rule) {
		case 'ruleline':
		case 'ruleline_final':
			if (token.leaf === 'word') {
				appendRule(md, document, analysis, stats, token);
				return hover(md, token);
			}
			break;

		case 'plain_reference':
		case 'optional_reference':
			if (token.leaf === 'word') {
				appendReference(md, document, analysis, stats, token.value);
				return hover(md, token);
			}
			if (token.leaf === 'qmark') {
				md.appendMarkdown('`?` optional reference');
				return hover(md, token);
			}
			break;

		case 'named_reference':
		case 'named_optional_reference':
			if (token.leaf === 'word') {
				if (previous !== undefined && previous.leaf === 'at') {
					appendReference(md, document, analysis, stats, token.value);
				} else {
					md.appendMarkdown(`**${token.value}** reference label`);
				}
				return hover(md, token);
			}
			if (token.leaf === 'qmark') {
				md.appendMarkdown('`?` optional reference');
				return hover(md, token);
			}
			break;

		case 'reserved':
			if (token.leaf === 'word') {
				appendSpec(md, analysis, token.value, undefined, isIgnoredReserved(analysis.tokens, index));
				return hover(md, token);
			}
			if (token.leaf === 'dollar' && token.value.startsWith('$$')) {
				md.appendMarkdown('`$$` ignored reserved spec: the match is ignored.');
				return hover(md, token);
			}
			if (token.leaf === 'lbracket' || token.leaf === 'rbracket') {
				md.appendMarkdown('`$[...]` reserved spec selector');
				return hover(md, token);
			}
			break;

		case 'specline':
			if (token.leaf === 'word') {
				appendSpec(md, analysis, token.value, token, false);
				return hover(md, token);
			}
			break;

		case 'suffix':
			appendAffix(md, token.value);
			return hover(md, token);

		case 'optional':
		case 'optional_lookahead':
			if (token.leaf === 'affix') {
				appendAffix(md, token.value);
				return hover(md, token);
			}
			if (token.leaf === 'at' || token.leaf === 'gt') {
				appendLookahead(md, token.rule === 'optional_lookahead');
				return hover(md, token);
			}
			if (token.leaf === 'lbracket' || token.leaf === 'rbracket') {
				appendOption(md, analysis.tokens, index, token.rule === 'optional_lookahead');
				return hover(md, token);
			}
			if (token.leaf === 'pipe') {
				md.appendMarkdown('`|` option branch separator');
				return hover(md, token);
			}
			break;

		case 'plain_lookahead':
			if (token.leaf === 'at' || token.leaf === 'gt') {
				appendLookahead(md, false);
				return hover(md, token);
			}
			break;

		case 'group':
			if (token.leaf === 'word') {
				md.appendMarkdown(`**${token.value}** group label`);
				return hover(md, token);
			}
			if (token.leaf === ':') {
				md.appendMarkdown('`:` group label separator');
				return hover(md, token);
			}
			if (token.leaf === 'lparen' || token.leaf === 'rparen') {
				appendGroup(md, document, analysis.tokens, index);
				return hover(md, token);
			}
			break;

		default:
			break;
	}
	return undefined;
}

/** The token covering `position`, found by index so callers can also look at the preceding token. */
function tokenIndexAt(tokens: SyntaxToken[], position: vscode.Position): number {
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (token.line !== position.line) {
			continue;
		}
		if (position.character >= token.character && position.character < token.character + token.length) {
			return i;
		}
	}
	return -1;
}

function hover(md: vscode.MarkdownString, token: SyntaxToken): vscode.Hover {
	return new vscode.Hover(md, new vscode.Range(token.line, token.character, token.line, token.character + token.length));
}

function appendRule(md: vscode.MarkdownString, document: vscode.TextDocument, analysis: Analysis, stats: GrammarStats | undefined, token: SyntaxToken): void {
	const name = token.value;
	const uses = analysis.references.filter((ref) => ref.name === name).length;
	md.appendMarkdown(`**@${name}**\n\n`);
	md.appendMarkdown(ruleLine(stats, name, `${uses} reference${uses === 1 ? '' : 's'}`));
	const body = bodyAt(document, token.line, token.character + token.length);
	if (body) {
		md.appendMarkdown(`\n\n${inline(body)}`);
	}
}

function appendReference(md: vscode.MarkdownString, document: vscode.TextDocument, analysis: Analysis, stats: GrammarStats | undefined, name: string): void {
	const definition = analysis.definitions.find((entry) => entry.name === name);
	if (definition === undefined) {
		md.appendMarkdown(`**@${name}**\n\nNo \`@${name}\` rule.`);
		return;
	}
	md.appendMarkdown(`**@${name}** line ${definition.line + 1}\n\n`);
	md.appendMarkdown(ruleLine(stats, name));
	const args = encodeURIComponent(JSON.stringify([document.uri.toString(), definition.line, definition.column]));
	md.appendMarkdown(`\n\n[Go to definition](command:clemtoken.revealDefinition?${args})`);
}

/** `Anchor · 1..∞ symbols · recursive · 2 references`, skipping whatever is unknown. */
function ruleLine(stats: GrammarStats | undefined, name: string, tail?: string): string {
	const parts: string[] = [];
	const rule = stats?.rules.find((entry) => entry.name === name);
	if (rule !== undefined) {
		parts.push(rule.type, `${symbolBound(rule.low, rule.high)} symbol${isSingle(rule) ? '' : 's'}`);
		parts.push(...ruleFlags(rule));
	}
	if (tail !== undefined) {
		parts.push(tail);
	}
	return parts.join(' · ');
}

function appendSpec(md: vscode.MarkdownString, analysis: Analysis, name: string, declaration: SyntaxToken | undefined, ignored: boolean): void {
	const uses = analysis.tokens.filter((token) => token.rule === 'reserved' && token.leaf === 'word' && token.value === name).length;
	const builtin = builtinSpec(name);
	// a declaration is the spec written at this position; a reference stands for every declaration
	// of that name, which the engine treats as alternatives
	const specs = declaration !== undefined
		? analysis.specs.filter((entry) => entry.line === declaration.line && entry.nameColumn === declaration.character)
		: analysis.specs.filter((entry) => entry.name === name);
	md.appendMarkdown(`**$${name}**\n\n`);
	if (specs.length > 0) {
		const bodies = specs.map((spec) => inline(spec.body.trim())).join(' | ');
		const parts = [bodies, `${uses} use${uses === 1 ? '' : 's'}`];
		if (specs.length > 1) {
			parts.push(`${specs.length} declarations, alternatives`);
		}
		if (ignored) {
			parts.push('ignored');
		}
		if (builtin !== undefined) {
			parts.push(builtin.overridable ? `overrides the built-in ${name}` : `shadowed by the built-in ${name}`);
		}
		md.appendMarkdown(parts.join(' · '));
		return;
	}
	if (builtin !== undefined) {
		const parts = [builtin.summary, `${uses} use${uses === 1 ? '' : 's'}`, 'built-in'];
		if (ignored) {
			parts.push('ignored');
		}
		md.appendMarkdown(parts.join(' · '));
		return;
	}
	md.appendMarkdown(`No \`$${name}\` spec. Built-ins: ${BUILTIN_SPEC_NAMES.map((entry) => inline(entry)).join(', ')}.`);
}

/** `$$[name]` is `$[name]` with the match ignored (`Generator.cs` maps `$$` to `Ignored`). */
function isIgnoredReserved(tokens: SyntaxToken[], index: number): boolean {
	for (let back = index - 1; back >= 0 && tokens[back].rule === 'reserved' && tokens[back].line === tokens[index].line; back--) {
		if (tokens[back].leaf === 'dollar') {
			return tokens[back].value.startsWith('$$');
		}
	}
	return false;
}

function appendAffix(md: vscode.MarkdownString, raw: string): void {
	const meaning = affixMeaning(raw);
	const parts = [inline(raw), meaning.repetition];
	if (meaning.ignored) {
		parts.push('ignored');
	}
	md.appendMarkdown(parts.join(' · '));
}

/** What a repeat/ignore suffix means: `?` -> zero or one, `:` -> ignored one, `1-3` -> 1 to 3. */
function affixMeaning(raw: string): { repetition: string; ignored: boolean } {
	let suffix = raw;
	let ignored = false;
	if (suffix.startsWith(':')) {
		ignored = true;
		suffix = suffix.slice(1);
	}
	if (suffix === '' || suffix === '_' || suffix === ':') {
		return { repetition: 'one match', ignored: true };
	}
	if (suffix === '?') {
		return { repetition: 'zero or one', ignored };
	}
	if (suffix === '+') {
		return { repetition: 'one or more', ignored };
	}
	if (suffix === '*') {
		return { repetition: 'zero or more', ignored };
	}
	const range = /^(\d+)(?:-(\d+))?$/.exec(suffix);
	const repetition = range === null ? suffix : range[2] === undefined ? `exactly ${range[1]}` : `${range[1]} to ${range[2]}`;
	return { repetition, ignored };
}

/**
 * `name:(body)suffix`: hovering either paren reports the label, the group's own text and the
 * repetition that follows it, so the parentheses - which the label's own hover does not touch -
 * still say what the group does.
 */
function appendGroup(md: vscode.MarkdownString, document: vscode.TextDocument, tokens: SyntaxToken[], index: number): void {
	const openIndex = tokens[index].leaf === 'lparen' ? index : matchingParen(tokens, index);
	const closeIndex = tokens[index].leaf === 'rparen' ? index : matchingParen(tokens, index);
	const open = tokens[openIndex];
	const close = tokens[closeIndex];
	const parts: string[] = [];
	const label = groupLabel(tokens, openIndex);
	parts.push(label === undefined ? '`(...)` group' : `**${label}** group`);
	if (open.line === close.line && close.character > open.character + open.length) {
		const body = document.lineAt(open.line).text.slice(open.character + open.length, close.character).trim();
		if (body !== '') {
			parts.push(inline(body));
		}
	}
	const suffix = tokens[closeIndex + 1];
	if (suffix !== undefined && suffix.rule === 'suffix' && suffix.leaf === 'affix') {
		const meaning = affixMeaning(suffix.value);
		parts.push(meaning.repetition);
		if (meaning.ignored) {
			parts.push('ignored');
		}
	}
	md.appendMarkdown(parts.join(' · '));
}

/** `[a | b]` is an option; the brackets report that and how many branches it holds. */
function appendOption(md: vscode.MarkdownString, tokens: SyntaxToken[], index: number, lookahead: boolean): void {
	const parts = [lookahead ? '`[...]` optional lookahead' : '`[...]` optional'];
	const branches = branchCount(tokens, index);
	if (branches > 1) {
		parts.push(`${branches} branches`);
	}
	md.appendMarkdown(parts.join(' · '));
}

/** The `word:` that labels the group whose `(` is at `openIndex`, if any. */
function groupLabel(tokens: SyntaxToken[], openIndex: number): string | undefined {
	const colon = tokens[openIndex - 1];
	const word = tokens[openIndex - 2];
	if (colon?.rule !== 'group' || colon.leaf !== ':' || word?.rule !== 'group' || word.leaf !== 'word') {
		return undefined;
	}
	return word.value;
}

/** Index of the paren matching the one at `index`; `index` itself when it has no partner. */
function matchingParen(tokens: SyntaxToken[], index: number): number {
	return matching(tokens, index, 'lparen', 'rparen');
}

/** Index of the bracket matching the one at `index`; `index` itself when it has no partner. */
function matchingBracket(tokens: SyntaxToken[], index: number): number {
	return matching(tokens, index, 'lbracket', 'rbracket');
}

function matching(tokens: SyntaxToken[], index: number, openLeaf: string, closeLeaf: string): number {
	const step = tokens[index].leaf === openLeaf ? 1 : -1;
	let depth = 0;
	for (let i = index; i >= 0 && i < tokens.length; i += step) {
		const leaf = tokens[i].leaf;
		if (leaf === openLeaf) {
			depth++;
		} else if (leaf === closeLeaf) {
			depth--;
		}
		if (depth === 0) {
			return i;
		}
	}
	return index;
}

/** `[a | b | c]` -> 3; nested optionals and `$[...]` specs do not count as branches. */
function branchCount(tokens: SyntaxToken[], index: number): number {
	const partner = matchingBracket(tokens, index);
	const from = Math.min(index, partner);
	const to = Math.max(index, partner);
	let depth = 0;
	let pipes = 0;
	for (let i = from; i <= to; i++) {
		const leaf = tokens[i].leaf;
		if (leaf === 'lbracket') {
			depth++;
		} else if (leaf === 'rbracket') {
			depth--;
		} else if (leaf === 'pipe' && depth === 1) {
			pipes++;
		}
	}
	return pipes + 1;
}

function appendLookahead(md: vscode.MarkdownString, bracketed: boolean): void {
	md.appendMarkdown(bracketed ? '`@>>` lookahead, zero width' : '`@>` lookahead, zero width');
}

/** The body text after `@name:` on the definition's line, starting after the name token. */
function bodyAt(document: vscode.TextDocument, line: number, from: number): string {
	if (line >= document.lineCount) {
		return '';
	}
	return document.lineAt(line).text.slice(from).replace(/^[^:]*:\s*/, '').trim();
}

function isSingle(rule: RuleGrammarStats): boolean {
	return rule.low === 1 && rule.high === 1;
}

function inline(text: string): string {
	return `\`${text.replace(/`/g, '\\`')}\``;
}
