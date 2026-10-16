import * as vscode from 'vscode';
import { ClemTokenEngine } from './engine';
import { Anchor, Analysis, Span, analyze } from './highlight';
import { ClemTokenSemanticTokensProvider, legend } from './semanticTokens';

export function activate(context: vscode.ExtensionContext) {
	const engine = new ClemTokenEngine(context);
	const output = vscode.window.createOutputChannel('ClemToken');
	context.subscriptions.push(engine, output);
	const available = activateEngine(context, engine, output);
	activateGrammar(context, engine, output, available);
	activateAbstract(context);
}

/**
 * Parser-driven layer: the bundled engine owns the token boundaries, so highlighting follows the
 * grammar rather than a regex approximation. It is additive on purpose - the decoration layer in
 * activateGrammar keeps the ClemToken-specific colours and wins wherever the two overlap.
 */
function activateEngine(context: vscode.ExtensionContext, engine: ClemTokenEngine, output: vscode.OutputChannel): boolean {
	if (!engine.available) {
		output.appendLine(`No engine binary for ${engine.target}. Parser-driven highlighting is off.`);
		output.appendLine('Run "node scripts/stage-engine.mjs" from the extension root, or point "clemtoken.enginePath" at an engine.');
		// The package carries an engine per platform, so a missing one usually means this is a platform
		// it does not build for rather than a broken install. Say so where the user will see it: an
		// unhighlighted file with a note buried in an output channel reads as a bug in the extension.
		const bundled = engine.bundledTargets;
		if (bundled.length > 0 && !bundled.includes(engine.target)) {
			void vscode.window.showWarningMessage(
				`ClemToken Highlighter does not support ${engine.platformName()} yet, so highlighting is off.`
			);
		}
		return false;
	}
	output.appendLine(`Engine: ${engine.resolveBinary()}`);
	output.appendLine(`Grammar: ${engine.resolveGrammar()}`);
	context.subscriptions.push(
		vscode.languages.registerDocumentSemanticTokensProvider(
			{ language: 'clemtoken' },
			new ClemTokenSemanticTokensProvider(engine, (message) => output.appendLine(message)),
			legend
		)
	);
	return true;
}

function activateAbstract(context: vscode.ExtensionContext) {
	const abstractFieldColor = vscode.workspace.getConfiguration('clemtoken-abstract').get('fieldColor', '#4a9d4cff');
	const abstractColonColor = vscode.workspace.getConfiguration('clemtoken-abstract').get('colonColor', '#4EC9B0');
	const abstractStringColor = vscode.workspace.getConfiguration('clemtoken-abstract').get('stringColor', '#CE9178');
	const abstractFieldDecorationType = vscode.window.createTextEditorDecorationType({
		color: abstractFieldColor
	});
	const abstractColonDecorationType = vscode.window.createTextEditorDecorationType({
		color: abstractColonColor
	});
	const abstractStringDecorationType = vscode.window.createTextEditorDecorationType({
		color: abstractStringColor
	});
	const fields = [] as { line: number, column: number, size: number, name: string }[];
	const strings = [] as { line: number, column: number, size: number, name: string }[];
	let activeEditor = vscode.window.activeTextEditor;
	vscode.window.onDidChangeActiveTextEditor(editor => {
		activeEditor = editor;
		if (editor) {
			updateDecorations();
		}
	}, null, context.subscriptions);
	vscode.workspace.onDidChangeTextDocument(event => {
		if (event.document.languageId !== 'clemtoken-abstract') return;
		if (activeEditor && event.document === activeEditor.document) {
			updateDecorations();
		}
	}, null, context.subscriptions);
	vscode.workspace.onDidChangeConfiguration(event => {
		if (!activeEditor) return;
		updateDecorations();
	}, null, context.subscriptions);
	vscode.languages.onDidChangeDiagnostics(event => {
		if (activeEditor && event.uris.includes(activeEditor.document.uri)) {
			updateDecorations();
		}
	}, null, context.subscriptions);
	const documentSymbolProvider = vscode.languages.registerDocumentSymbolProvider("clemtoken-abstract", {
		provideDocumentSymbols(document, token) {
			return [...fields.map(field => {
				return new vscode.DocumentSymbol(
					field.name,
					'Field',
					vscode.SymbolKind.Key,
					new vscode.Range(field.line, field.column, field.line, field.column + field.size),
					new vscode.Range(field.line, field.column, field.line, field.column + field.size)
				);
			}), ...strings.map(str => {
				return new vscode.DocumentSymbol(
					str.name,
					'String',
					vscode.SymbolKind.String,
					new vscode.Range(str.line, str.column, str.line, str.column + str.size),
					new vscode.Range(str.line, str.column, str.line, str.column + str.size)
				);
			})];
		}
	});
	const foldingRangeProvider = vscode.languages.registerFoldingRangeProvider("clemtoken-abstract", {
		provideFoldingRanges(document, context, token) {
			function GetFoldingRanges(line: number, depth: number): [vscode.FoldingRange[], number] {
				if (line >= document.lineCount) return [[], line];
				const text = document.lineAt(line).text;
				if (text.trimStart().startsWith(')')) {
					return [[], line];
				}
				const ranges = [] as vscode.FoldingRange[];
				if (text.trimStart().startsWith('(')) {
					let [_, l] = GetFoldingRanges(line + 1, depth + 1);
					ranges.push(new vscode.FoldingRange(line, l));
					line = l;
				}
				let [nextRanges, nextLine] = GetFoldingRanges(line + 1, depth);
				ranges.push(...nextRanges);
				return [ranges, nextLine];
			}
			const [finalRanges, _] = GetFoldingRanges(0, 0);
			return finalRanges;
		}
	});
	context.subscriptions.push(documentSymbolProvider, foldingRangeProvider);
	function updateDecorations() {
		if (!activeEditor) return;
		const lang = activeEditor.document.languageId;
		if (lang !== "clemtoken-abstract") return;
		// rebuilt each pass: the symbol provider reads these two arrays, so they must not accumulate
		// stale entries across edits - and they keep their identity, since the closure captures them
		fields.length = 0;
		strings.length = 0;
		const fdecorations = [] as vscode.DecorationOptions[];
		const cDecorations = [] as vscode.DecorationOptions[];
		const sDecorations = [] as vscode.DecorationOptions[];
		const text = activeEditor.document.getText().split(/\r?\n/);
		for (let i = 0; i < text.length; i++) {
			if (text[i].trim() === "") continue;
			abstractDecorationsFromLine(activeEditor.document, text[i], i, fdecorations, cDecorations, sDecorations, fields, strings);
		}
		activeEditor.setDecorations(abstractFieldDecorationType, fdecorations);
		activeEditor.setDecorations(abstractColonDecorationType, cDecorations);
		activeEditor.setDecorations(abstractStringDecorationType, sDecorations);
	}
}

