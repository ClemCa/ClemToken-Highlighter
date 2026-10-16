import * as vscode from 'vscode';

export interface StatsRow {
	cells: string[];
	tone?: 'bad' | 'muted';
}

/**
 * One reusable panel for the `-stats` tables. Static markup, no scripts, themed with VS Code's CSS
 * variables.
 */
export class StatsView implements vscode.Disposable {
	private panel: vscode.WebviewPanel | undefined;
	private kind: 'grammar' | 'profile' | undefined;
	private latest: { title: string; subtitle: string; headers: string[]; rows: StatsRow[] } | undefined;

	/** Which table the panel is currently showing, or `undefined` when it is closed. */
	get showing(): 'grammar' | 'profile' | undefined {
		return this.panel === undefined ? undefined : this.kind;
	}

	showGrammar(subtitle: string, headers: string[], rows: StatsRow[]): void {
		this.render('grammar', 'Grammar Stats', subtitle, headers, rows);
	}

	showProfile(subtitle: string, headers: string[], rows: StatsRow[]): void {
		this.render('profile', 'Parse Profile', subtitle, headers, rows);
	}

	dispose(): void {
		this.panel?.dispose();
	}

	private render(kind: 'grammar' | 'profile', title: string, subtitle: string, headers: string[], rows: StatsRow[]): void {
		this.kind = kind;
		this.latest = { title, subtitle, headers, rows };
		if (this.panel === undefined) {
			this.panel = vscode.window.createWebviewPanel('clemtoken.stats', title, vscode.ViewColumn.Active, {
				enableScripts: false,
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
		const head = latest.headers.map((header) => `<th>${escapeHtml(header)}</th>`).join('');
		const body = latest.rows.map((row) => {
			const cells = row.cells.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('');
			return row.tone === undefined ? `<tr>${cells}</tr>` : `<tr class="${row.tone}">${cells}</tr>`;
		}).join('\n');
		return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<style>
	body {
		font-family: var(--vscode-font-family);
		color: var(--vscode-foreground);
		padding: 12px 16px;
	}
	h1 { font-size: 1.15em; font-weight: 600; margin: 0 0 10px; }
	h1 span { font-weight: 400; opacity: 0.7; }
	table {
		border-collapse: collapse;
		font-family: var(--vscode-editor-font-family);
		font-size: var(--vscode-editor-font-size);
	}
	th, td { text-align: left; padding: 2px 18px 2px 0; white-space: pre; }
	th { border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 5px; }
	tr.bad td { color: var(--vscode-errorForeground); }
	tr.muted td { opacity: 0.7; }
</style>
</head>
<body>
<h1>${escapeHtml(latest.title)} <span>${escapeHtml(latest.subtitle)}</span></h1>
<table>
<thead><tr>${head}</tr></thead>
<tbody>
${body}
</tbody>
</table>
</body>
</html>`;
	}
}

function escapeHtml(text: string): string {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
