import * as vscode from 'vscode';
import { ROW_HEIGHT, StatsFlame, flameData, flameScript } from './flame';

export type { StatsFlame } from './flame';

export interface StatsRow {
	cells: string[];
	tone?: 'bad' | 'muted';
}

interface Latest {
	title: string;
	subtitle: string;
	headers: string[];
	rows: StatsRow[];
	flame?: StatsFlame;
}

/**
 * One reusable panel for the `analyze`/`profile` tables and their flame graphs. The tables are static markup;
 * the flame graph ships its tree as JSON plus a small script (see `flame.ts`) so it can be zoomed
 * and hovered. Both are themed with VS Code's CSS variables and gated by a per-render CSP nonce.
 */
export class StatsView implements vscode.Disposable {
	private panel: vscode.WebviewPanel | undefined;
	private kind: 'grammar' | 'profile' | undefined;
	private latest: Latest | undefined;

	/** Which table the panel is currently showing, or `undefined` when it is closed. */
	get showing(): 'grammar' | 'profile' | undefined {
		return this.panel === undefined ? undefined : this.kind;
	}

	showGrammar(subtitle: string, headers: string[], rows: StatsRow[], flame?: StatsFlame): void {
		this.render('grammar', 'Grammar Stats', subtitle, headers, rows, flame);
	}

	showProfile(subtitle: string, headers: string[], rows: StatsRow[], flame?: StatsFlame): void {
		this.render('profile', 'Parse Profile', subtitle, headers, rows, flame);
	}

	dispose(): void {
		this.panel?.dispose();
	}

	private render(kind: 'grammar' | 'profile', title: string, subtitle: string, headers: string[], rows: StatsRow[], flame?: StatsFlame): void {
		this.kind = kind;
		this.latest = { title, subtitle, headers, rows, flame };
		if (this.panel === undefined) {
			this.panel = vscode.window.createWebviewPanel('clemtoken.stats', title, vscode.ViewColumn.Active, {
				enableScripts: true,
			});
			this.panel.onDidDispose(() => { this.panel = undefined; }, null);
		} else {
			this.panel.title = title;
			this.panel.reveal();
		}
		this.panel.webview.html = this.html();
	}