function abstractDecorationsFromLine(document: vscode.TextDocument, line: string, lineNumber: number,
	fdecorations: vscode.DecorationOptions[],
	cDecorations: vscode.DecorationOptions[],
	sDecorations: vscode.DecorationOptions[],
	fields: { line: number, column: number, size: number, name: string }[],
	strings: { line: number, column: number, size: number, name: string }[]) {
	if (line.trimStart().startsWith('(')) return;
	let whitespaceAmount = line.length - line.trimStart().length; // not efficient but I'll prioritize readability for this one
	var word = document.getWordRangeAtPosition(new vscode.Position(lineNumber, whitespaceAmount), /[\w_]+:/);
	if (word) {
		const fieldName = line.substring(word.start.character, word.end.character - 1);
		const fieldValue = line.substring(word.end.character + 1).trim();
		fdecorations.push({
			range: new vscode.Range(
				lineNumber, word.start.character,
				lineNumber, word.end.character - 1
			),
			hoverMessage: fieldValue
		});
		cDecorations.push({
			range: new vscode.Range(
				lineNumber, word.end.character - 1,
				lineNumber, word.end.character
			),
		});
		sDecorations.push({
			range: new vscode.Range(
				lineNumber, word.end.character + 1,
				lineNumber, word.end.character + 1 + fieldValue.length
			),
		});
		fields.push({
			line: lineNumber,
			column: word.start.character,
			size: word.end.character - word.start.character - 1,
			name: fieldName
		});
		strings.push({
			line: lineNumber,
			column: word.end.character + 2,
			size: fieldValue.length,
			name: fieldValue
		});
	}
}

/** The coloured decoration types, rebuilt whenever a colour setting changes. */
interface DecorationTypes {
	title: vscode.TextEditorDecorationType;
	name: vscode.TextEditorDecorationType;
	affix: vscode.TextEditorDecorationType;
	keyword: vscode.TextEditorDecorationType;
	selector: vscode.TextEditorDecorationType;
	anchor: vscode.TextEditorDecorationType;
	anchorBase: vscode.TextEditorDecorationType;
	optional: vscode.TextEditorDecorationType;
	spec: vscode.TextEditorDecorationType;
	specMode: vscode.TextEditorDecorationType;
	specRegex: vscode.TextEditorDecorationType;
	lookahead: vscode.TextEditorDecorationType;
	lookaheadText: vscode.TextEditorDecorationType;
	dispose(): void;
}

