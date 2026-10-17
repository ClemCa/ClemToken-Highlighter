import * as vscode from 'vscode';
import { ClemTokenEngine, GrammarStats, ParseMetrics } from './engine';
import { collectDiagnostics } from './diagnostics';
import { Anchor, Analysis, Span, analyze } from './highlight';
import { provideHover } from './hover';
import { activeRanges, collectInlayHints, repositionHint } from './inlayHints';
import { StatsRow, StatsView } from './statsView';
import { grammarFlame, profileFlame } from './flameGraph';
import { formatBytes, formatDuration, ruleFlags, symbolBound } from './format';
import { ClemTokenSemanticTokensProvider, legend } from './semanticTokens';
import { buildCompletionTable, CompletionTable, provideCompletion } from './completion';

const GRAMMAR_HEADERS = ['Rule', 'Type', 'Bound', 'Flags', 'Uses'];
const PROFILE_HEADERS = ['Rule', 'Type', 'Exec', 'Match', 'Fail', 'Alloc (incl / self)', 'Time (incl / self)', 'Value'];

export function activate(context: vscode.ExtensionContext) {
	const engine = new ClemTokenEngine(context);
	const output = vscode.window.createOutputChannel('ClemToken');
	context.subscriptions.push(engine, output);
	const available = activateEngine(context, engine, output);
	const statsView = new StatsView();
	context.subscriptions.push(statsView);
	activateGrammar(context, engine, output, available, statsView);
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
	vscode.workspace.onDidChangeConfiguration(() => {
		if (!activeEditor) return;
		updateDecorations();
	}, null, context.subscriptions);
	vscode.languages.onDidChangeDiagnostics(event => {
		if (activeEditor && event.uris.includes(activeEditor.document.uri)) {
			updateDecorations();
		}
	}, null, context.subscriptions);
	const documentSymbolProvider = vscode.languages.registerDocumentSymbolProvider("clemtoken-abstract", {
		provideDocumentSymbols() {
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
		provideFoldingRanges(document) {
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
	active: vscode.TextEditorDecorationType;
	spec: vscode.TextEditorDecorationType;
	specMode: vscode.TextEditorDecorationType;
	specRegex: vscode.TextEditorDecorationType;
	lookahead: vscode.TextEditorDecorationType;
	lookaheadText: vscode.TextEditorDecorationType;
	/** one type per entry in `clemtoken.bracketColors`, cycled by paren depth */
	brackets: vscode.TextEditorDecorationType[];
	dispose(): void;
}

function createDecorationTypes(): DecorationTypes {
	const color = (name: string, fallback: string) => vscode.window.createTextEditorDecorationType({
		color: vscode.workspace.getConfiguration('clemtoken').get(name, fallback)
	});
	const bracketColors = vscode.workspace.getConfiguration('clemtoken').get<string[]>('bracketColors', []) ?? [];
	const types = {
		// registered first: decoration rules are inserted at the head of the stylesheet, so later
		// registrations push this one to the end and its colour wins over the per-token colours
		active: color('activeColor', '#8B5CF6'),
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
		brackets: bracketColors
			.filter(entry => typeof entry === 'string' && entry.length > 0)
			.map(entry => vscode.window.createTextEditorDecorationType({ color: entry })),
	};
	return {
		...types,
		dispose: () => {
			for (const type of Object.values(types)) {
				if (Array.isArray(type)) {
					for (const item of type) {
						item.dispose();
					}
				} else {
					type.dispose();
				}
			}
		},
	};
}

/**
 * Decoration layer. The ranges come from the parser (see highlight.ts); the colours are the
 * extension's own and are what the `clemtoken.*Color` settings drive.
 */
function activateGrammar(context: vscode.ExtensionContext, engine: ClemTokenEngine, output: vscode.OutputChannel, available: boolean, statsView: StatsView) {
	let types = createDecorationTypes();
	context.subscriptions.push({ dispose: () => types.dispose() });
	const diagnostics = vscode.languages.createDiagnosticCollection('clemtoken');
	context.subscriptions.push(diagnostics, vscode.workspace.onDidCloseTextDocument(document => diagnostics.delete(document.uri)));

	/** Logging must never throw: these run from timers and providers where a throw can escape. */
	const report = (message: string): void => {
		try {
			output.appendLine(message);
		} catch {
			// the channel is already gone
		}
	};

	// what the language providers read: definitions are `@name:` rule lines, references are uses of
	// them elsewhere
	let definitions: Anchor[] = [];
	let references: Anchor[] = [];

	// what the hover / CodeLens / command surfaces read: the last completed analysis plus its stats
	let current: { document: vscode.TextDocument; version: number; analysis: Analysis } | undefined;
	let stats: GrammarStats | undefined;
	let statsDocument: vscode.TextDocument | undefined;
	let statsVersion = -1;
	// completion tables, rebuilt from the buffer and then upgraded by the last analysis and stats
	let completion: { document: vscode.TextDocument; version: number; table: CompletionTable } | undefined;
	// inlay hints follow the cursor line; this refreshes them after analysis or a cursor move
	const inlayHintsChanged = new vscode.EventEmitter<void>();
	context.subscriptions.push(inlayHintsChanged);

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

	/** Colour the construct the current-line inlay hint describes, once the analysis is current. */
	const updateActiveDecoration = () => {
		const editor = activeEditor;
		if (editor === undefined || editor.document.languageId !== 'clemtoken') {
			return;
		}
		const model = current;
		if (model === undefined || model.document !== editor.document) {
			editor.setDecorations(types.active, []);
			return;
		}
		if (model.version !== editor.document.version) {
			// keep the last target until the debounced analysis catches up; clearing here would flicker
			return;
		}
		editor.setDecorations(types.active, activeRanges(editor.document, model.analysis, editor.selection.active));
	};

	// stats are for reading, not typing: a longer debounce than the colours, and `ensureStats`
	// flushes it when a hover or command needs the numbers now
	let statsTimer: NodeJS.Timeout | undefined;
	const statsDelay = () => Math.max(0, vscode.workspace.getConfiguration('clemtoken').get<number>('statsDebounceMs', 1200));
	const scheduleStats = () => {
		if (!available) return;
		if (statsTimer !== undefined) {
			clearTimeout(statsTimer);
		}
		statsTimer = setTimeout(() => {
			statsTimer = undefined;
			void loadStats();
		}, statsDelay());
	};

	const codeLenses = new vscode.EventEmitter<void>();
	context.subscriptions.push(codeLenses);

	vscode.window.onDidChangeActiveTextEditor(editor => {
		activeEditor = editor;
		void updateDecorations();
		scheduleStats();
		inlayHintsChanged.fire();
		updateActiveDecoration();
	}, null, context.subscriptions);
	vscode.window.onDidChangeTextEditorSelection(event => {
		if (event.textEditor === activeEditor) {
			inlayHintsChanged.fire();
			updateActiveDecoration();
		}
	}, null, context.subscriptions);
	vscode.workspace.onDidChangeTextDocument(event => {
		if (activeEditor && event.document === activeEditor.document) {
			schedule();
			scheduleStats();
			// re-place the cached hint at the new end of the line while the analysis is stale
			inlayHintsChanged.fire();
		}
	}, null, context.subscriptions);
	vscode.workspace.onDidChangeConfiguration(event => {
		if (!event.affectsConfiguration('clemtoken')) return;
		types.dispose();
		types = createDecorationTypes();
		void updateDecorations();
		updateActiveDecoration();
		codeLenses.fire();
	}, null, context.subscriptions);
	vscode.languages.onDidChangeDiagnostics(event => {
		if (activeEditor && event.uris.includes(activeEditor.document.uri)) {
			void updateDecorations();
		}
	}, null, context.subscriptions);

	const findReferenceAt = (position: vscode.Position): Anchor | undefined =>
		references.find(entry => entry.line === position.line && position.character >= entry.column && position.character < entry.column + entry.size);
	const findAnchorAt = (position: vscode.Position): Anchor | undefined =>
		findReferenceAt(position) ?? definitions.find(entry => entry.line === position.line && position.character >= entry.column && position.character < entry.column + entry.size);

	const documentSymbolProvider = vscode.languages.registerDocumentSymbolProvider({ language: 'clemtoken' }, {
		provideDocumentSymbols() {
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
		provideReferences(document, position) {
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
		provideDefinition(document, position) {
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
	const tableFor = (document: vscode.TextDocument): CompletionTable => {
		if (completion !== undefined && completion.document === document && completion.version === document.version) {
			return completion.table;
		}
		const analysis = current !== undefined && current.document === document && current.version === document.version ? current.analysis : undefined;
		// stats belong to the active editor, so they are only safe when they describe this document
		const grammar = analysis !== undefined && statsDocument === document && statsVersion === document.version ? stats : undefined;
		completion = { document, version: document.version, table: buildCompletionTable(document.getText(), analysis, grammar) };
		return completion.table;
	};
	const cProvider = vscode.languages.registerCompletionItemProvider({ language: 'clemtoken' }, {
		provideCompletionItems(document, position, token) {
			return provideCompletion(document, position, tableFor(document), token);
		}
	}, '@', '$', '[', '>', ':', ' ');
	context.subscriptions.push(refProvider, dProvider, documentSymbolProvider, cProvider);

	const hoverProvider = vscode.languages.registerHoverProvider({ language: 'clemtoken' }, {
		async provideHover(document, position) {
			await ensureModel(document);
			if (current === undefined || current.document !== document || current.version !== document.version) return undefined;
			await ensureStats();
			return provideHover(document, current.analysis, stats, position);
		}
	});
	const codeLensProvider = vscode.languages.registerCodeLensProvider({ language: 'clemtoken' }, {
		onDidChangeCodeLenses: codeLenses.event,
		provideCodeLenses(document) {
			if (!vscode.workspace.getConfiguration('clemtoken').get('showCodeLens', true)) return [];
			const model = current;
			if (model === undefined || model.document !== document || model.version !== document.version) return [];
			const lenses: vscode.CodeLens[] = [];
			for (const definition of model.analysis.definitions) {
				const count = model.analysis.references.reduce((total, ref) => ref.name === definition.name ? total + 1 : total, 0);
				if (count === 0) continue;
				const range = new vscode.Range(definition.line, definition.column, definition.line, definition.column + definition.size);
				lenses.push(new vscode.CodeLens(range, {
					title: `${count} reference${count === 1 ? '' : 's'}`,
					command: 'clemtoken.showReferences',
					arguments: [document.uri, new vscode.Position(definition.line, definition.column)],
				}));
			}
			return lenses;
		}
	});
	// The hint for the active line survives the gap between a keystroke and the analysis that
	// describes it. Without this the provider returned nothing for every stale version, so the
	// details vanished and reappeared on each keystroke.
	let lastHint: { document: vscode.TextDocument; line: number; hint: vscode.InlayHint } | undefined;
	const inlayProvider = vscode.languages.registerInlayHintsProvider({ language: 'clemtoken' }, {
		onDidChangeInlayHints: inlayHintsChanged.event,
		provideInlayHints(document, range, token) {
			if (!available || token.isCancellationRequested) return [];
			const cursor = activeEditor?.document === document ? activeEditor.selection.active : undefined;
			if (cursor === undefined || cursor.line >= document.lineCount
				|| cursor.line < range.start.line || cursor.line > range.end.line) {
				return [];
			}
			const model = current;
			const stale = model === undefined || model.document !== document || model.version !== document.version;
			if (stale) {
				const cached = lastHint;
				if (cached !== undefined && cached.document === document && cached.line === cursor.line
					&& document.lineAt(cursor.line).text.trim() !== '') {
					return [repositionHint(document, cursor.line, cached.hint)];
				}
				return [];
			}
			// Stats are structural, so the previous run is a better placeholder than dropping the
			// rule facts for the whole stats debounce; the next run replaces them in place.
			const grammar = statsDocument === document ? stats : undefined;
			const hints = collectInlayHints(document, model.analysis, grammar, range, cursor, token);
			lastHint = hints.length > 0 ? { document, line: cursor.line, hint: hints[0] } : undefined;
			return hints;
		}
	});
	context.subscriptions.push(hoverProvider, codeLensProvider, inlayProvider);

	const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	status.command = 'clemtoken.showGrammarStats';
	context.subscriptions.push(status);
	updateStatusBar();

	context.subscriptions.push(
		vscode.commands.registerCommand('clemtoken.showGrammarStats', async () => {
			const editor = activeEditor;
			if (!editor || editor.document.languageId !== 'clemtoken') return;
			await ensureModel(editor.document);
			await ensureStats();
			if (current === undefined || stats === undefined || current.document !== editor.document || statsDocument !== editor.document || current.version !== editor.document.version) {
				void vscode.window.showWarningMessage('ClemToken: no stats, the grammar has errors.');
				return;
			}
			statsView.showGrammar(fileName(current.document), GRAMMAR_HEADERS, grammarRows(current.analysis, stats), grammarFlame(current.analysis, stats));
		}),
		vscode.commands.registerCommand('clemtoken.profileGrammar', async () => {
			const editor = activeEditor;
			if (!editor || editor.document.languageId !== 'clemtoken') return;
			if (!available) return;
			try {
				const metrics = await engine.profile(editor.document.getText());
				statsView.showProfile(fileName(editor.document), PROFILE_HEADERS, profileRows(metrics), profileFlame(metrics));
			} catch (e) {
				report(`Profile failed for ${editor.document.uri.fsPath}: ${(e as Error).message}`);
				void vscode.window.showWarningMessage('ClemToken: could not profile the grammar. See the ClemToken output.');
			}
		}),
		vscode.commands.registerCommand('clemtoken.showReferences', async (uri: vscode.Uri, position: vscode.Position) => {
			const locations = await vscode.commands.executeCommand<vscode.Location[] | undefined>('vscode.executeReferenceProvider', uri, position);
			if (locations === undefined || locations.length === 0) return;
			await vscode.commands.executeCommand('editor.action.showReferences', uri, position, locations);
		}),
		vscode.commands.registerCommand('clemtoken.revealDefinition', (uri: string, line: number, column: number) => {
			void vscode.window.showTextDocument(vscode.Uri.parse(uri), { selection: new vscode.Range(line, column, line, column) });
		}),
	);

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
			diagnostics.set(document.uri, collectDiagnostics(analysis));
			current = { document, version, analysis };
			completion = undefined;
			codeLenses.fire();
			inlayHintsChanged.fire();
			updateActiveDecoration();
		} catch (e) {
			report(`Highlighting failed for ${document.uri.fsPath}: ${(e as Error).message}`);
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
		const bracketCount = types.brackets.length;
		for (let index = 0; index < bracketCount; index++) {
			const list = analysis.brackets.filter(bracket => bracket.depth % bracketCount === index);
			editor.setDecorations(types.brackets[index], spans(document, list));
		}
		definitions = analysis.definitions;
		const known = new Set(definitions.map(entry => entry.name));
		references = analysis.references.filter(entry => known.has(entry.name));
	}

	/** Make sure `current` reflects `document` at its latest version, flushing the pending highlight run. */
	async function ensureModel(document: vscode.TextDocument): Promise<void> {
		if (current !== undefined && current.document === document && current.version === document.version) return;
		if (activeEditor === undefined || activeEditor.document !== document) return;
		if (pending !== undefined) {
			clearTimeout(pending);
			pending = undefined;
		}
		await updateDecorations();
	}

	function loadStats(): Promise<void> {
		const editor = activeEditor;
		if (!editor || editor.document.languageId !== 'clemtoken' || !available) {
			updateStatusBar();
			return Promise.resolve();
		}
		const document = editor.document;
		const version = document.version;
		return engine.grammarStats(document.getText(), document.uri.toString(), version).then(
			(result) => {
				if (activeEditor?.document !== document || document.version !== version) return;
				stats = result;
				statsDocument = document;
				statsVersion = version;
			},
			(error: Error) => {
				if (activeEditor?.document !== document || document.version !== version) return;
				stats = undefined;
				statsDocument = document;
				statsVersion = version;
				report(`Grammar stats unavailable for ${document.uri.fsPath}: ${error.message}`);
			},
		).then(() => {
			// a fresh stats run refines the rule details the completion table shows
			completion = undefined;
			updateStatusBar();
			if (statsView.showing === 'grammar') {
				refreshGrammarPanel();
			}
			codeLenses.fire();
			inlayHintsChanged.fire();
		}).catch((error: Error) => {
			// the panel/status refresh threw; keep the extension host alive and record why
			report(`Stats refresh failed: ${error.message}`);
		});
	}

	/** Stats for the current version, running them now if the debounce has not fired yet. */
	async function ensureStats(): Promise<void> {
		const editor = activeEditor;
		if (!editor || editor.document.languageId !== 'clemtoken') return;
		if (statsDocument === editor.document && statsVersion === editor.document.version) return;
		if (statsTimer !== undefined) {
			clearTimeout(statsTimer);
			statsTimer = undefined;
		}
		await loadStats();
	}

	function refreshGrammarPanel(): void {
		const model = current;
		if (model === undefined || stats === undefined || statsDocument !== model.document || statsVersion !== model.version) return;
		statsView.showGrammar(fileName(model.document), GRAMMAR_HEADERS, grammarRows(model.analysis, stats), grammarFlame(model.analysis, stats));
	}

	function updateStatusBar(): void {
		const editor = activeEditor;
		const model = current;
		if (!editor || editor.document.languageId !== 'clemtoken' || !available || stats === undefined || model === undefined || model.document !== editor.document || statsDocument !== model.document || statsVersion !== model.version) {
			status.hide();
			return;
		}
		status.text = `$(symbol-structure) ${stats.ruleCount} rules · ${stats.counts.nodes} nodes`;
		const md = new vscode.MarkdownString();
		md.appendMarkdown(`**Grammar**\n\n`);
		md.appendMarkdown(`${stats.ruleCount} rules, ${stats.specCount} specs, ${stats.counts.nodes} nodes\n\n`);
		md.appendMarkdown(`simple ${stats.counts.simple} · reserved ${stats.counts.reserved} · group ${stats.counts.group} · reference ${stats.counts.reference} · anchor ${stats.counts.anchor} · optional ${stats.counts.optional} · lookahead ${stats.counts.lookahead} · empty ${stats.counts.empty}\n\n`);
		md.appendMarkdown(`Total ${symbolBound(stats.total.low, stats.total.high)} symbols`);
		status.tooltip = md;
		status.show();
	}

	function grammarRows(analysis: Analysis, stats: GrammarStats): StatsRow[] {
		return stats.rules.map((rule) => {
			const uses = analysis.references.reduce((total, ref) => ref.name === rule.name ? total + 1 : total, 0);
			return {
				cells: [rule.name, rule.type, symbolBound(rule.low, rule.high), ruleFlags(rule).join(', '), String(uses)],
				tone: rule.unproductive ? 'bad' as const : undefined,
			};
		});
	}

	function profileRows(metrics: ParseMetrics): StatsRow[] {
		const rows: StatsRow[] = metrics.rules.map((rule) => ({
			cells: [
				rule.name,
				rule.type,
				String(rule.executions),
				String(rule.matches),
				String(rule.failures),
				`${formatBytes(rule.allocatedBytes)} / ${formatBytes(rule.selfAllocatedBytes)}`,
				`${formatDuration(rule.totalMs)} / ${formatDuration(rule.selfMs)}`,
				rule.value ?? '',
			],
		}));
		rows.push({ cells: ['Other (non-rule)', '', '', '', '', formatBytes(metrics.unattributedAllocatedBytes), formatDuration(metrics.unattributedElapsedMs), ''], tone: 'muted' });
		rows.push({ cells: ['TOTAL', '', '', '', '', formatBytes(metrics.totalAllocatedBytes), formatDuration(metrics.totalElapsedMs), ''], tone: 'muted' });
		return rows;
	}

	void updateDecorations();
	scheduleStats();
}

/** Just the base name of a document, for panel subtitles. */
function fileName(document: vscode.TextDocument): string {
	return document.uri.path.split('/').pop() || document.uri.fsPath;
}

export function deactivate() { }
