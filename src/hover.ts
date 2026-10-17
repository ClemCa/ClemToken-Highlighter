import * as vscode from 'vscode';
import { builtinSpec, BUILTIN_SPEC_NAMES, builtinStatus, engineSpec, isEngineSpec, specKindName, specShape, specSummary } from './builtins';
import { GrammarStats, SyntaxToken } from './engine';
import { Analysis, Spec } from './highlight';
import type { SpacingModifier } from './spacing';
import { escapeAttribute, inlineCode, ruleFacts, sentence } from './format';
import { affixOf, affixRepetition } from './affix';
import { isReference, tokensOnLine } from './syntax';
import { specBodyParts, specUses } from './specs';
import { regexExamples } from './regexPreview';
import { ruleSummary, optionSummary } from './summary';
import type { SummaryPalette } from './summary';

/**
 * Hover for a `.ct` grammar. The engine's tokens say what the token under the cursor is; the static
 * grammar stats say what the named rule expands to. Whole constructs (`$[spec]`, `@rule`, a
 * reference, a lookahead) are resolved before individual tokens, so every part of one construct
 * reports the same thing.
 */
export function provideHover(
	document: vscode.TextDocument,
	analysis: Analysis,
	stats: GrammarStats | undefined,
	position: vscode.Position,
): vscode.Hover | undefined {
	const construct = constructHover(document, analysis, stats, position);
	if (construct !== undefined) {
		return construct;
	}
	const index = tokenIndexAt(analysis.tokens, position);
	if (index === -1) {
		return undefined;
	}
	const token = analysis.tokens[index];
	const previous = index > 0 ? analysis.tokens[index - 1] : undefined;
	const md = markdown();

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
			break;

		case 'named_reference':
		case 'named_optional_reference':
			if (token.leaf === 'word' && previous !== undefined && previous.leaf === 'at') {
				appendReference(md, document, analysis, stats, token.value);
				return hover(md, token);
			}
			break;

		case 'reserved':
			if (token.leaf === 'word') {
				const ignored = isIgnoredReserved(analysis.tokens, index);
				appendSpec(md, analysis, token.value, analysis.specs.filter((entry) => entry.name === token.value), ignored, `${ignored ? '$$' : '$'}[${token.value}]`);
				return hover(md, token);
			}
			break;

		case 'specline':
			if (token.leaf === 'word') {
				const spec = analysis.specs.find((entry) => entry.line === token.line && entry.nameColumn === token.character);
				if (spec !== undefined) {
					appendSpec(md, analysis, spec.name, [spec], false, `$${spec.name}:`);
					return hover(md, token);
				}
			}
			break;

		case 'suffix': {
			const target = affixTarget(document, analysis.tokens, index);
			if (target === undefined) {
				return undefined;
			}
			appendAffix(md, token.value, target);
			return hover(md, token);
		}

		case 'optional':
		case 'optional_lookahead':
			if (token.leaf === 'affix') {
				const target = affixTarget(document, analysis.tokens, index);
				if (target === undefined) {
					return undefined;
				}
				appendAffix(md, token.value, target);
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

		case 'group':
			if (token.leaf === 'word' || token.leaf === ':') {
				const open = token.leaf === 'word' ? index + 2 : index + 1;
				const openToken = analysis.tokens[open];
				const label = analysis.tokens[index - 1];
				if (openToken !== undefined && openToken.leaf === 'lparen') {
					appendGroup(md, document, analysis.tokens, open);
					const start = token.leaf === 'word' ? token.character : label?.character ?? token.character;
					return hoverRange(md, token.line, start, openToken.character + openToken.length);
				}
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

/** A construct whose whole span reports one hover, even on its delimiters or whitespace. */
function constructHover(document: vscode.TextDocument, analysis: Analysis, stats: GrammarStats | undefined, position: vscode.Position): vscode.Hover | undefined {
	if (position.line >= document.lineCount) {
		return undefined;
	}
	const lineText = document.lineAt(position.line).text;
	const lookahead = lookaheadAt(analysis.tokens, position, lineText);
	if (lookahead !== undefined) {
		const md = markdown();
		appendLookaheadSummary(md, lookahead, analysis.tokens, lineText);
		return hoverRange(md, position.line, lookahead.start, lookahead.end);
	}
	const option = optionAt(analysis.tokens, position);
	if (option !== undefined) {
		const md = markdown();
		md.supportHtml = true;
		appendOptionSummary(md, document, analysis, stats, option);
		return hoverRange(md, position.line, option.start, option.end);
	}
	const spacing = spacingAt(analysis, position);
	if (spacing !== undefined) {
		const md = markdown();
		appendSpacing(md, spacing);
		return hoverRange(md, position.line, spacing.character, spacing.character + spacing.length);
	}
	const reserved = reservedAt(analysis.tokens, position);
	if (reserved !== undefined) {
		const md = markdown();
		const display = `${reserved.ignored ? '$$' : '$'}[${reserved.name}]`;
		appendSpec(md, analysis, reserved.name, analysis.specs.filter((entry) => entry.name === reserved.name), reserved.ignored, display);
		return hoverRange(md, position.line, reserved.start, reserved.end);
	}
	const spec = specAt(analysis, position);
	if (spec !== undefined) {
		const md = markdown();
		appendSpec(md, analysis, spec.name, [spec], false, `$${spec.name}:`);
		return hoverRange(md, position.line, spec.column, spec.column + spec.size);
	}
	const specBody = specBodyAt(analysis, position);
	if (specBody !== undefined) {
		const parts = specBodyParts(specBody.body);
		const modeStart = specBody.bodyColumn + parts.modeOffset;
		const definitionStart = specBody.bodyColumn + parts.definitionOffset;
		if (parts.mode !== '' && position.character >= modeStart && position.character < modeStart + parts.modeLength) {
			const md = markdown();
			appendSpecMode(md, specBody.name, parts.mode);
			return hoverRange(md, position.line, modeStart, modeStart + parts.modeLength);
		}
		if (parts.definition !== '' && position.character >= definitionStart && position.character < definitionStart + parts.definitionLength) {
			const md = markdown();
			appendSpecBody(md, analysis, specBody, parts.definition);
			return hoverRange(md, position.line, definitionStart, definitionStart + parts.definitionLength);
		}
	}
	const rule = ruleAt(analysis.tokens, position);
	if (rule !== undefined) {
		const md = markdown();
		appendRule(md, document, analysis, stats, rule.word);
		return hoverRange(md, position.line, rule.start, rule.end);
	}
	const reference = referenceAt(analysis.tokens, position);
	if (reference !== undefined) {
		const md = markdown();
		appendReference(md, document, analysis, stats, reference.name, reference.label);
		return hoverRange(md, position.line, reference.start, reference.end);
	}
	return undefined;
}

interface LookaheadInfo {
	line: number;
	start: number;
	end: number;
	open: number;
	close: number;
	bracketed: boolean;
	text: string;
}

/** The outermost lookahead whose span contains `position`, if any: its contents are all text. */
function lookaheadAt(tokens: SyntaxToken[], position: vscode.Position, lineText: string): LookaheadInfo | undefined {
	let best: LookaheadInfo | undefined;
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index];
		if (token.line !== position.line) {
			continue;
		}
		if (token.rule === 'plain_lookahead' && token.leaf === 'at') {
			const end = plainLookaheadEnd(tokens, index);
			if (end !== undefined && position.character >= token.character && position.character < end && (best === undefined || token.character < best.start)) {
				best = { line: position.line, start: token.character, end, open: token.character, close: end, bracketed: false, text: lineText.slice(token.character, end) };
			}
		} else if (token.rule === 'optional_lookahead' && token.leaf === 'at') {
			const range = optionalLookaheadRange(tokens, index);
			if (range !== undefined && position.character >= range.start && position.character < range.end && (best === undefined || range.start < best.start)) {
				best = { ...range, line: position.line, bracketed: true, text: lineText.slice(range.start, range.end) };
			}
		}
	}
	return best;
}

function plainLookaheadEnd(tokens: SyntaxToken[], index: number): number | undefined {
	const line = tokens[index].line;
	for (let i = index + 1; i < tokens.length && tokens[i].line === line; i++) {
		if (tokens[i].rule === 'plain_lookahead' && tokens[i].leaf === 'probe') {
			return tokens[i].character + tokens[i].length;
		}
	}
	return undefined;
}

function optionalLookaheadRange(tokens: SyntaxToken[], index: number): { start: number; end: number; open: number; close: number } | undefined {
	const line = tokens[index].line;
	let openIndex = -1;
	for (let i = index + 1; i < tokens.length && tokens[i].line === line; i++) {
		if (tokens[i].rule === 'optional_lookahead' && tokens[i].leaf === 'lbracket') {
			openIndex = i;
			break;
		}
	}
	if (openIndex === -1) {
		return undefined;
	}
	let depth = 1;
	for (let i = openIndex + 1; i < tokens.length && tokens[i].line === line; i++) {
		const token = tokens[i];
		if (token.leaf === 'lbracket') {
			depth++;
		} else if (token.leaf === 'rbracket') {
			depth--;
			if (depth === 0) {
				return { start: tokens[index].character, end: token.character + token.length, open: tokens[openIndex].character, close: token.character };
			}
		}
	}
	return undefined;
}

interface OptionInfo {
	start: number;
	end: number;
	open: number;
}

/** The outermost option whose brackets contain `position`; its contents report one summary. */
function optionAt(tokens: SyntaxToken[], position: vscode.Position): OptionInfo | undefined {
	let best: OptionInfo | undefined;
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index];
		if (token.line !== position.line || token.rule !== 'optional' || token.leaf !== 'lbracket') {
			continue;
		}
		const closeIndex = matchingBracket(tokens, index);
		if (closeIndex === index) {
			continue;
		}
		const close = tokens[closeIndex];
		if (close.line !== position.line || position.character < token.character || position.character >= close.character + close.length) {
			continue;
		}
		if (best === undefined || token.character < best.start) {
			best = { start: token.character, end: close.character + close.length, open: index };
		}
	}
	return best;
}

