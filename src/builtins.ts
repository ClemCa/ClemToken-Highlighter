import { specDefinition } from './specs';

/** What kind of value a spec expects, for type-aware hover examples. */
export type SpecKind = 'regex' | 'simple' | 'number' | 'enum' | 'text';

/** The shape of a spec's definition, independent of where it is declared. */
export interface SpecShape {
	kind: SpecKind;
	/** regex source for `regex` specs */
	pattern?: string;
	/** the text of a `simple` spec */
	literal?: string;
	/** the declared or default value for `number`/`enum` specs */
	default?: string;
	/** the allowed values for `enum` specs */
	values?: string[];
}

/**
 * Reserved specs the engine provides with no `$name:` declaration (ParserV3.cs). `space`, `tab`,
 * `newline` and `greedy` are matched before the spec store, so a declaration cannot replace them;
 * `whitespace`, `name` and `digit` are consulted through the store and can be overridden.
 */
export interface BuiltinSpec extends SpecShape {
	/** what the spec matches, shown in hover */
	summary: string;
	/** whether a `$name:` declaration replaces it, or the built-in always wins */
	overridable: boolean;
}

export const BUILTIN_SPECS: Readonly<Record<string, BuiltinSpec>> = {
	space: { summary: 'one space', overridable: false, kind: 'simple', literal: ' ' },
	tab: { summary: 'one tab', overridable: false, kind: 'simple', literal: '\t' },
	newline: { summary: 'one line break', overridable: false, kind: 'simple', literal: '\n' },
	greedy: { summary: 'everything to the end of the file', overridable: false, kind: 'text' },
	whitespace: { summary: 'a run of whitespace (`\\s+`)', overridable: true, kind: 'regex', pattern: '\\s+' },
	name: { summary: 'a run of non-space characters (`[^\\s]*`)', overridable: true, kind: 'regex', pattern: '[^\\s]*' },
	digit: { summary: 'one digit (`[0-9]`)', overridable: true, kind: 'regex', pattern: '[0-9]' },
};

export const BUILTIN_SPEC_NAMES = Object.keys(BUILTIN_SPECS);

/** Specs the engine reads itself: comment cleaning, recursion guards and spacing config. */
export interface EngineSpec extends SpecShape {
	summary: string;
}

export const ENGINE_SPECS: Readonly<Record<string, EngineSpec>> = {
	comment: {
		summary: 'a regex that marks comment text',
		kind: 'regex',
	},
	comment_begin: {
		summary: 'literal text that starts a block comment',
		kind: 'simple',
	},
	comment_end: {
		summary: 'literal text that ends a block comment',
		kind: 'simple',
	},
	comment_escape: {
		summary: 'literal text that escapes a comment delimiter',
		kind: 'simple',
	},
	recursion_limit: {
		summary: 'maximum search-stack depth',
		kind: 'number',
		default: '25',
	},
	recursion_repeat_limit: {
		summary: 'maximum repeated rule and cursor checks',
		kind: 'number',
		default: '5',
	},
	spacing: {
		summary: 'whitespace handling mode',
		kind: 'enum',
		default: 'implicit',
		values: ['implicit', 'explicit', 'horizontal'],
	},
};

export function builtinSpec(name: string): BuiltinSpec | undefined {
	return Object.prototype.hasOwnProperty.call(BUILTIN_SPECS, name) ? BUILTIN_SPECS[name] : undefined;
}

export function engineSpec(name: string): EngineSpec | undefined {
	return Object.prototype.hasOwnProperty.call(ENGINE_SPECS, name) ? ENGINE_SPECS[name] : undefined;
}

export function isEngineSpec(name: string): boolean {
	return engineSpec(name) !== undefined;
}

/** The short type shown next to a spec name. */
export function specKindName(kind: SpecKind): string {
	switch (kind) {
		case 'regex': return 'regex';
		case 'simple': return 'simple';
		case 'number': return 'number';
		case 'enum': return 'enum';
		default: return 'text';
	}
}

/** The description of a predefined spec, if it has one. */
export function specSummary(name: string): string | undefined {
	return engineSpec(name)?.summary ?? builtinSpec(name)?.summary;
}

/**
 * The value shape of a declared spec. Built-ins that cannot be overridden keep their own shape;
 * engine config specs keep their config type (number/enum/simple/regex) instead of being treated as
 * ordinary regex bodies; other declarations follow their `simple` mode.
 */
export function specShape(name: string, body: string): SpecShape {
	const builtin = builtinSpec(name);
	if (builtin !== undefined && !builtin.overridable) {
		return builtin;
	}
	const engine = engineSpec(name);
	const text = body.trim();
	if (engine !== undefined) {
		if (engine.kind === 'number' || engine.kind === 'enum') {
			return { ...engine, default: text === '' ? engine.default : text };
		}
		if (text === '') {
			return engine;
		}
		const { mode, definition } = specDefinition(body);
		if (engine.kind === 'simple' || mode === 'simple') {
			return { kind: 'simple', literal: definition };
		}
		return { kind: 'regex', pattern: definition };
	}
	if (text !== '') {
		const { mode, definition } = specDefinition(body);
		return mode === 'simple'
			? { kind: 'simple', literal: definition }
			: { kind: 'regex', pattern: definition };
	}
	if (builtin !== undefined) {
		return builtin;
	}
	// a custom spec without a body is still an (empty) regex
	return { kind: 'regex', pattern: '' };
}

/** How a declaration relates to the engine: `declared`, `engine spec`, `overrides ...` or `shadowed by ...`. */
export function builtinStatus(name: string): string {
	const builtin = builtinSpec(name);
	if (builtin === undefined) {
		return isEngineSpec(name) ? 'engine spec' : 'declared';
	}
	return builtin.overridable ? `overrides the built-in ${name}` : `shadowed by the built-in ${name}`;
}