	private html(): string {
		const latest = this.latest;
		if (latest === undefined) {
			return '<!DOCTYPE html><html><body></body></html>';
		}
		const nonce = createNonce();
		const head = latest.headers.map((header) => `<th>${escapeHtml(header)}</th>`).join('');
		const body = latest.rows.map((row) => {
			const cells = row.cells.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('');
			return row.tone === undefined ? `<tr class="row">${cells}</tr>` : `<tr class="row ${row.tone}">${cells}</tr>`;
		}).join('\n');
		const flame = latest.flame === undefined ? '' : this.flameHtml(latest.flame);
		const script = latest.flame === undefined ? '' : this.flameScriptTag(latest.flame, nonce);
		return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
	body {
		font-family: var(--vscode-font-family);
		color: var(--vscode-foreground);
		padding: 12px 16px;
	}
	h1 { font-size: 1.15em; font-weight: 600; margin: 0 0 10px; }
	h1 span { font-weight: 400; opacity: 0.7; }
	h2 { font-size: 0.95em; font-weight: 600; margin: 0 0 6px; opacity: 0.85; }
	table {
		border-collapse: collapse;
		font-family: var(--vscode-editor-font-family);
		font-size: var(--vscode-editor-font-size);
	}
	th, td { text-align: left; padding: 2px 18px 2px 0; white-space: pre; }
	th { border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 5px; }
	tr.bad td { color: var(--vscode-errorForeground); }
	tr.muted td { opacity: 0.7; }
	tr.row { cursor: pointer; }
	tr.row:hover td { background: var(--vscode-list-hoverBackground); }
	tr.row[hidden] { display: none; }
	.flame-bar { display: flex; align-items: center; gap: 8px; margin: 0 0 6px; }
	.flame-search {
		width: 220px;
		padding: 2px 6px;
		font-family: var(--vscode-font-family);
		font-size: 12px;
		color: var(--vscode-input-foreground);
		background: var(--vscode-input-background);
		border: 1px solid var(--vscode-input-border, transparent);
		border-radius: 2px;
		outline: none;
	}
	.flame-search:focus { border-color: var(--vscode-focusBorder); }
	.flame-clear {
		padding: 2px 8px;
		font-family: var(--vscode-font-family);
		font-size: 11px;
		color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
		background: var(--vscode-button-secondaryBackground, transparent);
		border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
		border-radius: 2px;
		cursor: pointer;
	}
	.flame-clear:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground)); }
	.flame-clear[hidden] { display: none; }
	.flame-count { font-size: 11px; opacity: 0.7; }
	.flame-crumb {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px;
		margin: 0 0 5px;
		font-size: 11px;
	}
	.flame-crumb .item { color: var(--vscode-textLink-foreground); text-decoration: none; cursor: pointer; }
	.flame-crumb .item.reset { opacity: 0.8; }
	.flame-crumb .item.current { color: var(--vscode-foreground); cursor: default; font-weight: 600; }
	.flame-crumb .sep { opacity: 0.5; }
	.flame {
		position: relative;
		width: 100%;
		margin: 0 0 16px;
		font-family: var(--vscode-editor-font-family);
		user-select: none;
	}
	.flame .frame {
		position: absolute;
		box-sizing: border-box;
		height: ${ROW_HEIGHT}px;
		line-height: ${ROW_HEIGHT - 2}px;
		padding: 0 3px;
		overflow: hidden;
		white-space: nowrap;
		font-size: 11px;
		color: #fff;
		text-shadow: 0 0 2px rgba(0, 0, 0, 0.75);
		border: 1px solid transparent;
		cursor: pointer;
		transition: opacity 0.08s ease;
	}
	.flame .frame.muted { opacity: 0.55; }
	.flame .frame.dim { opacity: 0.22; }
	.flame .frame.ancestor { filter: brightness(1.3); }
	.flame .frame.descendant { filter: brightness(1.12); }
	.flame .frame.match { outline: 1px dashed rgba(255, 255, 255, 0.9); outline-offset: -2px; }
	.flame .frame.hover { outline: 2px solid var(--vscode-focusBorder, #ffffff); outline-offset: -2px; z-index: 4; }
	.flame-tip {
		position: fixed;
		z-index: 20;
		pointer-events: none;
		max-width: 440px;
		padding: 6px 9px;
		font-family: var(--vscode-font-family);
		font-size: 11px;
		line-height: 1.45;
		color: var(--vscode-editorHoverWidget-foreground, var(--vscode-foreground));
		background: var(--vscode-editorHoverWidget-background, #252526);
		border: 1px solid var(--vscode-editorHoverWidget-border, #454545);
		border-radius: 3px;
		box-shadow: 0 2px 10px rgba(0, 0, 0, 0.45);
	}
	.flame-tip[hidden] { display: none; }
	.flame-tip .tip-title { font-weight: 600; margin-bottom: 2px; }
	.flame-tip .tip-key { opacity: 0.65; }
	.flame-tip .tip-value { font-family: var(--vscode-editor-font-family); }
</style>
</head>
<body>
<h1>${escapeHtml(latest.title)} <span>${escapeHtml(latest.subtitle)}</span></h1>
${flame}<table>
<thead><tr>${head}</tr></thead>
<tbody id="rows">
${body}
</tbody>
</table>
${script}</body>
</html>`;
	}

	private flameHtml(flame: StatsFlame): string {
		return `<h2>${escapeHtml(flame.caption)}</h2>
<div class="flame-bar">
<input id="flame-search" class="flame-search" type="search" placeholder="Filter rules" spellcheck="false" />
<button id="flame-clear" class="flame-clear" type="button" hidden>Clear</button>
<span id="flame-count" class="flame-count"></span>
</div>
<div id="flame-crumb" class="flame-crumb"></div>
<div id="flame" class="flame"></div>
<div id="flame-tip" class="flame-tip" hidden></div>
`;
	}

	// emitted after the table so the script can see the rule rows it filters
	private flameScriptTag(flame: StatsFlame, nonce: string): string {
		return `<script nonce="${nonce}">
window.__FLAME_DATA__ = ${flameData(flame)};
${flameScript()}
</script>
`;
	}
}

/** A fresh nonce per render, so the inline flame script is the only script the webview will run. */
function createNonce(): string {
	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let text = '';
	for (let index = 0; index < 32; index++) {
		text += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
	}
	return text;
}

function escapeHtml(text: string): string {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
