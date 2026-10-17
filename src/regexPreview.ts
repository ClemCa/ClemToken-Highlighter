import RandExp = require('randexp');

const MAX_LENGTH = 80;
const MAX_ATTEMPTS = 20;
const MAX_REPEAT = 12;

/**
 * A few random strings that fit the regex patterns, for a hover preview. Unsupported syntax simply
 * produces no examples; the caller decides how to say that.
 */
export function regexExamples(patterns: string[], count = 5): string[] {
	const usable = patterns.filter((pattern) => pattern !== '');
	const examples: string[] = [];
	const seen = new Set<string>();
	for (let round = 0; round < count && usable.length > 0; round++) {
		for (const pattern of usable) {
			if (examples.length >= count) {
				break;
			}
			const example = generate(pattern, seen);
			if (example !== undefined) {
				seen.add(example);
				examples.push(example);
			}
		}
	}
	return examples;
}

function generate(pattern: string, seen: Set<string>): string | undefined {
	// `max` only bounds `*`/`+`; avoid allocating a huge string for a large bounded repeat
	if (/\{\d{3,}(?:,\d*)?\}/.test(pattern)) {
		return undefined;
	}
	let regex: RegExp;
	let randexp: RandExp;
	try {
		regex = new RegExp(pattern);
		randexp = new RandExp(pattern);
		randexp.max = MAX_REPEAT;
	} catch {
		return undefined;
	}
	for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
		try {
			const value = randexp.gen();
			if (value !== '' && value.length <= MAX_LENGTH && !seen.has(value) && regex.test(value)) {
				return value;
			}
		} catch {
			return undefined;
		}
	}
	return undefined;
}
