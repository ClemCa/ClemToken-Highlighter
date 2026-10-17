import type { SyntaxToken } from './engine';

/** The four rule kinds whose `@`/word tokens name an anchor reference. */
export const REFERENCE_RULES = new Set(['plain_reference', 'optional_reference', 'named_reference', 'named_optional_reference']);

/** Whether the token's nearest rule names an anchor reference. */
export function isReference(token: SyntaxToken | undefined): boolean {
	return token !== undefined && REFERENCE_RULES.has(token.rule ?? '');
}

/** Tokens on one line, optionally starting at a column; line terminators are excluded. */
export function tokensOnLine(tokens: SyntaxToken[], line: number, from = 0): SyntaxToken[] {
	return tokens.filter((token) => token.line === line && token.character >= from && !token.value.includes('\n') && !token.value.includes('\r'));
}
