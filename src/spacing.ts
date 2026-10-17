import type { SyntaxToken } from './engine';

/** How a rule or scope treats implicit whitespace. */
export type SpacingMode = 'explicit' | 'implicit';

/** The target a spacing modifier must be glued to. */
export type SpacingTarget = '@' | '(' | '[';

/** A `$explicit:` / `$implicit:` prefix, or the `!` shorthand for explicit spacing. */
export interface SpacingModifier {
	line: number;
	character: number;
	length: number;
	mode: SpacingMode;
	/** `$explicit:` / `$implicit:` as written, or just `!` */
	text: string;
	shorthand: boolean;
	/** the character the modifier applies to */
	target: SpacingTarget;
}

export function spacingMode(name: string): SpacingMode | undefined {
	return name === 'explicit' || name === 'implicit' ? name : undefined;
}

/** `$`, `(` and `[` are the only constructs a modifier may precede (`Generator.cs`). */
export function spacingTarget(value: string | undefined): SpacingTarget | undefined {
	const first = value?.[0];
	return first === '@' || first === '(' || first === '[' ? first : undefined;
}

/** A spec-shaped line is a spacing modifier only when its body is glued to a target. */
export function isSpacingModifier(name: string, body: string): boolean {
	return spacingMode(name) !== undefined && spacingTarget(body) !== undefined;
}

/**
 * The spacing modifier that starts at `tokens[index]`, if any. The engine requires the prefix and
 * its target to be glued together, so a `$explicit: value` spec line is not a modifier.
 */
export function spacingModifierAt(tokens: SyntaxToken[], index: number): SpacingModifier | undefined {
	const token = tokens[index];
	if (token.rule === 'simple' && token.value === '!') {
		const target = tokens[index + 1];
		const targetChar = target !== undefined && target.line === token.line && target.character === token.character + token.length
			? spacingTarget(target.value)
			: undefined;
		if (targetChar !== undefined) {
			return {
				line: token.line,
				character: token.character,
				length: token.length,
				mode: 'explicit',
				text: '!',
				shorthand: true,
				target: targetChar,
			};
		}
		return undefined;
	}
	if (token.rule !== 'dollar_alone' || token.value !== '$') {
		return undefined;
	}
	const name = tokens[index + 1];
	const colon = tokens[index + 2];
	const target = tokens[index + 3];
	if (name === undefined) {
		return undefined;
	}
	const mode = spacingMode(name.value);
	if (
		mode === undefined
		|| name.character !== token.character + token.length
		|| colon?.value !== ':'
		|| colon.character !== name.character + name.length
		|| target === undefined
		|| target.line !== token.line
		|| target.character !== colon.character + colon.length
	) {
		return undefined;
	}
	const targetChar = spacingTarget(target.value);
	if (targetChar === undefined) {
		return undefined;
	}
	return {
		line: token.line,
		character: token.character,
		length: colon.character + colon.length - token.character,
		mode,
		text: `$${mode}:`,
		shorthand: false,
		target: targetChar,
	};
}
