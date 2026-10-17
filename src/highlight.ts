import type { SyntaxToken } from './engine';
import { isReference } from './syntax';
import { isSpacingModifier, spacingMode, spacingModifierAt, spacingTarget } from './spacing';
import type { SpacingModifier } from './spacing';
import { specBodyParts } from './specs';

/** A half-open range on one line, in the same UTF-16 units the engine reports. */
export interface Span {
	line: number;
	character: number;
	length: number;
}

/** A named anchor: a rule definition (`@name:`) or a reference to one. */
export interface Anchor {
	line: number;
	column: number;
	size: number;
	name: string;
}

/** A `(` or `)`, with its paren nesting depth (0-based) so the colours can cycle. */
export interface Bracket extends Span {
	depth: number;
}

/** A `$name: body` spec declaration, as written in the grammar. */
export interface Spec {
	name: string;
	/** the `$name:` declaration, without the body */
	line: number;
	column: number;
	size: number;
	/** the name alone, for hover */
	nameColumn: number;
	nameSize: number;
	/** the body after `$name:` */
	body: string;
	bodyColumn: number;
	bodySize: number;
}

/** One decoration bucket per coloured element, plus the anchors and specs the language providers need. */
export interface Analysis {
	title: Span[];
	keyword: Span[];
	selector: Span[];
	name: Span[];
	affix: Span[];
	anchor: Span[];
	anchorBase: Span[];
	optional: Span[];
	spec: Span[];
	specMode: Span[];
	specRegex: Span[];
	lookahead: Span[];
	lookaheadText: Span[];
	/** group parentheses, for the rainbow colouring; `[` `]` keep their own colours */
	brackets: Bracket[];
	definitions: Anchor[];
	references: Anchor[];
	specs: Spec[];
	/** `$explicit:` / `$implicit:` prefixes and the `!` shorthand */
	spacing: SpacingModifier[];
	/** the engine's tokens in source order, for position lookup (hover, CodeLens) */
	tokens: SyntaxToken[];
}

const empty = (): Analysis => ({
	title: [],
	keyword: [],
	selector: [],
	name: [],
	affix: [],
	anchor: [],
	anchorBase: [],
	optional: [],
	spec: [],
	specMode: [],
	specRegex: [],
	lookahead: [],
	lookaheadText: [],
	brackets: [],
	definitions: [],
	references: [],
	specs: [],
	spacing: [],
	tokens: [],
});

/**
 * The same character is named two ways depending on how the grammar wrote it: a bare literal keeps
 * its glyph as the leaf name (`@`, `:`, `$`), while a `$[at]`-style spec reference keeps the spec
 * name (`at`, `colon`, `dollar`). Normalising to the glyph lets one switch handle both.
 */
function glyph(token: SyntaxToken): string {
	switch (token.leaf) {
		case 'at': return '@';
		case 'qmark': return '?';
		case 'colon': return ':';
		case 'gt': return '>';
		case 'dollar': return '$';
		case 'lbracket': return '[';
		case 'rbracket': return ']';
		case 'lparen': return '(';
		case 'rparen': return ')';
		case 'pipe': return '|';
		default: return token.leaf;
	}
}

/**
 * A suffix is a modifier only when it follows a construct that can repeat. Otherwise it is literal
 * text: a leading `*` in an option branch or the `:` glued to `-` in an operator is not an affix.
 */
function isModifier(tokens: SyntaxToken[], index: number): boolean {
	const token = tokens[index];
	const previous = index > 0 ? tokens[index - 1] : undefined;
	if (previous === undefined || previous.line !== token.line) {
		return false;
	}
	if (previous.leaf === 'rparen' || previous.leaf === 'rbracket') {
		return true;
	}
	if (previous.leaf === 'word') {
		if (isReference(previous)) {
			return true;
		}
		if (previous.rule === 'simple' || previous.rule === 'escaped') {
			return previous.character + previous.length < token.character;
		}
	}
	return false;
}

const anchorOf = (token: SyntaxToken): Anchor => ({
	line: token.line,
	column: token.character,
	size: token.length,
	name: token.value,
});

