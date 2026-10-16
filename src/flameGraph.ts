import type { CallNode, GrammarStats, ParseMetrics } from './engine';
import type { Anchor, Analysis } from './highlight';
import type { FlameNode, StatsFlame } from './flame';
import { formatBytes, formatDuration, symbolBound } from './format';

/**
 * Static expansion flame for the grammar window. A rule is placed under every rule that references
 * it, and a frame's width is the number of tokens in its fully-expanded body. Cycles are cut (the
 * repeated rule is drawn as a leaf), so the graph stays finite. Built from the analysis and stats
 * already in hand - no extra engine run.
 */
export function grammarFlame(analysis: Analysis, stats: GrammarStats): StatsFlame {
	const definitions = [...analysis.definitions].sort((a, b) => a.line - b.line || a.column - b.column);
	const rules = new Map(stats.rules.map((rule) => [rule.name, rule]));
	const index = new Map<string, number>();
	definitions.forEach((definition, position) => {
		if (!index.has(definition.name)) {
			index.set(definition.name, position);
		}
	});
	// each definition owns the text from its `@name:` up to the next definition
	const key = (line: number, column: number) => line * 1_000_000 + column;
	const start = definitions.map((definition) => key(definition.line, definition.column));
	const end = definitions.map((_, position) => position + 1 < definitions.length ? start[position + 1] : Number.MAX_SAFE_INTEGER);
	const region = (line: number, column: number): number => {
		const at = key(line, column);
		for (let position = definitions.length - 1; position >= 0; position--) {
			if (at >= start[position] && at < end[position]) {
				return position;
			}
		}
		return -1;
	};

	// self weight: tokens inside the rule's own body (comment lines aside)
	const self = new Array<number>(definitions.length).fill(0);
	for (const token of analysis.tokens) {
		if (token.rule === 'commentline') {
			continue;
		}
		const position = region(token.line, token.character);
		if (position >= 0) {
			self[position]++;
		}
	}
	const references: Anchor[][] = definitions.map(() => []);
	for (const reference of analysis.references) {
		const position = region(reference.line, reference.column);
		if (position >= 0) {
			references[position].push(reference);
		}
	}

	// a grammar cannot be expanded forever; stop well before the panel would choke
	let budget = 20000;
	const build = (target: number, path: Set<number>): FlameNode => {
		budget--;
		const definition = definitions[target];
		const rule = rules.get(definition.name);
		const children: FlameNode[] = [];
		if (budget > 0) {
			for (const reference of references[target]) {
				const child = index.get(reference.name);
				if (child === undefined) {
					children.push({ name: `@${reference.name}`, value: 1, self: 1, tone: 'bad', detail: ['undefined reference'], children: [] });
					continue;
				}
				if (path.has(child)) {
					children.push({ name: definitions[child].name, value: Math.max(1, self[child]), self: self[child], recursive: true, detail: ['recursive reference, cut here'], children: [] });
					continue;
				}
				const next = new Set(path);
				next.add(child);
				children.push(build(child, next));
			}
		}
		children.sort((a, b) => b.value - a.value);
		const detail: string[] = [];
		if (rule !== undefined) {
			detail.push(`${rule.type} \u00b7 bound ${symbolBound(rule.low, rule.high)}`);
		}
		return {
			name: definition.name,
			value: self[target] + children.reduce((sum, child) => sum + child.value, 0),
			self: self[target],
			detail,
			tone: rule?.unproductive === true ? 'bad' : undefined,
			children,
		};
	};

	const roots = definitions.map((_, position) => build(position, new Set([position])));
	roots.sort((a, b) => b.value - a.value);
	return {
		node: { name: 'grammar', value: roots.reduce((sum, root) => sum + root.value, 0), self: 0, children: roots },
		caption: 'Expansion flame \u2014 width is the tokens in each rule\u2019s fully-expanded body (recursion cut).',
		measure: 'tokens',
	};
}

/**
 * Runtime flame for the profile window, from the engine's merged call tree. A frame's width is its
 * inclusive time; the tree is already context-correct (same path merges), so no cycle cutting is
 * needed. Returns `undefined` when the engine predates the call tree, so the window falls back to
 * the table.
 */
export function profileFlame(metrics: ParseMetrics): StatsFlame | undefined {
	const nodes = metrics.tree;
	if (nodes.length <= 1) {
		return undefined;
	}
	const rules = metrics.rules;
	const childrenOf = new Map<number, CallNode[]>();
	for (const node of nodes) {
		if (node.parent < 0) {
			continue;
		}
		const list = childrenOf.get(node.parent);
		if (list === undefined) {
			childrenOf.set(node.parent, [node]);
		} else {
			list.push(node);
		}
	}

	const build = (node: CallNode): FlameNode => {
		const rule = node.rule >= 0 ? rules[node.rule] : undefined;
		const children = (childrenOf.get(node.id) ?? []).map(build);
		children.sort((a, b) => b.value - a.value);
		const detail = rule === undefined ? [] : [
			rule.value === null ? rule.type : `${rule.type} ${rule.value}`,
			`exec ${node.executions} \u00b7 match ${node.matches} \u00b7 fail ${node.failures}`,
			`alloc ${formatBytes(node.allocatedBytes)} (rule self ${formatBytes(rule.selfAllocatedBytes)})`,
			`time ${formatDuration(node.totalMs)} (rule self ${formatDuration(rule.selfMs)})`,
		];
		return {
			name: rule?.name ?? 'parse',
			value: node.totalMs,
			self: Math.max(0, node.totalMs - children.reduce((sum, child) => sum + child.value, 0)),
			detail,
			children,
		};
	};

	const roots = (childrenOf.get(nodes[0].id) ?? []).map(build);
	if (metrics.unattributedElapsedMs > 0) {
		roots.push({ name: 'Other (non-rule)', value: metrics.unattributedElapsedMs, self: metrics.unattributedElapsedMs, tone: 'muted', detail: ['outside any rule'], children: [] });
	}
	roots.sort((a, b) => b.value - a.value);
	return {
		node: { name: 'parse', value: metrics.totalElapsedMs, self: Math.max(0, metrics.totalElapsedMs - roots.reduce((sum, root) => sum + root.value, 0)), children: roots },
		caption: `Runtime flame \u2014 width is inclusive time (total ${formatDuration(metrics.totalElapsedMs)}).`,
		measure: 'time',
	};
}
