import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
	activateGrammar(context);
	activateAbstract(context);
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
		if (event.document.languageId) return;
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
				if (line > document.lineCount) return [[], line];
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
	var word = document.getWordRangeAtPosition(new vscode.Position(lineNumber, whitespaceAmount), /\w+:/);
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

function activateGrammar(context: vscode.ExtensionContext) {
	const keywordColor = vscode.workspace.getConfiguration('clemtoken').get('keywordColor', '#4a9d4cff');
	const selectorColor = vscode.workspace.getConfiguration('clemtoken').get('selectorColor', '#4EC9B0');
	const nameColor = vscode.workspace.getConfiguration('clemtoken').get('nameColor', '#808080');
	const affixColor = vscode.workspace.getConfiguration('clemtoken').get('affixColor', '#FF69B4');
	const titleColor = vscode.workspace.getConfiguration('clemtoken').get('titleColor', '#02adf6ff');
	const anchorColor = vscode.workspace.getConfiguration('clemtoken').get('anchorColor', '#569CD6');
	const anchorBaseColor = vscode.workspace.getConfiguration('clemtoken').get('anchorBaseColor', '#8eb5d4ff');
	const optionalColor = vscode.workspace.getConfiguration('clemtoken').get('optionalColor', '#FFB6C1');
	const specColor = vscode.workspace.getConfiguration('clemtoken').get('specColor', '#dcdcaa');
	const specModeColor = vscode.workspace.getConfiguration('clemtoken').get('specModeColor', '#9cdcfe');
	const specRegexColor = vscode.workspace.getConfiguration('clemtoken').get('specRegexColor', '#c586c0');
	const lookaheadColor = vscode.workspace.getConfiguration('clemtoken').get('lookaheadColor', '#209b49');
	const lookaheadTextColor = vscode.workspace.getConfiguration('clemtoken').get('lookaheadTextColor', '#31f227');

	const titleDecorationType = vscode.window.createTextEditorDecorationType({
		color: titleColor
	});
	const nameDecorationType = vscode.window.createTextEditorDecorationType({
		color: nameColor
	});
	const affixDecorationType = vscode.window.createTextEditorDecorationType({
		color: affixColor
	});
	const keywordDecorationType = vscode.window.createTextEditorDecorationType({
		color: keywordColor
	});
	// the $[] selector
	const selectorDecorationType = vscode.window.createTextEditorDecorationType({
		color: selectorColor
	});
	const anchorDecorationType = vscode.window.createTextEditorDecorationType({
		color: anchorColor
	});
	const anchorBaseDecorationType = vscode.window.createTextEditorDecorationType({
		color: anchorBaseColor
	});
	const optionalDecorationType = vscode.window.createTextEditorDecorationType({
		color: optionalColor
	});
	const specDecorationType = vscode.window.createTextEditorDecorationType({
		color: specColor
	});
	const specModeDecorationType = vscode.window.createTextEditorDecorationType({
		color: specModeColor
	});
	const specRegexDecorationType = vscode.window.createTextEditorDecorationType({
		color: specRegexColor
	});
	const lookaheadDecorationType = vscode.window.createTextEditorDecorationType({
		color: lookaheadColor
	});
	const lookaheadTextDecorationType = vscode.window.createTextEditorDecorationType({
		color: lookaheadTextColor
	});
	const uncreatedAnchors = [] as { line: number, column: number, size: number, name: string }[];
	const createdAnchors = [] as { line: number, column: number, size: number, name: string }[];
	const references = [] as { line: number, column: number, size: number, name: string }[];
	let activeEditor = vscode.window.activeTextEditor;
	vscode.window.onDidChangeActiveTextEditor(editor => {
		activeEditor = editor;
		if (editor) {
			updateDecorations();
		}
	}, null, context.subscriptions);
	vscode.workspace.onDidChangeTextDocument(event => {
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
	const documentSymbolProvider = vscode.languages.registerDocumentSymbolProvider({ language: 'clemtoken' }, {
		provideDocumentSymbols(document, token) {
			var result = [...createdAnchors.map(anchor => {
				return new vscode.DocumentSymbol(
					anchor.name,
					'',
					vscode.SymbolKind.Function,
					new vscode.Range(anchor.line, anchor.column, anchor.line, anchor.column + anchor.size),
					new vscode.Range(anchor.line, anchor.column, anchor.line, anchor.column + anchor.size)
				);
			}), ...references.map(ref => {
				return new vscode.DocumentSymbol(
					ref.name,
					'',
					vscode.SymbolKind.Function,
					new vscode.Range(ref.line, ref.column, ref.line, ref.column + ref.size),
					new vscode.Range(ref.line, ref.column, ref.line, ref.column + ref.size)
				);
			})];
			return result;
		}
	});
	const refProvider = vscode.languages.registerReferenceProvider({ language: 'clemtoken' }, {
		provideReferences(document, position, context, token) {
			var reference = references.find(ref => {
				return ref.line === position.line && position.character >= ref.column && position.character < ref.column + ref.size;
			}) ?? createdAnchors.find(anchor => {
				return anchor.line === position.line && position.character >= anchor.column && position.character < anchor.column + anchor.size;
			});
			if (!reference) return null;
			return references.filter(ref => ref.name === reference?.name).map(ref => {
				return new vscode.Location(
					document.uri,
					new vscode.Range(ref.line, ref.column, ref.line, ref.column + ref.size)
				);
			});
		}
	});
	const dProvider = vscode.languages.registerDefinitionProvider({ language: 'clemtoken' }, {
		provideDefinition(document, position, token) {
			const reference = references.find(ref => {
				return ref.line === position.line && position.character >= ref.column && position.character < ref.column + ref.size;
			});
			if (!reference) return null;
			for (const anchor of createdAnchors) {
				if (anchor.name === reference.name) {
					return new vscode.Location(
						document.uri,
						new vscode.Range(anchor.line, anchor.column, anchor.line, anchor.column + anchor.size)
					);
				}
			}
			return null;
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
					return uncreatedAnchors.map(anchor => {
						const item = new vscode.CompletionItem(anchor.name + ":", vscode.CompletionItemKind.Function);
						item.range = new vscode.Range(word.start, word.end);
						return item;
					});
				}
				const preStr = text.substring(0, text.indexOf("@"));
				return createdAnchors.map(anchor => {

					const item = new vscode.CompletionItem(preStr + anchor.name, vscode.CompletionItemKind.Function);
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
	function updateDecorations() {
		if (!activeEditor) return;
		const lang = activeEditor.document.languageId;
		if (lang !== "clemtoken") return;
		const decorations = [] as vscode.DecorationOptions[];
		const sDecorations = [] as vscode.DecorationOptions[];
		const nDecorations = [] as vscode.DecorationOptions[];
		const aDecorations = [] as vscode.DecorationOptions[];
		const tDecorations = [] as vscode.DecorationOptions[];
		const anDecorations = [] as vscode.DecorationOptions[];
		const anbDecorations = [] as vscode.DecorationOptions[];
		const optDecorations = [] as vscode.DecorationOptions[];
		const specDecorations = [] as vscode.DecorationOptions[];
		const specmDecorations = [] as vscode.DecorationOptions[];
		const specrDecorations = [] as vscode.DecorationOptions[];
		const lDecorations = [] as vscode.DecorationOptions[];
		const ltDecorations = [] as vscode.DecorationOptions[];
		const text = activeEditor.document.getText().split(/\r?\n/);
		const groupRegex = /^(?:(?<prefix>[^\[\(\):\+\*\-\s]+:_?|_)(?<token>\((?:(?<subgroup>(?:[^\[\(\):\+\*\-\s]+:_?|_)?\( .* \):?(?:\+|\?|\*|\d+(?:-\d+)?|_|:))|.)*\))(?<suffix>:?(?:\+|\?|\*|\d+(?:-\d+)?|_|:)?))|^(?:(?<post_token>\((?:(?<subgroup_post>(?:[^\[\(\):\+\*\-\s]+:_?|_)?\( .* \):?(?:\+|\?|\*|\d+(?:-\d+)?|_|:))|.)*\))(?<solo_suffix>:?(?:\+|\?|\*|\d+(?:-\d+)?|_|:)))/;
		createdAnchors.length = 0;
		uncreatedAnchors.length = 0;
		references.length = 0;
		for (let i = 0; i < text.length; i++) {
			if (text[i].trim() === "") continue;
			if (text[i][0] === "#") {
				tDecorations.push({
					range: new vscode.Range(i, 0, i, text[i].length)
				});
				continue;
			}
			decorationsFromLine(text[i], i, groupRegex, decorations, sDecorations, nDecorations, aDecorations, anDecorations, anbDecorations,
				optDecorations, specDecorations, specmDecorations, specrDecorations, lDecorations, ltDecorations,
				createdAnchors, uncreatedAnchors, references);
		}
		activeEditor.setDecorations(optionalDecorationType, optDecorations);
		activeEditor.setDecorations(anchorBaseDecorationType, anbDecorations);
		activeEditor.setDecorations(anchorDecorationType, anDecorations);
		activeEditor.setDecorations(titleDecorationType, tDecorations);
		activeEditor.setDecorations(keywordDecorationType, decorations);
		activeEditor.setDecorations(selectorDecorationType, sDecorations); // not used in V2
		activeEditor.setDecorations(nameDecorationType, nDecorations);
		activeEditor.setDecorations(affixDecorationType, aDecorations);
		activeEditor.setDecorations(specDecorationType, specDecorations);
		activeEditor.setDecorations(specModeDecorationType, specmDecorations);
		activeEditor.setDecorations(specRegexDecorationType, specrDecorations);
		activeEditor.setDecorations(lookaheadDecorationType, lDecorations);
		activeEditor.setDecorations(lookaheadTextDecorationType, ltDecorations);
		for (let i = uncreatedAnchors.length - 1; i >= 0; i--) {
			let found = false;
			for (let j = 0; j < createdAnchors.length; j++) {
				if (createdAnchors[j].name == uncreatedAnchors[i].name) {
					found = true;
					break;
				}
			}
			if (found) {
				references.push(...uncreatedAnchors.splice(i, 1));
			}
		}
	}
}
function decorationsFromLine(
	lineText: string,
	lineNumber: number,
	groupRegex: RegExp,
	wDecorations: vscode.DecorationOptions[], // word inside selector decorations
	sDecorations: vscode.DecorationOptions[], // selector decorations
	nDecorations: vscode.DecorationOptions[], // name decorations
	aDecorations: vscode.DecorationOptions[], // affix decorations
	anDecorations: vscode.DecorationOptions[], // anchor decorations
	anbDecorations: vscode.DecorationOptions[], // anchor base decorations
	optDecorations: vscode.DecorationOptions[], // optional decorations
	specDecorations: vscode.DecorationOptions[], // spec decorations
	specmDecorations: vscode.DecorationOptions[], // spec mode decorations
	specrDecorations: vscode.DecorationOptions[], // spec regex decorations
	lDecorations: vscode.DecorationOptions[] = [], // lookahead decorations
	ltDecorations: vscode.DecorationOptions[] = [], // lookahead text decorations
	createdAnchors: { line: number, column: number, size: number, name: string }[],
	uncreatedAnchors: { line: number, column: number, size: number, name: string }[],
	references: { line: number, column: number, size: number, name: string }[],
	offset: number = 0
) {
	if (lineText.startsWith('$')) {
		let indexColon = lineText.indexOf(':');
		if (indexColon != -1 && (lineText.substring(1, indexColon).match(/^\w+$/))) {
			specDecorations.push({
				range: new vscode.Range(
					lineNumber, offset,
					lineNumber, offset + indexColon + 1
				)
			});
			const modeIndex = lineText.substring(indexColon + 1).indexOf(':');
			if (modeIndex != -1 && lineText.substring(indexColon + 1, indexColon + 1 + modeIndex).match(/^\w+$/)) {
				specmDecorations.push({
					range: new vscode.Range(
						lineNumber, offset + indexColon + 1,
						lineNumber, offset + indexColon + 1 + modeIndex + 1
					)
				});
				indexColon = modeIndex + indexColon + 1;
			}
			specrDecorations.push({
				range: new vscode.Range(
					lineNumber, offset + indexColon + 1,
					lineNumber, offset + lineText.length
				)
			});
			return;
		}
	}
	for (let i = 0; i < lineText.length; i++) {
		if (lineText[i].trim() === "") {
			continue;
		}
		const remainingText = lineText.substring(i);
		// we don't actually know if we can trust the group regex when it comes to the bounds of the group
		const verificationResult = VerifyGroup(groupRegex, remainingText);
		if (!verificationResult[0]) {
			let accumulator = "";
			while (i < lineText.length && !lineText[i].match(/\s/)) {
				accumulator += lineText[i];
				i++;
			}
			if (accumulator.startsWith("[") && !accumulator.includes("]") && !accumulator.includes("|")) {
				const closingOpt = pairedIndex(lineText, "[", "]", i - accumulator.length + 1, 1);
				const initialLength = accumulator.length;
				if (closingOpt != -1) {
					// in case it starts by an optional
					if (accumulator[1] == "[") {
						decorationsFromLine(accumulator.slice(1) + lineText.substring(i), lineNumber, groupRegex,
							wDecorations, sDecorations, nDecorations, aDecorations, anDecorations, anbDecorations,
							optDecorations, specDecorations, specmDecorations, specrDecorations, lDecorations, ltDecorations,
							createdAnchors, uncreatedAnchors, references, offset + i - accumulator.length + 1);
					}
					// in case it starts by a group
					if (accumulator.includes("(")) {
						const innerGroupResult = VerifyGroup(groupRegex, accumulator.slice(1) + lineText.substring(i))
						if (innerGroupResult[0]) {
							let end, postFix, prefixEnd;
							[prefixEnd, end, postFix] = decorateFromGroupResult(innerGroupResult, lineNumber, offset, lineText, i - accumulator.length + 1, nDecorations, aDecorations);
							const subStart = prefixEnd - offset + 1;
							const subline = lineText.substring(subStart, end);
							decorationsFromLine(subline, lineNumber, groupRegex,
								wDecorations, sDecorations, nDecorations, aDecorations, anDecorations, anbDecorations,
								optDecorations, specDecorations, specmDecorations, specrDecorations, lDecorations, ltDecorations,
								createdAnchors, uncreatedAnchors, references, subStart + offset);
						}
					}
					if (accumulator[1] == "@" || (accumulator[1] == "?" && accumulator[2] == "@")) {
						uncreatedAnchors.push({
							line: lineNumber,
							column: offset + i - accumulator.length + 1,
							size: accumulator.length - 1,
							name: accumulator.slice(1)
						});
						anbDecorations.push({
							range: new vscode.Range(
								lineNumber, offset + i - accumulator.length + 1,
								lineNumber, offset + i - accumulator.length + 2
							)
						});
						anDecorations.push({
							range: new vscode.Range(
								lineNumber, offset + i - accumulator.length + 2,
								lineNumber, offset + i
							)
						});
					}
					accumulator += lineText.substring(i, closingOpt + 1);
					optDecorations.push({ // [
						range: new vscode.Range(
							lineNumber, offset + i - initialLength,
							lineNumber, offset + i - initialLength + 1
						)
					});
					optDecorations.push({ // ]
						range: new vscode.Range(
							lineNumber, offset + closingOpt,
							lineNumber, offset + closingOpt + 1
						)
					});
					const allOr = [...lineText.substring(i, closingOpt).matchAll(/\s\|\s/g)];
					for (const match of allOr) {
						optDecorations.push({
							range: new vscode.Range(
								lineNumber, offset + i + match.index,
								lineNumber, offset + i + match.index + 1
							)
						});
					}
				}
			}
			if (accumulator.startsWith("$[") || accumulator.startsWith("$$[") && accumulator.endsWith("]")) {
				wDecorations.push({
					range: new vscode.Range(
						lineNumber, offset + i - accumulator.length + (accumulator.startsWith("$$[") ? 3 : 2),
						lineNumber, offset + i - 1
					)
				});
				sDecorations.push({
					range: new vscode.Range(
						lineNumber, offset + i - accumulator.length,
						lineNumber, offset + i
					)
				});
			}
			if (accumulator.startsWith("@>")) {
				if (accumulator.startsWith("@>>")) {
					// optional lookahead
					lDecorations.push({
						range: new vscode.Range(
							lineNumber, offset + i - accumulator.length,
							lineNumber, offset + i - accumulator.length + 3
						)
					});
					optDecorations.push({ // [
						range: new vscode.Range(
							lineNumber, offset + i - accumulator.length + 3,
							lineNumber, offset + i - accumulator.length + 4
						)
					});
					const endIndex = lineText.substring(i).search(/[^\s]\]/);
					if (endIndex == -1) {
						continue;
					} else
					{
						let cursor = i - 4;
						const startCursor = cursor;
						const allOr = [...lineText.substring(cursor, i + endIndex).matchAll(/\s\|\s/g)];
						if (allOr.length == 0) {
							ltDecorations.push({ // before ]
								range: new vscode.Range(
									lineNumber, offset + cursor,
									lineNumber, offset + endIndex
								)
							});
							lDecorations.push({ // ]
								range: new vscode.Range(
									lineNumber, offset + endIndex,
									lineNumber, offset + endIndex + 1
								)
							});
							i += endIndex + 1;
							continue;
						}
						for (const match of allOr) {
							ltDecorations.push({
								range: new vscode.Range( // before |
									lineNumber, offset + i,
									lineNumber, offset + startCursor + match.index
								)
							});
							optDecorations.push({
								range: new vscode.Range( // |
									lineNumber, offset + startCursor + match.index,
									lineNumber, offset + startCursor + match.index + 1
								)
							});
							cursor = startCursor + match.index + 1;
						}
						ltDecorations.push({ // after last |
							range: new vscode.Range(
								lineNumber, offset + cursor,
								lineNumber, offset + endIndex
							)
						});
						lDecorations.push({ // ]
							range: new vscode.Range(
								lineNumber, offset + i + endIndex + 1,
								lineNumber, offset + i + endIndex + 2
							)
						});
						i += endIndex + 1;
					}
				}
				lDecorations.push({
					range: new vscode.Range(
						lineNumber, offset + i - accumulator.length,
						lineNumber, offset + i - accumulator.length + 2
					)
				});
				ltDecorations.push({
					range: new vscode.Range(
						lineNumber, offset + i - accumulator.length + 2,
						lineNumber, offset + i
					)
				});
			}
			else if (accumulator.startsWith("@") || (accumulator.startsWith("?@") || accumulator.includes(":@") || accumulator.includes(":?@"))) {
				let cutShort = false;
				if (accumulator[accumulator.length - 1] === ":") {
					cutShort = true;
					if (accumulator[accumulator.length-2] === "?") {
						createdAnchors.push({
							line: lineNumber,
							column: offset + i - accumulator.length + 2,
							size: accumulator.length - 2,
							name: accumulator.slice(2, -2)
						});
						aDecorations.push({
							range: new vscode.Range(
								lineNumber, offset + i - 2,
								lineNumber, offset + i - 1
							)
						});
					}
					createdAnchors.push({
						line: lineNumber,
						column: offset + i - accumulator.length + 1,
						size: accumulator.length - 1,
						name: accumulator.slice(0, -1)
					});
				} else if (accumulator[accumulator.length - 1] === "]") {
					cutShort = true;
					uncreatedAnchors.push({
						line: lineNumber,
						column: offset + i - accumulator.length + 1,
						size: accumulator.length - 1,
						name: accumulator.slice(0, -1)
					});
				} else {
					if (accumulator.startsWith("@")) {
						uncreatedAnchors.push({
							line: lineNumber,
							column: offset + i - accumulator.length,
							size: accumulator.length,
							name: accumulator
						});
					} else if (accumulator.startsWith("?@")) {
						aDecorations.push({
							range: new vscode.Range(
								lineNumber, offset + i - accumulator.length,
								lineNumber, offset + i - accumulator.length + 1
							)
						});
						uncreatedAnchors.push({
							line: lineNumber,
							column: offset + i - accumulator.length + 1,
							size: accumulator.length - 1,
							name: accumulator.slice(1)
						});
					} else {
						const nameEndIndex = accumulator.indexOf(":");
						const atIndex = accumulator.indexOf("@");
						const questionIndex = accumulator.indexOf("?");
						nDecorations.push({
							range: new vscode.Range(
								lineNumber, offset + i - accumulator.length,
								lineNumber, offset + i - accumulator.length + nameEndIndex
							)
						});
						aDecorations.push({
							range: new vscode.Range(
								lineNumber, offset + i - accumulator.length + nameEndIndex,
								lineNumber, offset + i - accumulator.length + nameEndIndex + (questionIndex == -1 ? 1 : 2)
							)

						});
						uncreatedAnchors.push({
							line: lineNumber,
							column: offset + i - accumulator.length + atIndex,
							size: accumulator.length - atIndex,
							name: accumulator.slice(atIndex)
						});
					}
				}
				anbDecorations.push({
					range: new vscode.Range(
						lineNumber, offset + i - accumulator.length,
						lineNumber, offset + i - accumulator.length + 1
					)
				});
				anDecorations.push({
					range: new vscode.Range(
						lineNumber, offset + i - accumulator.length + 1,
						lineNumber, offset + i - (cutShort ? 1 : 0)
					)
				});
			}
			continue;
		}
		let end, postFix, prefixEnd;
		[i, prefixEnd, end, postFix] = decorateFromGroupResult(verificationResult, lineNumber, offset, lineText, i, nDecorations, aDecorations);
		i = postFix;
		const subStart = prefixEnd - offset + 1;
		const subline = lineText.substring(subStart, end);
		decorationsFromLine(subline, lineNumber, groupRegex,
			wDecorations, sDecorations, nDecorations, aDecorations, anDecorations, anbDecorations,
			optDecorations, specDecorations, specmDecorations, specrDecorations, lDecorations, ltDecorations,
			createdAnchors, uncreatedAnchors, references, subStart + offset);
	}
}

function decorateFromGroupResult(
	groupResult: [boolean, string, string, string, boolean],
	lineNumber: number,
	offset: number,
	lineText: string,
	i: number,
	nDecorations: vscode.DecorationOptions[],
	aDecorations: vscode.DecorationOptions[],
): [number, number, number, number] {
	const [name, size] = extractGroupName(groupResult[1], groupResult[2]);
	let end = lineText.indexOf('(', i);
	let stack = 0;
	for (; end < lineText.length; end++) {
		if (lineText[end] === "(") {
			stack++;
		}
		if (lineText[end] === ")") {
			stack--;
		}
		if (stack === 0) {
			break;
		}
	}
	if (end === lineText.length) {
		end = lineText.length - 1;
	}
	const nameRange = new vscode.Range(
		lineNumber, offset + i,
		lineNumber, offset + i + name.length
	);
	const prefixRange = new vscode.Range(
		lineNumber, offset + i + name.length,
		lineNumber, offset + i + name.length + size + +(name.length > 0)
	);
	nDecorations.push({ range: nameRange });
	aDecorations.push({ range: prefixRange });
	i += name.length + size;
	let postFix = end + 1;
	for (; postFix < lineText.length; postFix++) {
		if (lineText[postFix] === ")" || lineText[postFix] === " " || lineText[postFix] === "\n" || lineText[postFix] === "]") {
			break;
		}
	}
	const suffixRange = new vscode.Range(
		lineNumber, offset + end + 1,
		lineNumber, offset + postFix
	);
	aDecorations.push({ range: suffixRange });
	return [i, prefixRange.end.character, end, postFix];

}

function pairedIndex(text: string, open: string, close: string, start: number = 0, startState: number = 0): number {
	let depth = startState;
	let skipNext = false;
	for (let i = start; i < text.length; i++) {
		if (!skipNext) {
			if (text[i] === '\\') {
				skipNext = true;
				continue;
			}
			if (text[i] === open) depth++;
			if (text[i] === close) depth--;
		}
		else {
			skipNext = false;
		}
		if (depth === 0) return i;
	}
	return -1;
}

function VerifyGroup(groupRegex: RegExp, text: string): [boolean, string, string, string, boolean] {
	if (!text.includes('(') || !text.includes(')')) {
		return [false, "", "", "", false];
	}
	let match;
	match = groupRegex.exec(text);
	if (!match || !match.groups) {
		return [false, "", "", "", false];
	}
	if (match.groups.token) {
		return [true, match.groups.token, match.groups.prefix, match.groups.suffix, !!match.groups.subgroup];
	} else {
		return [true, match.groups.post_token, "", match.groups.solo_suffix, !!match.groups.subgroup_post];
	}
}
function extractGroupName(value: string, prefix: string): [string, number] {
	let postNameSize = 0;
	let name = "";
	if (prefix && prefix.trim() !== "" && prefix.includes(":")) {
		const parts = prefix.split(':');
		if (parts.length > 2) {
			throw new Error("Cannot have more than one name to a group: " + prefix);
		}
		name = parts[0];
		postNameSize = parts[1].length;
	} else {
		postNameSize = prefix.length;
	}
	return [name, postNameSize];
}
export function deactivate() { }