/** Top-level `|` in a lookahead, so the summary shows its branches without parsing the text. */
function lookaheadBranches(tokens: SyntaxToken[], info: LookaheadInfo, lineText: string): string[] {
	const pipes: SyntaxToken[] = [];
	let depth = 0;
	for (const token of tokens) {
		if (token.line !== info.line || token.character <= info.open || token.character >= info.close) {
			continue;
		}
		if (token.leaf === 'lbracket') {
			depth++;
		} else if (token.leaf === 'rbracket') {
			depth--;
		} else if (token.leaf === 'pipe' && depth === 0 && token.rule === 'optional_lookahead') {
			pipes.push(token);
		}
	}
	const branches: string[] = [];
	let start = info.open + 1;
	for (const pipe of pipes) {
		branches.push(lineText.slice(start, pipe.character).trim());
		start = pipe.character + pipe.length;
	}
	branches.push(lineText.slice(start, info.close).trim());
	return branches;
}

function appendLookaheadSummary(md: vscode.MarkdownString, info: LookaheadInfo, tokens: SyntaxToken[], lineText: string): void {
	if (!info.bracketed) {
		const probe = info.text.replace(/^@>\s*/, '').trim();
		md.appendMarkdown(`**@>** lookahead · zero width\n\nLooks for ${inlineCode(probe)}.`);
		return;
	}
	const branches = lookaheadBranches(tokens, info, lineText);
	md.appendMarkdown(`**@>>** optional lookahead · zero width`);
	if (branches.length > 1) {
		md.appendMarkdown(` · ${branches.length} branches`);
	}
	const body = branches.length === 1
		? `@>>[ ${branches[0]} ]`
		: `@>>[\n${branches.map((entry, index) => `${index === 0 ? '  ' : '  | '}${entry}`).join('\n')}\n]`;
	md.appendMarkdown(`\n\n\`\`\`text\n${body}\n\`\`\``);
}