function createDecorationTypes(): DecorationTypes {
	const color = (name: string, fallback: string) => vscode.window.createTextEditorDecorationType({
		color: vscode.workspace.getConfiguration('clemtoken').get(name, fallback)
	});
	const types = {
		title: color('titleColor', '#02adf6ff'),
		name: color('nameColor', '#808080'),
		affix: color('affixColor', '#FF69B4'),
		keyword: color('keywordColor', '#4a9d4cff'),
		selector: color('selectorColor', '#4EC9B0'),
		anchor: color('anchorColor', '#569CD6'),
		anchorBase: color('anchorBaseColor', '#8eb5d4ff'),
		optional: color('optionalColor', '#FFB6C1'),
		spec: color('specColor', '#dcdcaa'),
		specMode: color('specModeColor', '#9cdcfe'),
		specRegex: color('specRegexColor', '#c586c0'),
		lookahead: color('lookaheadColor', '#209b49'),
		lookaheadText: color('lookaheadTextColor', '#31f227'),
	};
	return {
		...types,
		dispose: () => {
			for (const type of Object.values(types)) {
				type.dispose();
			}
		},
	};
}

/**
 * Decoration layer. The ranges come from the parser (see highlight.ts); the colours are the
 * extension's own and are what the `clemtoken.*Color` settings drive.
 */
