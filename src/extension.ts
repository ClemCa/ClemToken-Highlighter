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
			const word = document.getWordRangeAtPosition(position, /\@|(?:\$\[?)\w*/);
			if (!word) return [];
			const text = document.getText(word);
			if (!text) return [];
			if (text.startsWith("@")) {
				if (word.start.character === 0) {
					return uncreatedAnchors.map(anchor => {
						const item = new vscode.CompletionItem(anchor.name + ":", vscode.CompletionItemKind.Function);
						item.range = new vscode.Range(word.start, word.end);
						return item;
					});
				}
				return createdAnchors.map(anchor => {
					const item = new vscode.CompletionItem(anchor.name, vscode.CompletionItemKind.Function);
					item.range = new vscode.Range(word.start, word.end);
					return item;
				});
			} else if (text.startsWith("$")) {
				return [
					"$[name]",
					"$[digit]",
					"$$[name]",
					"$$[digit]"
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
		const text = activeEditor.document.getText().split(/\r?\n/);
		const groupRegex = /^(?:(?<prefix>[^\[\(\):\+\*\-\s]+:_?|_)(?<token>\((?:[^:\+\*\-()]|(?<subgroup>(?:[^\(\):\+\*\-]+:_?|_)?\(.*\):?(?:\+|\*|\d+(?:-\d+)?|_|:)?))*\))(?<suffix>:?(?:\+|\*|\d+(?:-\d+)?|_|:))?|(?<token_suff>\((?:[^:\+\*\-()]|(?<subgroup_suff>:?(?:[^\(\):\+\*\-]+:_?|_)?\(.*\)(?:\+|\*|\d+(?:-\d+)?|_|:)?))*\))(?<solo_suffix>:?(?:\+|\*|\d+(?:-\d+)?|_|:)))/;
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
			decorationsFromLine(text[i], i, groupRegex, decorations, sDecorations, nDecorations, aDecorations, anDecorations, anbDecorations, optDecorations,
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
	wdecorations: vscode.DecorationOptions[], // word inside selector decorations
	sDecorations: vscode.DecorationOptions[], // selector decorations
	nDecorations: vscode.DecorationOptions[], // name decorations
	aDecorations: vscode.DecorationOptions[], // affix decorations
	anDecorations: vscode.DecorationOptions[], // anchor decorations
	anbDecorations: vscode.DecorationOptions[], // anchor base decorations
	optDecorations: vscode.DecorationOptions[], // optional decorations
	createdAnchors: { line: number, column: number, size: number, name: string }[],
	uncreatedAnchors: { line: number, column: number, size: number, name: string }[],
	references: { line: number, column: number, size: number, name: string }[],
	offset: number = 0
) {
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
				const closingOpt = lineText.substring(i).indexOf("]");
				const initialLength = accumulator.length;
				if (closingOpt != -1) {
					// in case it starts by a group
					if (accumulator.includes("(")) {
						console.log("Checking for group: " + accumulator.slice(1) + lineText.substring(i));
						const innerGroupResult = VerifyGroup(groupRegex, accumulator.slice(1) + lineText.substring(i))
						if (innerGroupResult[0]) {
							let end, postFix, prefixEnd;
							[prefixEnd, end, postFix] = decorateFromGroupResult(innerGroupResult, lineNumber, offset, lineText, i-accumulator.length+1, nDecorations, aDecorations);
							const subStart = prefixEnd - offset + 1;
							const subline = lineText.substring(subStart, end);
							decorationsFromLine(subline, lineNumber, groupRegex, wdecorations, sDecorations, nDecorations, aDecorations, anDecorations, anbDecorations, optDecorations, createdAnchors, uncreatedAnchors, references, subStart + offset);
						}
					}
					if (accumulator[1] == "@") {
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
					accumulator += lineText.substring(i, i + closingOpt + 1);
					optDecorations.push({ // [
						range: new vscode.Range(
							lineNumber, offset + i - initialLength,
							lineNumber, offset + i - initialLength + 1
						)
					});
					optDecorations.push({ // ]
						range: new vscode.Range(
							lineNumber, offset + i + closingOpt,
							lineNumber, offset + i + closingOpt + 1
						)
					});
					const allOr = [...lineText.substring(i, i + closingOpt).matchAll(/\s\|\s/g)];
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
				wdecorations.push({
					range: new vscode.Range(
						lineNumber, offset + i - accumulator.length + (accumulator.startsWith("$$[") ? 3 : 2),
						lineNumber, offset + i - 1
					)
				});
				sDecorations.push({
					range: new vscode.Range(
						lineNumber, offset + i - accumulator.length,
						lineNumber, offset + i + (accumulator.startsWith("$$[") ? 1 : 0)
					)
				});
			}
			if (accumulator.startsWith("@")) {
				let cutShort = false;
				if (accumulator[accumulator.length - 1] === ":") {
					cutShort = true;
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
					uncreatedAnchors.push({
						line: lineNumber,
						column: offset + i - accumulator.length,
						size: accumulator.length,
						name: accumulator
					});
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
		decorationsFromLine(subline, lineNumber, groupRegex, wdecorations, sDecorations, nDecorations, aDecorations, anDecorations, anbDecorations, optDecorations, createdAnchors, uncreatedAnchors, references, subStart + offset);
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
		return [true, match.groups.token_suff, "", match.groups.solo_suffix, !!match.groups.subgroup_suff];
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