interface ReservedInfo {
	start: number;
	end: number;
	name: string;
	ignored: boolean;
}

function reservedAt(tokens: SyntaxToken[], position: vscode.Position): ReservedInfo | undefined {
	const line = tokensOnLine(tokens, position.line);
	for (let index = 0; index < line.length; index++) {
		const token = line[index];
		if (token.rule !== 'reserved' || token.leaf !== 'dollar') {
			continue;
		}
		let end = token;
		let name = '';
		for (let i = index + 1; i < line.length && line[i].rule === 'reserved'; i++) {
			end = line[i];
			if (line[i].leaf === 'word') {
				name = line[i].value;
			}
			if (line[i].leaf === 'rbracket') {
				break;
			}
		}
		const start = token.character;
		const stop = end.character + end.length;
		if (position.character >= start && position.character < stop) {
			return { start, end: stop, name, ignored: token.value.startsWith('$$') };
		}
	}
	return undefined;
}

function specAt(analysis: Analysis, position: vscode.Position): Spec | undefined {
	return analysis.specs.find((spec) => spec.line === position.line && position.character >= spec.column && position.character < spec.column + spec.size);
}

/** The body after `$name:`, so the regex or literal is hoverable too. */
function specBodyAt(analysis: Analysis, position: vscode.Position): Spec | undefined {
	return analysis.specs.find((spec) =>
		spec.line === position.line
		&& spec.bodySize > 0
		&& position.character >= spec.bodyColumn
		&& position.character < spec.bodyColumn + spec.bodySize);
}

