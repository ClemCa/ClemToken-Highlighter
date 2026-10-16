/**
 * Reserved specs the engine provides with no `$name:` declaration (ParserV3.cs). `space`, `tab`,
 * `newline` and `greedy` are matched before the spec store, so a declaration cannot replace them;
 * `whitespace`, `name` and `digit` are consulted through the store and can be overridden.
 */
export interface BuiltinSpec {
	/** what the spec matches, shown in hover */
	summary: string;
	/** whether a `$name:` declaration replaces it, or the built-in always wins */
	overridable: boolean;
}

export const BUILTIN_SPECS: Readonly<Record<string, BuiltinSpec>> = {
	space: { summary: 'one space', overridable: false },
	tab: { summary: 'one tab', overridable: false },
	newline: { summary: 'one line break', overridable: false },
	greedy: { summary: 'everything to the end of the file', overridable: false },
	whitespace: { summary: 'a run of whitespace (`\\s+`)', overridable: true },
	name: { summary: 'a run of non-space characters (`[^\\s]*`)', overridable: true },
	digit: { summary: 'one digit (`[0-9]`)', overridable: true },
};

export const BUILTIN_SPEC_NAMES = Object.keys(BUILTIN_SPECS);

export function builtinSpec(name: string): BuiltinSpec | undefined {
	return Object.prototype.hasOwnProperty.call(BUILTIN_SPECS, name) ? BUILTIN_SPECS[name] : undefined;
}