function activateGrammar(context: vscode.ExtensionContext, engine: ClemTokenEngine, output: vscode.OutputChannel, available: boolean) {
	let types = createDecorationTypes();
	context.subscriptions.push({ dispose: () => types.dispose() });

	// what the language providers read: definitions are `@name:` rule lines, references are uses of
	// them elsewhere. A reference with no definition is offered by completion as a new anchor.
	let definitions: Anchor[] = [];
	let references: Anchor[] = [];
	let uncreated: Anchor[] = [];

	let activeEditor = vscode.window.activeTextEditor;
	let pending: NodeJS.Timeout | undefined;
	const schedule = () => {
		if (pending !== undefined) {
			clearTimeout(pending);
		}
		// one engine run per keystroke burst; the document version guard below drops stale results
		pending = setTimeout(() => {
			pending = undefined;
			void updateDecorations();
		}, 150);
	};

	vscode.window.onDidChangeActiveTextEditor(editor => {
		activeEditor = editor;
		updateDecorations();
	}, null, context.subscriptions);
	vscode.workspace.onDidChangeTextDocument(event => {
		if (activeEditor && event.document === activeEditor.document) {
			schedule();
		}
	}, null, context.subscriptions);
	vscode.workspace.onDidChangeConfiguration(event => {
		if (!event.affectsConfiguration('clemtoken')) return;
		types.dispose();
		types = createDecorationTypes();
		updateDecorations();
	}, null, context.subscriptions);
	vscode.languages.onDidChangeDiagnostics(event => {
		if (activeEditor && event.uris.includes(activeEditor.document.uri)) {
			updateDecorations();
		}
	}, null, context.subscriptions);

	const findReferenceAt = (position: vscode.Position): Anchor | undefined =>
		references.find(entry => entry.line === position.line && position.character >= entry.column && position.character < entry.column + entry.size);
	const findAnchorAt = (position: vscode.Position): Anchor | undefined =>
		findReferenceAt(position) ?? definitions.find(entry => entry.line === position.line && position.character >= entry.column && position.character < entry.column + entry.size);

	const documentSymbolProvider = vscode.languages.registerDocumentSymbolProvider({ language: 'clemtoken' }, {
		provideDocumentSymbols(document, token) {
			const symbol = (entry: Anchor) => new vscode.DocumentSymbol(
				entry.name,
				'',
				vscode.SymbolKind.Function,
				new vscode.Range(entry.line, entry.column, entry.line, entry.column + entry.size),
				new vscode.Range(entry.line, entry.column, entry.line, entry.column + entry.size)
			);
			return [...definitions.map(symbol), ...references.map(symbol)];
		}
	});
	const refProvider = vscode.languages.registerReferenceProvider({ language: 'clemtoken' }, {
		provideReferences(document, position, context, token) {
			const entry = findAnchorAt(position);
			if (!entry) return null;
			return references.filter(ref => ref.name === entry.name).map(ref => {
				return new vscode.Location(
					document.uri,
					new vscode.Range(ref.line, ref.column, ref.line, ref.column + ref.size)
				);
			});
		}
	});
	const dProvider = vscode.languages.registerDefinitionProvider({ language: 'clemtoken' }, {
		provideDefinition(document, position, token) {
			const reference = findReferenceAt(position);
			if (!reference) return null;
			const anchor = definitions.find(entry => entry.name === reference.name);
			if (!anchor) return null;
			return new vscode.Location(
				document.uri,
				new vscode.Range(anchor.line, anchor.column, anchor.line, anchor.column + anchor.size)
			);
		}
	});
	const cProvider = vscode.languages.registerCompletionItemProvider({ language: 'clemtoken' }, {
		provideCompletionItems(document, position, token) {
			const word = document.getWordRangeAtPosition(position, /(?:\w+:\@\w+:\?\@|\?\@|\@|(?:\$\[?))\w+/);
			if (!word) return [];
			const text = document.getText(word);
			if (!text) return [];
			if ((text.startsWith("@") && !text.startsWith("@>")) || text.startsWith("?@") || text.includes(":@") || text.includes(":?@")) {
				if (word.start.character === 0) {
					if (text[0] !== '@') {
						return [];
					}
					return uncreated.map(anchor => {
						const item = new vscode.CompletionItem("@" + anchor.name + ":", vscode.CompletionItemKind.Function);
						item.range = new vscode.Range(word.start, word.end);
						return item;
					});
				}
				const preStr = text.substring(0, text.indexOf("@"));
				return definitions.map(anchor => {
					const item = new vscode.CompletionItem(preStr + "@" + anchor.name, vscode.CompletionItemKind.Function);
					item.range = new vscode.Range(word.start, word.end);
					return item;
				});
			} else if (text.startsWith("$")) {
				return [
					"$[name]",
					"$[digit]",
					"$[space]",
					"$$[name]",
					"$$[digit]",
					"$$[space]"
				].map(item => {
					const i = new vscode.CompletionItem(item, vscode.CompletionItemKind.Function);
					i.range = new vscode.Range(word.start, word.end);
					return i;
				});
			}
			return [];
		}
	}, '@', '$');
	context.subscriptions.push(refProvider, dProvider, documentSymbolProvider, cProvider);

	/** Clip to the document: a range the builder/editor would reject is dropped, not thrown. */
	const spans = (document: vscode.TextDocument, list: Span[]): vscode.DecorationOptions[] => {
		const options: vscode.DecorationOptions[] = [];
		for (const span of list) {
			if (span.line < 0 || span.line >= document.lineCount) continue;
			const lineLength = document.lineAt(span.line).text.length;
			const character = Math.max(0, Math.min(span.character, lineLength));
			const end = Math.min(character + span.length, lineLength);
			if (end <= character) continue;
			options.push({ range: new vscode.Range(span.line, character, span.line, end) });
		}
		return options;
	};

	async function updateDecorations() {
		const editor = activeEditor;
		if (!editor || editor.document.languageId !== 'clemtoken') return;
		if (!available) return;
		const document = editor.document;
		const version = document.version;
		try {
			const text = document.getText();
			const set = await engine.tokenize(text, document.uri.toString(), version);
			// the document may have moved on while the engine ran
			if (version !== document.version || activeEditor !== editor) return;
			const analysis: Analysis = analyze(text, set.tokens);
			apply(editor, document, analysis);
		} catch (e) {
			output.appendLine(`Highlighting failed for ${document.uri.fsPath}: ${(e as Error).message}`);
		}
	}

	function apply(editor: vscode.TextEditor, document: vscode.TextDocument, analysis: Analysis) {
		editor.setDecorations(types.optional, spans(document, analysis.optional));
		editor.setDecorations(types.anchorBase, spans(document, analysis.anchorBase));
		editor.setDecorations(types.anchor, spans(document, analysis.anchor));
		editor.setDecorations(types.title, spans(document, analysis.title));
		editor.setDecorations(types.keyword, spans(document, analysis.keyword));
		editor.setDecorations(types.selector, spans(document, analysis.selector));
		editor.setDecorations(types.name, spans(document, analysis.name));
		editor.setDecorations(types.affix, spans(document, analysis.affix));
		editor.setDecorations(types.spec, spans(document, analysis.spec));
		editor.setDecorations(types.specMode, spans(document, analysis.specMode));
		editor.setDecorations(types.specRegex, spans(document, analysis.specRegex));
		editor.setDecorations(types.lookahead, spans(document, analysis.lookahead));
		editor.setDecorations(types.lookaheadText, spans(document, analysis.lookaheadText));
		definitions = analysis.definitions;
		const known = new Set(definitions.map(entry => entry.name));
		references = analysis.references.filter(entry => known.has(entry.name));
		uncreated = analysis.references.filter(entry => !known.has(entry.name));
	}

	updateDecorations();
}

export function deactivate() { }
