import * as vscode from 'vscode';
import { engineSpec, specKindName, specShape, specSummary } from './builtins';
import type { GrammarStats, SyntaxToken } from './engine';
import type { Analysis, Anchor, Spec } from './highlight';
import { inlineCode, ruleFacts, sentence } from './format';

/** A group or option the cursor is inside; only the innermost one is reported. */
interface Scope {
	kind: 'group' | 'option';
	label?: string;
	/** index of the opening token, so its matching close can be found */
	open: number;
}

/**
 * One muted hint on the active line. Specs report their expected type and description, groups and
 * options report the construct the cursor is inside, and rule lines report the rule's facts.
 */
export function collectInlayHints(
	document: vscode.TextDocument,
	analysis: Analysis,
	stats: GrammarStats | undefined,
	range: vscode.Range,
	cursor: vscode.Position,
	token: vscode.CancellationToken,
): vscode.InlayHint[] {
	if (token.isCancellationRequested || cursor.line < range.start.line || cursor.line > range.end.line) {
		return [];
	}
	const line = cursor.line;
	if (line >= document.lineCount) {
		return [];
	}
	const text = document.lineAt(line).text;
	if (text.trim() === '') {
		return [];
	}
	const spec = analysis.specs.find((entry) => entry.line === line);
	if (spec !== undefined) {
		return [specHint(document, spec)];
	}
	const scope = scopeAt(analysis.tokens, cursor);
	if (scope !== undefined) {
		return [scopeHint(document, line, scope)];
	}
	const definition = analysis.definitions.find((entry) => entry.line === line);
	if (definition !== undefined) {
		return [ruleHint(document, analysis, stats, line, definition)];
	}
	return [];
}

/**
 * The text the current-line hint is talking about. The declaration stands in for a spec, the name
 * for a rule, and a group/option is marked by its label, opening bracket and matching close.
 */
export function activeRanges(document: vscode.TextDocument, analysis: Analysis, cursor: vscode.Position): vscode.Range[] {
	if (cursor.line >= document.lineCount) {
		return [];
	}
	const text = document.lineAt(cursor.line).text;
	if (text.trim() === '') {
		return [];
	}
	const spec = analysis.specs.find((entry) => entry.line === cursor.line);
	if (spec !== undefined) {
		return [new vscode.Range(spec.line, spec.column, spec.line, spec.column + spec.size)];
	}
	const scope = scopeAt(analysis.tokens, cursor);
	if (scope !== undefined) {
		return scopeRanges(analysis.tokens, scope);
	}
	const definition = analysis.definitions.find((entry) => entry.line === cursor.line);
	if (definition !== undefined) {
		const start = definition.column > 0 && text[definition.column - 1] === '@'
			? definition.column - 1
			: definition.column;
		return [new vscode.Range(definition.line, start, definition.line, definition.column + definition.size)];
	}
	return [];
}

/** The opening label/bracket and, when it is already there, the matching close. */
function scopeRanges(tokens: SyntaxToken[], scope: Scope): vscode.Range[] {
	const open = tokens[scope.open];
	if (open === undefined) {
		return [];
	}
	let start = open.character;
	if (scope.kind === 'group' && scope.label !== undefined) {
		const word = tokens[scope.open - 2];
		if (word !== undefined && word.line === open.line) {
			start = word.character;
		}
	}
	const ranges = [new vscode.Range(open.line, start, open.line, open.character + open.length)];
	const close = matchingClose(tokens, scope);
	if (close !== undefined) {
		ranges.push(new vscode.Range(close.line, close.character, close.line, close.character + close.length));
	}
	return ranges;
}

/** The same-rule token that closes `scope`, if the construct is complete. */
function matchingClose(tokens: SyntaxToken[], scope: Scope): SyntaxToken | undefined {
	const rule = scope.kind === 'group' ? 'group' : 'optional';
	const openLeaf = scope.kind === 'group' ? 'lparen' : 'lbracket';
	const closeLeaf = scope.kind === 'group' ? 'rparen' : 'rbracket';
	let depth = 0;
	for (let index = scope.open; index < tokens.length; index++) {
		const token = tokens[index];
		if (token.rule !== rule) {
			continue;
		}
		if (token.leaf === openLeaf) {
			depth++;
		} else if (token.leaf === closeLeaf) {
			depth--;
			if (depth === 0) {
				return token;
			}
		}
	}
	return undefined;
}

