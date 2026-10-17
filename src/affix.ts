/** A repetition suffix. `low`/`high` are the number of repetitions, not symbols. */
export interface Affix {
	text: string;
	low: number;
	high: number | null;
	ignored: boolean;
}

/** Parses a suffix such as `?`, `*`, `+`, `3`, `1-3`, `:` or `:_`. */
export function affixOf(raw: string): Affix {
	let suffix = raw;
	let ignored = false;
	if (suffix.startsWith(':')) {
		ignored = true;
		suffix = suffix.slice(1);
	}
	if (suffix === '' || suffix === '_' || suffix === ':') {
		return { text: raw, low: 1, high: 1, ignored: true };
	}
	if (suffix === '?') {
		return { text: raw, low: 0, high: 1, ignored };
	}
	if (suffix === '+') {
		return { text: raw, low: 1, high: null, ignored };
	}
	if (suffix === '*') {
		return { text: raw, low: 0, high: null, ignored };
	}
	const range = /^(\d+)(?:-(\d+))?$/.exec(suffix);
	if (range !== null) {
		const low = Number(range[1]);
		return { text: raw, low, high: range[2] === undefined ? low : Number(range[2]), ignored };
	}
	return { text: raw, low: 1, high: 1, ignored };
}

/** The suffix in words: `zero or more`, `exactly 3`, `1 to 4`. */
export function affixRepetition(affix: Affix): string {
	if (affix.low === 1 && affix.high === 1) {
		const suffix = affix.text.replace(/^:/, '');
		if (/^\d+$/.test(suffix)) {
			return `exactly ${affix.low}`;
		}
		if (/^\d+-\d+$/.test(suffix)) {
			return `${affix.low} to ${affix.high}`;
		}
		return 'one match';
	}
	if (affix.low === 0 && affix.high === 1) {
		return 'zero or one';
	}
	if (affix.low === 1 && affix.high === null) {
		return 'one or more';
	}
	if (affix.low === 0 && affix.high === null) {
		return 'zero or more';
	}
	if (affix.high === null) {
		return `${affix.low} or more`;
	}
	if (affix.high === affix.low) {
		return `exactly ${affix.low}`;
	}
	return `${affix.low} to ${affix.high}`;
}
