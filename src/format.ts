import type { RuleGrammarStats } from './engine';

/** Shared formatting for the engine's stats numbers, used by hover, the status bar and the tables. */

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