function spacingAt(analysis: Analysis, position: vscode.Position): SpacingModifier | undefined {
	return analysis.spacing.find((modifier) => modifier.line === position.line && position.character >= modifier.character && position.character < modifier.character + modifier.length);
}

/** `$explicit:` disables implicit whitespace skipping; `$implicit:` turns it back on. */
function appendSpacing(md: vscode.MarkdownString, modifier: SpacingModifier): void {
	const target = modifier.target === '@' ? 'anchor or reference' : modifier.target === '(' ? 'group' : 'option';
	const effect = modifier.mode === 'explicit'
		? 'Disables implicit whitespace skipping'
		: 'Re-enables implicit whitespace skipping';
	md.appendMarkdown(`**${modifier.text}** spacing modifier`);
	if (modifier.shorthand) {
		md.appendMarkdown(' · shorthand for `$explicit:`');
	}
	md.appendMarkdown(`\n\n${effect} for the following ${target}.`);
}

interface RuleInfo {
	start: number;
	end: number;
	word: SyntaxToken;
}

function ruleAt(tokens: SyntaxToken[], position: vscode.Position): RuleInfo | undefined {
	const line = tokensOnLine(tokens, position.line);
	const at = line.find((token) => (token.rule === 'ruleline' || token.rule === 'ruleline_final') && token.leaf === '@');
	if (at === undefined) {
		return undefined;
	}
	const word = line.find((token) => (token.rule === 'ruleline' || token.rule === 'ruleline_final') && token.leaf === 'word' && token.character > at.character);
	if (word === undefined) {
		return undefined;
	}
	const colon = line.find((token) => (token.rule === 'ruleline' || token.rule === 'ruleline_final') && token.leaf === ':' && token.character > word.character);
	if (colon === undefined) {
		return undefined;
	}
	const start = at.character;
	const end = colon.character + colon.length;
	return position.character >= start && position.character < end ? { start, end, word } : undefined;
}

interface ReferenceInfo {
	start: number;
	end: number;
	name: string;
	label?: string;
}

