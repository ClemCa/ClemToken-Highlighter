import * as vscode from 'vscode';
import { ClemTokenEngine, SyntaxToken } from './engine';

/**
 * The coarse categories handed to the theme.
 *
 * Deliberately small: the grammar has around eleven rule kinds and a theme has no idea what most
 * of them mean. Only the categories that map onto real editor concepts are published here; the
 * ClemToken-specific marks (affixes, anchors, optional brackets, spec modes) stay in the
 * decoration layer, which is also where the user's own colours live.
 */
export const tokenTypes = ['comment', 'keyword', 'variable', 'regexp', 'operator'] as const;

export const tokenModifiers: string[] = [];

export const legend = new vscode.SemanticTokensLegend([...tokenTypes], [...tokenModifiers]);

type Kind = typeof tokenTypes[number];

/** rule/leaf -> coarse kind, or `undefined` to leave the token to the decoration layer. */
function kindOf(token: SyntaxToken): Kind | undefined {
	switch (token.rule) {
		case 'commentline':
			return 'comment';
		case 'specline':
			// `$name:` is a declaration-ish keyword, the body after it is the pattern
			return token.leaf === 'rest' ? 'regexp' : 'keyword';
		case 'reserved':
			// `$[name]` / `$$[name]`: references to the built-in specs
			return 'keyword';
		case 'plain_reference':
		case 'named_reference':
		case 'optional_reference':
		case 'named_optional_reference':
			return 'variable';
		case 'optional':
		case 'suffix':
			return 'operator';
		default:
			return undefined;
	}
}

export class ClemTokenSemanticTokensProvider implements vscode.DocumentSemanticTokensProvider {
	constructor(
		private readonly engine: ClemTokenEngine,
		private readonly report: (message: string) => void = () => { },
	) { }

	async provideDocumentSemanticTokens(
		document: vscode.TextDocument,
		_token: vscode.CancellationToken,
	): Promise<vscode.SemanticTokens> {
		try {
			const set = await this.engine.tokenize(document.getText(), document.uri.toString(), document.version);
			return build(document, set.tokens);
		} catch (e) {
			// returning nothing keeps the previous highlighting instead of dropping it on a bad parse
			this.report(`Tokenize failed for ${document.uri.fsPath}: ${(e as Error).message}`);
			return new vscode.SemanticTokens(new Uint32Array(0));
		}
	}
}

/**
 * Semantic tokens are absolute and non-overlapping; the builder turns them into the relative,
 * delta-encoded form VS Code expects.
 */
function build(document: vscode.TextDocument, tokens: SyntaxToken[]): vscode.SemanticTokens {
	const builder = new vscode.SemanticTokensBuilder(legend);
	const ordered = [...tokens].sort((a, b) => a.line - b.line || a.character - b.character);
	let endLine = -1;
	let endCharacter = -1;
	for (const token of ordered) {
		const kind = kindOf(token);
		if (kind === undefined || token.length <= 0) {
			continue;
		}
		const index = tokenTypes.indexOf(kind);
		// a line terminator belongs to no category and its range would cross into the next line
		if (token.value.includes('\n') || token.value.includes('\r')) {
			continue;
		}
		// the document may have moved on since the engine ran; never hand the builder a stale range
		if (token.line < 0 || token.line >= document.lineCount) {
			continue;
		}
		const lineLength = document.lineAt(token.line).text.length;
		if (token.character < 0 || token.character > lineLength) {
			continue;
		}
		const end = Math.min(token.character + token.length, lineLength);
		if (end <= token.character) {
			continue;
		}
		// ranges must not overlap; sort order makes a running high-water mark enough
		if (token.line === endLine && token.character < endCharacter) {
			continue;
		}
		builder.push(token.line, token.character, end - token.character, index, 0);
		endLine = token.line;
		endCharacter = end;
	}
	return builder.build();
}
