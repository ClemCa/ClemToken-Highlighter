import type { Analysis } from './highlight';

/** A spec body split the way `Generator.ParseSpec` does: a bare mode, then the definition. */
export interface SpecDefinition {
	mode: string;
	definition: string;
}

/** The same split, with offsets relative to the raw body so each part can have its own hover. */
export interface SpecBodyParts extends SpecDefinition {
	modeOffset: number;
	modeLength: number;
	definitionOffset: number;
	definitionLength: number;
}

/**
 * `simple: foo` declares a literal; anything else, including no mode, is a regex. A mode is only
 * recognised when a word directly precedes the first colon and the definition starts with space.
 */
export function specBodyParts(body: string): SpecBodyParts {
	const leading = body.length - body.trimStart().length;
	const text = body.trim();
	const modeEnd = text.indexOf(':');
	if (modeEnd > 0) {
		const mode = text.slice(0, modeEnd).trim();
		const rest = text.slice(modeEnd + 1);
		if (/^\w+$/.test(mode) && (rest === '' || /^\s/.test(rest))) {
			const definition = rest.trim();
			const restOffset = rest.length - rest.trimStart().length;
			return {
				mode,
				definition,
				modeOffset: leading,
				modeLength: modeEnd + 1,
				definitionOffset: leading + modeEnd + 1 + restOffset,
				definitionLength: definition.length,
			};
		}
	}
	const definition = text;
	return {
		mode: '',
		definition,
		modeOffset: -1,
		modeLength: 0,
		definitionOffset: leading,
		definitionLength: definition.length,
	};
}

export function specDefinition(body: string): SpecDefinition {
	const { mode, definition } = specBodyParts(body);
	return { mode, definition };
}

/**
 * How many times each spec is used by `$[name]` / `$$[name]` in rule bodies. Lookahead branches are
 * literal text, so a spec-shaped sequence there is not a use.
 */
export function specUses(analysis: Analysis): Map<string, number> {
	const uses = new Map<string, number>();
	for (const token of analysis.tokens) {
		if (token.rule !== 'reserved' || token.leaf !== 'word' || inLookaheadText(analysis, token.line, token.character)) {
			continue;
		}
		uses.set(token.value, (uses.get(token.value) ?? 0) + 1);
	}
	return uses;
}

function inLookaheadText(analysis: Analysis, line: number, character: number): boolean {
	return analysis.lookaheadText.some((span) =>
		span.line === line && character >= span.character && character < span.character + span.length);
}