/**
 * Turn the engine's token stream into decoration spans and anchor lists.
 *
 * Everything is driven by the token's nearest enclosing rule, which is the grammar's own taxonomy,
 * so there is no box-drawing regex to get confused by nested groups, escapes or glued suffixes.
 * Rules the editor does not colour (`simple` keywords, `escaped`, `close_paren`) fall through.
 */
export function analyze(text: string, tokens: SyntaxToken[]): Analysis {
	const result = empty();
	const lines = text.split(/\r?\n/);
	const ordered = [...tokens].sort((a, b) => a.line - b.line || a.character - b.character);
	// `@>>[a | b]` hands the branch elements to their own rules, so the interior is recovered by
	// tracking the lookahead's own brackets rather than by rule name. A depth counter copes with a
	// lookahead nested inside another.
	let lookaheadDepth = 0;
	let lookaheadLine = -1;
	// paren nesting for the rainbow colours; only `(`/`)` count, `[`/`$[` have their own colours
	let bracketDepth = 0;
	// the parts of a modifier are one coloured unit; the target after it is not part of the prefix
	let spacingLine = -1;
	let spacingEnd = -1;

	for (let index = 0; index < ordered.length; index++) {
		const token = ordered[index];
		const span: Span = { line: token.line, character: token.character, length: token.length };
		if (token.value.includes('\n') || token.value.includes('\r')) {
			lookaheadDepth = 0;
			continue;
		}
		if (lookaheadDepth > 0 && token.line !== lookaheadLine) {
			lookaheadDepth = 0;
		}
		// branch contents belong to the probe, not to whatever element rule matched them
		if (lookaheadDepth > 0 && token.rule !== 'optional_lookahead') {
			result.lookaheadText.push(span);
			continue;
		}
		if (token.line === spacingLine && token.character < spacingEnd) {
			continue;
		}
		// a modifier is one keyword-like unit: colour it as such and leave its parts alone
		const spacing = spacingModifierAt(ordered, index);
		if (spacing !== undefined) {
			result.spacing.push(spacing);
			result.affix.push({ line: spacing.line, character: spacing.character, length: spacing.length });
			spacingLine = spacing.line;
			spacingEnd = spacing.character + spacing.length;
			continue;
		}

		const value = glyph(token);
		const before = index > 0 ? ordered[index - 1] : undefined;

		if (value === '(') {
			result.brackets.push({ ...span, depth: bracketDepth++ });
		} else if (value === ')') {
			bracketDepth = Math.max(0, bracketDepth - 1);
			result.brackets.push({ ...span, depth: bracketDepth });
		}

		switch (token.rule) {
			case 'commentline':
				if (value === '#') {
					result.title.push({ line: token.line, character: token.character, length: (lines[token.line] ?? '').length - token.character });
				}
				break;

			case 'specline':
				// the `$`, the name and the `:` are all covered by the range built from `rest`
				if (value === 'rest') {
					addSpecLine(result, ordered, index);
				}
				break;

			case 'ruleline':
			case 'ruleline_final':
				if (value === '@') {
					result.anchorBase.push(span);
				} else if (value === 'word') {
					result.anchor.push(span);
					result.definitions.push(anchorOf(token));
				} else if (value === '?') {
					result.affix.push(span);
				}
				break;

			case 'plain_reference':
				if (value === '@') {
					result.anchorBase.push(span);
				} else if (value === 'word') {
					result.anchor.push(span);
					result.references.push(anchorOf(token));
				}
				break;

			case 'optional_reference':
				if (value === '?') {
					result.affix.push(span);
				} else if (value === '@') {
					result.anchorBase.push(span);
				} else if (value === 'word') {
					result.anchor.push(span);
					result.references.push(anchorOf(token));
				}
				break;

			case 'named_reference':
			case 'named_optional_reference':
				if (value === '@') {
					result.anchorBase.push(span);
				} else if (value === ':' || value === '?') {
					result.affix.push(span);
				} else if (value === 'word') {
					// `tag:@name`: only the word glued to the `@` is the referenced anchor
					if (before !== undefined && glyph(before) === '@') {
						result.anchor.push(span);
						result.references.push(anchorOf(token));
					} else {
						result.name.push(span);
					}
				}
				break;

			case 'reserved':
				// `$[name]` / `$$[name]`
				if (value === 'word') {
					result.keyword.push(span);
				} else {
					result.selector.push(span);
				}
				break;

			case 'optional':
				if (token.leaf === 'affix') {
					if (isModifier(ordered, index)) {
						result.affix.push(span);
					}
				} else {
					result.optional.push(span);
				}
				break;

			case 'suffix':
				if (isModifier(ordered, index)) {
					result.affix.push(span);
				}
				break;

			case 'group':
				// `prefix(name)`: the parens go to the rainbow layer, the label and `:` here
				if (value === 'word') {
					result.name.push(span);
				} else if (value === ':') {
					result.affix.push(span);
				}
				break;

			case 'plain_lookahead':
				if (value === '@' || value === '>') {
					result.lookahead.push(span);
				} else {
					result.lookaheadText.push(span);
				}
				break;

			case 'optional_lookahead':
				if (value === '@' || value === '>') {
					result.lookahead.push(span);
				} else if (token.leaf === 'affix') {
					if (isModifier(ordered, index)) {
						result.affix.push(span);
					}
				} else {
					result.optional.push(span);
					if (value === '[') {
						lookaheadDepth++;
						lookaheadLine = token.line;
					} else if (value === ']') {
						lookaheadDepth = Math.max(0, lookaheadDepth - 1);
					}
				}
				break;

			case 'at_alone':
				result.anchorBase.push(span);
				break;

			case 'dollar_alone':
				result.selector.push(span);
				break;

			default:
				break;
		}
	}
	result.tokens = ordered;
	return result;
}

