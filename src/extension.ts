import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
	const keywordColor = vscode.workspace.getConfiguration('clemTokenHighlighter').get('keywordColor', '#569CD6');
	const selectorColor = vscode.workspace.getConfiguration('clemTokenHighlighter').get('selectorColor', '#4EC9B0');
	const nameColor = vscode.workspace.getConfiguration('clemTokenHighlighter').get('nameColor', '#808080');
	const affixColor = vscode.workspace.getConfiguration('clemTokenHighlighter').get('affixColor', '#A9A9A9');

	const nameDecorationType = vscode.window.createTextEditorDecorationType({
		color: nameColor
	});
	const affixDecorationType = vscode.window.createTextEditorDecorationType({
		color: "#FF69B4"//affixColor
	});
	const keywordDecorationType = vscode.window.createTextEditorDecorationType({
		color: keywordColor
	});
	// the $[] selector
	const selectorDecorationType = vscode.window.createTextEditorDecorationType({
		color: selectorColor
	});
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
		updateDecorations();
	}, null, context.subscriptions);
	vscode.languages.onDidChangeDiagnostics(event => {
		if (activeEditor && event.uris.includes(activeEditor.document.uri)) {
			updateDecorations();
		}
	});
	function updateDecorations() {
		if (!activeEditor) return;
		const lang = activeEditor.document.languageId;
		if(lang !== "clemtoken") return;
		const decorations = [] as vscode.DecorationOptions[];
		const sDecorations = [] as vscode.DecorationOptions[];
		const nDecorations = [] as vscode.DecorationOptions[];
		const aDecorations = [] as vscode.DecorationOptions[];
		const text = activeEditor.document.getText().split(/\r?\n/);
		const groupRegex = /^(?:(?<prefix>[^\(\):\+\*\-\s]+:_?|_)(?<token>\((?:[^:\+\*\-()]|(?<subgroup>(?:[^\(\):\+\*\-]+:_?|_)?\(.*\)(?:\+|\*|\d+(?:-\d+)?|_|:)?))*\))(?<suffix>\+|\*|\d+(?:-\d+)?|_|:)?|(?<token_suff>\((?:[^:\+\*\-()]|(?<subgroup_suff>(?:[^\(\):\+\*\-]+:_?|_)?\(.*\)(?:\+|\*|\d+(?:-\d+)?|_|:)?))*\))(?<solo_suffix>\+|\*|\d+(?:-\d+)?|_|:))/;
		for (let i = 0; i < text.length; i++) {
			if(text[i].trim() === "") continue;
			decorationsFromLine(text[i], i, groupRegex, decorations, sDecorations, nDecorations, aDecorations);
		}
		activeEditor.setDecorations(keywordDecorationType, decorations); // not used in V2
		activeEditor.setDecorations(selectorDecorationType, sDecorations); // not used in V2
		activeEditor.setDecorations(nameDecorationType, nDecorations);
		activeEditor.setDecorations(affixDecorationType, aDecorations);
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
	offset: number = 0
) {
	for(let i = 0; i < lineText.length; i++) {
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
			const range = new vscode.Range(
				lineNumber, offset + i - accumulator.length + 2,
				lineNumber, offset + i - 1
			);
			if (accumulator.startsWith("$[") && accumulator.endsWith("]")) {
				wdecorations.push({ range });
			}
			continue;
		}
		const [name, size] = extractGroupName(verificationResult[1], verificationResult[2]);
		let end = lineText.indexOf('(', i);
		let stack = 0;
		for(; end < lineText.length; end++) {
			if(lineText[end] === "(") {
				stack++;
			}
			if(lineText[end] === ")") {
				stack--;
			}
			if(stack === 0) {
				break;
			}
		}
		if(end === lineText.length) {
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
		let postFix = end+1;
		for(; postFix < lineText.length; postFix++) {
			if(lineText[postFix] === ")" || lineText[postFix] === " ") {
				break;
			}
		}
		const suffixRange = new vscode.Range(
			lineNumber, offset + end+1,
			lineNumber, offset + postFix
		);
		aDecorations.push({ range: suffixRange });
		i = postFix;
		const subStart = prefixRange.end.character-offset+1;
		const subline = lineText.substring(subStart, end);
		decorationsFromLine(subline, lineNumber, groupRegex, wdecorations, sDecorations, nDecorations, aDecorations, subStart+offset);
	}
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
