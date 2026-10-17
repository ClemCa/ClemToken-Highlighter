import type { RuleGrammarStats } from './engine';

/** Shared formatting for the engine's stats, hover markdown and completion details. */

/** `1..inf` / `3` / `0..2`, with `null` read as infinity. */
export function symbolBound(low: number | null, high: number | null): string {
	const l = low === null ? '∞' : String(low);
	const h = high === null ? '∞' : String(high);
	return l === h ? l : `${l}..${h}`;
}

export function ruleFlags(rule: RuleGrammarStats): string[] {
	const flags: string[] = [];
	if (rule.recursive) {
		flags.push('recursive');
	}
	if (rule.unproductive) {
		flags.push('unproductive');
	}
	return flags;
}

/** `true` when the rule matches exactly one symbol. */
export function isSingle(rule: Pick<RuleGrammarStats, 'low' | 'high'>): boolean {
	return rule.low === 1 && rule.high === 1;
}

/** `Anchor · 1..∞ symbols · recursive` facts shared by hover and completion. */
export function ruleFacts(rule: RuleGrammarStats): string[] {
	return [rule.type, `${symbolBound(rule.low, rule.high)} symbol${isSingle(rule) ? '' : 's'}`, ...ruleFlags(rule)];
}

/** Inline code span for markdown hovers and completion documentation. */
export function inlineCode(text: string): string {
	return `\`${text.replace(/`/g, '\\`')}\``;
}

/** Inline-code backticks removed for plain-text surfaces such as completion details and inlay labels. */
export function plainText(text: string): string {
	return text.replace(/`/g, '');
}

/** A short description as a sentence: capitalised, with a final full stop. */
export function sentence(text: string): string {
	const trimmed = text.trim();
	if (trimmed === '') {
		return '';
	}
	const capitalised = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
	return /[.!?]$/.test(capitalised) ? capitalised : `${capitalised}.`;
}

/** Escapes text for HTML content. */
export function escapeHtml(text: string): string {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Escapes text for an HTML attribute or an inline colour value. */
export function escapeAttribute(text: string): string {
	return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Bytes the way the engine's table writes them (`1.5 KB`). */
export function formatBytes(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes} B`;
	}
	const units = ['KB', 'MB', 'GB', 'TB'];
	let value = bytes;
	let unit = -1;
	do {
		value /= 1024;
		unit++;
	} while (value >= 1024 && unit < units.length - 1);
	return `${Number(value.toFixed(2))} ${units[unit]}`;
}

/** Duration the way the engine's table writes it (`1.5 ms`, `300 us`, `2.1 s`). */
export function formatDuration(ms: number): string {
	if (ms >= 1000) {
		return `${Number((ms / 1000).toFixed(3))} s`;
	}
	if (ms >= 1) {
		return `${Number(ms.toFixed(3))} ms`;
	}
	return `${Number((ms * 1000).toFixed(2))} us`;
}