/**
 * `$target: body`, or `$target:mode:regex` when the word before the body's first colon is a bare
 * word. The declaration span reaches through the colon; the body is split as before.
 */
function addSpecLine(result: Analysis, ordered: SyntaxToken[], index: number): void {
	const rest = ordered[index];
	let start = rest.character;
	let colonEnd = rest.character;
	let nameToken: SyntaxToken | undefined;
	for (let back = index - 1; back >= 0 && ordered[back].rule === 'specline' && ordered[back].line === rest.line; back--) {
		const token = ordered[back];
		const value = glyph(token);
		if (value === '$') {
			start = token.character;
		} else if (value === ':') {
			colonEnd = token.character + token.length;
		} else if (token.leaf === 'word') {
			nameToken = token;
		}
	}
	if (colonEnd > start && nameToken !== undefined && isSpacingModifier(nameToken.value, rest.value)) {
		const mode = spacingMode(nameToken.value);
		const target = spacingTarget(rest.value);
		if (mode !== undefined && target !== undefined) {
			result.spacing.push({
				line: rest.line,
				character: start,
				length: colonEnd - start,
				mode,
				text: `$${mode}:`,
				shorthand: false,
				target,
			});
			result.affix.push({ line: rest.line, character: start, length: colonEnd - start });
			return;
		}
	}
	if (colonEnd > start) {
		result.spec.push({ line: rest.line, character: start, length: colonEnd - start });
	}
	if (nameToken !== undefined) {
		result.specs.push({
			name: nameToken.value,
			line: nameToken.line,
			column: start,
			size: colonEnd - start,
			nameColumn: nameToken.character,
			nameSize: nameToken.length,
			body: rest.value,
			bodyColumn: rest.character,
			bodySize: rest.value.length,
		});
	}
	const parts = specBodyParts(rest.value);
	if (parts.mode !== '') {
		result.specMode.push({ line: rest.line, character: rest.character + parts.modeOffset, length: parts.modeLength });
	}
	if (parts.definitionLength > 0) {
		result.specRegex.push({
			line: rest.line,
			character: rest.character + parts.definitionOffset,
			length: parts.definitionLength,
		});
	}
}