function specHint(document: vscode.TextDocument, spec: Spec): vscode.InlayHint {
	const shape = specShape(spec.name, spec.body);
	const type = specKindName(shape.kind);
	const summary = specSummary(spec.name);
	const hint = hintAtEnd(document, spec.line, summary === undefined ? type : `${type} · ${summary}`, vscode.InlayHintKind.Type);
	const engine = engineSpec(spec.name);
	const tooltip = new vscode.MarkdownString();
	tooltip.appendMarkdown(`Expected: ${inlineCode(type)}.`);
	if (summary !== undefined) {
		tooltip.appendMarkdown(`\n\n${sentence(summary)}`);
	}
	if (engine?.kind === 'number' && engine.default !== undefined) {
		tooltip.appendMarkdown(`\n\nDefault: ${inlineCode(engine.default)}.`);
	}
	if (engine?.kind === 'enum' && engine.values !== undefined) {
		tooltip.appendMarkdown(`\n\nOne of ${engine.values.map(inlineCode).join(', ')}.`);
	}
	hint.tooltip = tooltip;
	return hint;
}

function ruleHint(document: vscode.TextDocument, analysis: Analysis, stats: GrammarStats | undefined, line: number, definition: Anchor): vscode.InlayHint {
	const rule = stats?.rules.find((entry) => entry.name === definition.name);
	const uses = analysis.references.reduce((count, reference) => reference.name === definition.name ? count + 1 : count, 0);
	const parts = ['rule', ...(rule === undefined ? [] : ruleFacts(rule))];
	if (uses > 0) {
		parts.push(`${uses} reference${uses === 1 ? '' : 's'}`);
	}
	const hint = hintAtEnd(document, line, parts.join(' · '));
	hint.tooltip = new vscode.MarkdownString(`Rule ${inlineCode(`@${definition.name}`)}.`);
	return hint;
}

function scopeHint(document: vscode.TextDocument, line: number, scope: Scope): vscode.InlayHint {
	const label = scope.kind === 'group' && scope.label !== undefined ? `group: ${scope.label}` : scope.kind;
	const hint = hintAtEnd(document, line, label);
	hint.tooltip = new vscode.MarkdownString(scope.kind === 'group'
		? 'Group'
		: 'Option: alternatives are separated by `|`.');
	return hint;
}

/** The innermost group/option that opened before the cursor and has not closed yet. */
function scopeAt(tokens: SyntaxToken[], cursor: vscode.Position): Scope | undefined {
	const stack: { kind: 'group' | 'option'; open: number }[] = [];
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index];
		if (token.line > cursor.line || (token.line === cursor.line && token.character >= cursor.character)) {
			break;
		}
		if (token.rule === 'group') {
			if (token.leaf === 'lparen') {
				stack.push({ kind: 'group', open: index });
			} else if (token.leaf === 'rparen') {
				stack.pop();
			}
		} else if (token.rule === 'optional') {
			if (token.leaf === 'lbracket') {
				stack.push({ kind: 'option', open: index });
			} else if (token.leaf === 'rbracket') {
				stack.pop();
			}
		}
	}
	const top = stack[stack.length - 1];
	if (top === undefined) {
		return undefined;
	}
	if (top.kind === 'group') {
		const open = tokens[top.open];
		const colon = tokens[top.open - 1];
		const word = tokens[top.open - 2];
		if (word?.rule === 'group' && word.leaf === 'word' && colon?.leaf === ':' && colon.line === open.line) {
			return { kind: 'group', label: word.value, open: top.open };
		}
	}
	return { kind: top.kind, open: top.open };
}

/** Move an existing hint to the current end of `line`, so cached details follow the text. */
export function repositionHint(document: vscode.TextDocument, line: number, hint: vscode.InlayHint): vscode.InlayHint {
	const moved = hintAtEnd(document, line, hint.label, hint.kind);
	moved.tooltip = hint.tooltip;
	moved.paddingLeft = hint.paddingLeft;
	moved.paddingRight = hint.paddingRight;
	return moved;
}

/**
 * Place the hint at the true end of the line. Trimming trailing whitespace put the hint before
 * the cursor whenever the line ended in spaces, so the cursor appeared to the right of it.
 */
function hintAtEnd(document: vscode.TextDocument, line: number, label: string | vscode.InlayHintLabelPart[], kind?: vscode.InlayHintKind): vscode.InlayHint {
	const text = document.lineAt(line).text;
	const hint = new vscode.InlayHint(new vscode.Position(line, text.length), label, kind);
	hint.paddingLeft = true;
	return hint;
}