function referenceAt(tokens: SyntaxToken[], position: vscode.Position): ReferenceInfo | undefined {
	const line = tokensOnLine(tokens, position.line);
	for (let index = 0; index < line.length; index++) {
		const at = line[index];
		if (at.leaf !== 'at' || !isReference(at)) {
			continue;
		}
		const rule = at.rule ?? '';
		let startIndex = index;
		if (rule === 'optional_reference' && line[index - 1]?.leaf === 'qmark' && line[index - 1].rule === rule) {
			startIndex = index - 1;
		} else if (rule === 'named_reference' && line[index - 1]?.leaf === ':' && line[index - 1].rule === rule && line[index - 2]?.leaf === 'word' && line[index - 2].rule === rule) {
			startIndex = index - 2;
		} else if (rule === 'named_optional_reference' && line[index - 1]?.leaf === 'qmark' && line[index - 2]?.leaf === ':' && line[index - 3]?.leaf === 'word' && line[index - 3].rule === rule) {
			startIndex = index - 3;
		}
		const nameToken = line.slice(index + 1).find((token) => token.rule === rule && token.leaf === 'word');
		if (nameToken === undefined) {
			continue;
		}
		const start = line[startIndex].character;
		const end = nameToken.character + nameToken.length;
		if (position.character >= start && position.character < end) {
			const label = rule.startsWith('named') ? line[startIndex].value : undefined;
			return { start, end, name: nameToken.value, label };
		}
		index = line.indexOf(nameToken);
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

function markdown(): vscode.MarkdownString {
	const md = new vscode.MarkdownString();
	md.isTrusted = true;
	return md;
}

function hover(md: vscode.MarkdownString, token: SyntaxToken): vscode.Hover {
	return new vscode.Hover(md, new vscode.Range(token.line, token.character, token.line, token.character + token.length));
}

function hoverRange(md: vscode.MarkdownString, line: number, start: number, end: number): vscode.Hover {
	return new vscode.Hover(md, new vscode.Range(line, start, line, end));
}

function appendRule(md: vscode.MarkdownString, document: vscode.TextDocument, analysis: Analysis, stats: GrammarStats | undefined, token: SyntaxToken): void {
	const name = token.value;
	const uses = analysis.references.filter((ref) => ref.name === name).length;
	const palette = summaryPalette();
	md.supportHtml = true;
	md.appendMarkdown(`<strong><span style="color:${escapeAttribute(palette.anchor)};">@${name}</span></strong>\n\n`);
	md.appendMarkdown(ruleLine(stats, name, `${uses} reference${uses === 1 ? '' : 's'}`));
	const summary = ruleSummary(document, analysis, stats, token, palette);
	if (summary !== undefined) {
		md.appendMarkdown(`\n\n${summary}`);
		return;
	}
	const body = bodyAt(document, token.line, token.character + token.length);
	if (body) {
		md.appendMarkdown(`\n\n${inlineCode(body)}`);
	}
}

function summaryPalette(): SummaryPalette {
	const configuration = vscode.workspace.getConfiguration('clemtoken');
	return {
		name: configuration.get('nameColor', '#808080'),
		affix: configuration.get('affixColor', '#FF69B4'),
		keyword: configuration.get('keywordColor', '#4a9d4cff'),
		literal: 'var(--vscode-editor-foreground)',
		selector: configuration.get('selectorColor', '#4EC9B0'),
		anchor: configuration.get('anchorColor', '#569CD6'),
		anchorBase: configuration.get('anchorBaseColor', '#8EB5D4'),
		optional: configuration.get('optionalColor', '#FFB6C1'),
		lookahead: configuration.get('lookaheadColor', '#209b49'),
		lookaheadText: configuration.get('lookaheadTextColor', '#31f227'),
		brackets: configuration.get<string[]>('bracketColors', []) ?? [],
	};
}

function appendReference(md: vscode.MarkdownString, document: vscode.TextDocument, analysis: Analysis, stats: GrammarStats | undefined, name: string, label?: string): void {
	const definition = analysis.definitions.find((entry) => entry.name === name);
	if (definition === undefined) {
		md.appendMarkdown(`**@${name}**\n\nNo \`@${name}\` rule.`);
		if (label !== undefined) {
			md.appendMarkdown(`\n\n\`${label}:\` reference label`);
		}
		return;
	}
	md.appendMarkdown(`**@${name}** line ${definition.line + 1}\n\n`);
	md.appendMarkdown(ruleLine(stats, name));
	if (label !== undefined) {
		md.appendMarkdown(`\n\n\`${label}:\` reference label`);
	}
	const args = encodeURIComponent(JSON.stringify([document.uri.toString(), definition.line, definition.column]));
	md.appendMarkdown(`\n\n[Go to definition](command:clemtoken.revealDefinition?${args})`);
}

/** `Anchor · 1..∞ symbols · recursive · 2 references`, skipping whatever is unknown. */
function ruleLine(stats: GrammarStats | undefined, name: string, tail?: string): string {
	const rule = stats?.rules.find((entry) => entry.name === name);
	const parts = rule === undefined ? [] : ruleFacts(rule);
	if (tail !== undefined) {
		parts.push(tail);
	}
	return parts.join(' · ');
}

function appendSpec(md: vscode.MarkdownString, analysis: Analysis, name: string, specs: Spec[], ignored: boolean, display: string): void {
	// lookahead branches are literal text, so a `$[name]` there is not a use of the spec
	const uses = specUses(analysis).get(name) ?? 0;
	const useCount = `${uses} use${uses === 1 ? '' : 's'}`;
	const builtin = builtinSpec(name);
	const engine = isEngineSpec(name);
	const summary = specSummary(name);
	md.appendMarkdown(`**${display}**\n\n`);
	if (specs.length > 0) {
		const bodies = specs.map((spec) => spec.body.trim() === '' ? 'empty' : inlineCode(spec.body.trim())).join(' | ');
		const shapes = specs.map((spec) => specShape(name, spec.body));
		const kinds = [...new Set(shapes.map((shape) => specKindName(shape.kind)))];
		// an unreferenced declaration is unused; built-ins and engine specs always have a purpose
		const parts = [bodies];
		if (kinds.length === 1) {
			parts.push(kinds[0]);
		}
		parts.push(uses === 0 && builtin === undefined && !engine ? 'unused' : useCount);
		if (specs.length > 1) {
			parts.push(`${specs.length} declarations, alternatives`);
		}
		if (ignored) {
			parts.push('ignored');
		}
		if (builtin !== undefined || engine) {
			parts.push(builtinStatus(name));
		}
		md.appendMarkdown(parts.join(' · '));
		if (summary !== undefined) {
			md.appendMarkdown(`\n\n${sentence(summary)}`);
		} else if (shapes.some((shape) => shape.kind === 'regex')) {
			md.appendMarkdown('\n\nMatches as a regular expression.');
		}
		if (shapes.some((shape) => shape.kind === 'regex')) {
			appendRegexExamples(md, shapes.filter((shape) => shape.kind === 'regex').map((shape) => shape.pattern));
		}
		return;
	}
	if (builtin !== undefined) {
		const parts = [builtin.summary, useCount, 'built-in'];
		if (ignored) {
			parts.push('ignored');
		}
		md.appendMarkdown(parts.join(' · '));
		if (builtin.kind === 'regex') {
			appendRegexExamples(md, [builtin.pattern]);
		}
		return;
	}
	md.appendMarkdown(`No \`$${name}\` spec. Built-ins: ${BUILTIN_SPEC_NAMES.map((entry) => inlineCode(`$[${entry}]`)).join(', ')}.`);
}

/** Hover for the `simple:` / `regex:` prefix of a spec body. */
function appendSpecMode(md: vscode.MarkdownString, name: string, mode: string): void {
	const engine = engineSpec(name);
	md.appendMarkdown(`**${mode}** mode · ${inlineCode(`$${name}`)}`);
	if (engine !== undefined && (engine.kind === 'number' || engine.kind === 'enum')) {
		md.appendMarkdown(`\n\nThe engine reads this spec's definition as a ${engine.kind}, so the mode is ignored.`);
		return;
	}
	md.appendMarkdown(mode === 'simple'
		? '\n\nThe definition is matched literally.'
		: '\n\nThe definition is matched as a regular expression.');
}

/** Hover for the definition itself, with examples that fit its number/enum/simple/regex shape. */
function appendSpecBody(md: vscode.MarkdownString, analysis: Analysis, spec: Spec, definition: string): void {
	const uses = specUses(analysis).get(spec.name) ?? 0;
	const useCount = `${uses} use${uses === 1 ? '' : 's'}`;
	const builtin = builtinSpec(spec.name);
	const engine = engineSpec(spec.name);
	const shadowed = builtin !== undefined && !builtin.overridable;
	if (shadowed) {
		md.appendMarkdown(`**${inlineCode(definition)}** shadowed declaration\n\n`);
		md.appendMarkdown(`The built-in ${inlineCode(`$${spec.name}`)} matches ${builtin.summary}.`);
		if (builtin.kind === 'regex') {
			appendRegexExamples(md, [builtin.pattern]);
		}
		return;
	}
	const shape = specShape(spec.name, spec.body);
	const facts = [specKindName(shape.kind), inlineCode(`$${spec.name}`), useCount];
	if (engine !== undefined) {
		facts.push('engine spec');
	}
	md.appendMarkdown(`**${inlineCode(definition)}** ${facts.join(' · ')}`);
	if (engine !== undefined) {
		md.appendMarkdown(`\n\n${sentence(engine.summary)}`);
	} else if (shape.kind === 'regex') {
		md.appendMarkdown('\n\nMatches as a regular expression.');
	}
	if (shape.kind === 'regex') {
		appendRegexExamples(md, [shape.pattern]);
	}
}

/** Regex specs always get their preview values, one per line; unsupported patterns say so muted. */
function appendRegexExamples(md: vscode.MarkdownString, patterns: (string | undefined)[]): void {
	const examples = regexExamples(patterns.filter((pattern): pattern is string => pattern !== undefined));
	md.supportHtml = true;
	if (examples.length === 0) {
		md.appendMarkdown('\n\n<span style="color:var(--vscode-descriptionForeground);">cannot generate examples</span>');
		return;
	}
	const lines = examples.map((value) => JSON.stringify(value).slice(1, -1));
	const chips = lines.map((line) => `&emsp;${inlineCode(line)}`);
	md.appendMarkdown(`\n\n${chips.join('<br>')}`);
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

interface AffixTarget {
	text: string;
	kind: 'group' | 'option' | 'lookahead' | 'spec' | 'reference' | 'literal';
}

function appendAffix(md: vscode.MarkdownString, raw: string, target: AffixTarget | undefined): void {
	const parts = [inlineCode(raw), ...affixDescription(raw)];
	if (target !== undefined) {
		parts.push(`repeats ${targetLabel(target)}`);
	}
	md.appendMarkdown(parts.join(' · '));
}

/** The meaning of a suffix, shared by affix and group hovers. */
function affixDescription(raw: string): string[] {
	const affix = affixOf(raw);
	const parts = [affixRepetition(affix)];
	if (affix.ignored) {
		parts.push('ignored');
	}
	return parts;
}

function targetLabel(target: AffixTarget): string {
	if (target.text.length > 0 && target.text.length <= 60) {
		return inlineCode(target.text);
	}
	switch (target.kind) {
		case 'group': return inlineCode('(...)');
		case 'option': return inlineCode('[...]');
		case 'lookahead': return inlineCode('@>>[...]');
		case 'spec': return inlineCode('$[...]');
		case 'reference': return inlineCode('@...');
		default: return 'the literal';
	}
}

/** What the suffix follows: a group, an option, a lookahead, a spec, a reference or a literal. */
function affixTarget(document: vscode.TextDocument, tokens: SyntaxToken[], index: number): AffixTarget | undefined {
	const token = tokens[index];
	const previous = index > 0 ? tokens[index - 1] : undefined;
	if (previous === undefined || previous.line !== token.line) {
		return undefined;
	}
	const lineText = document.lineAt(token.line).text;
	if (previous.leaf === 'rparen') {
		const open = matchingParen(tokens, index - 1);
		const label = groupLabel(tokens, open);
		const start = label !== undefined && open >= 2 ? tokens[open - 2].character : tokens[open].character;
		return { text: compress(lineText.slice(start, previous.character + previous.length)), kind: 'group' };
	}
	if (previous.leaf === 'rbracket') {
		const open = matchingBracket(tokens, index - 1);
		const openToken = tokens[open];
		let first = open;
		if (openToken.rule === 'optional_lookahead') {
			while (first > 0 && tokens[first - 1].line === token.line && tokens[first - 1].rule === 'optional_lookahead') {
				first--;
			}
		} else if (openToken.rule === 'reserved') {
			while (first > 0 && tokens[first - 1].line === token.line && tokens[first - 1].rule === 'reserved') {
				first--;
			}
		}
		const kind: AffixTarget['kind'] = openToken.rule === 'optional' ? 'option' : openToken.rule === 'optional_lookahead' ? 'lookahead' : 'spec';
		return { text: compress(lineText.slice(tokens[first].character, previous.character + previous.length)), kind };
	}
	if (previous.leaf === 'word') {
		if (isReference(previous)) {
			const reference = referenceAt(tokens, new vscode.Position(token.line, previous.character));
			if (reference !== undefined) {
				return { text: compress(lineText.slice(reference.start, reference.end)), kind: 'reference' };
			}
		}
		if (previous.rule === 'simple' || previous.rule === 'escaped') {
			if (previous.character + previous.length < token.character) {
				return { text: previous.value, kind: 'literal' };
			}
		}
	}
	return undefined;
}

function compress(text: string): string {
	return text.replace(/\s+/g, ' ').trim();
}

/**
 * `name:(body)suffix`: hovering either paren or the label reports the label, the group's own text
 * and the repetition that follows it.
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
			parts.push(inlineCode(body));
		}
	}
	const suffix = tokens[closeIndex + 1];
	if (suffix !== undefined && suffix.rule === 'suffix' && suffix.leaf === 'affix') {
		parts.push(...affixDescription(suffix.value));
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

function appendOptionSummary(md: vscode.MarkdownString, document: vscode.TextDocument, analysis: Analysis, stats: GrammarStats | undefined, info: OptionInfo): void {
	appendOption(md, analysis.tokens, info.open, false);
	const summary = optionSummary(document, analysis, stats, info.open, summaryPalette());
	if (summary !== undefined) {
		md.appendMarkdown(`\n\n${summary}`);
	}
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

/** The body text after `@name:` on the definition's line, starting after the name token. */
function bodyAt(document: vscode.TextDocument, line: number, from: number): string {
	if (line >= document.lineCount) {
		return '';
	}
	return document.lineAt(line).text.slice(from).replace(/^[^:]*:\s*/, '').trim();
}
