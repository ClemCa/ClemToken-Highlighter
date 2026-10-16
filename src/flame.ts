/**
 * A flame graph frame. `value` is the frame's inclusive width (time, symbols, ...); `children`
 * are laid out inside it on the next row. The shape is plain data so each panel can build its own
 * tree (the grammar's static expansion, the profile's runtime call graph).
 */
export interface FlameNode {
	name: string;
	/** inclusive width of this frame */
	value: number;
	/** this frame minus the children drawn under it, for the tooltip */
	self: number;
	/** hover lines */
	detail?: string[];
	/** a reference whose subtree was cut, so the graph stays finite */
	recursive?: boolean;
	tone?: 'bad' | 'muted';
	children: FlameNode[];
}

/** A flame graph plus the caption and measure its panel renders. */
export interface StatsFlame {
	node: FlameNode;
	caption: string;
	measure: string;
}

/** One row, in pixels. `flame.ts` owns the layout; `statsView.ts` owns the matching CSS. */
export const ROW_HEIGHT = 18;

/** Frames narrower than this fraction are dropped: they would be sub-pixel and unreadable. */
const MIN_WIDTH = 0.0012;
/** Text is only drawn when the frame is at least this fraction wide. */
const LABEL_WIDTH = 0.035;

/**
 * The tree as JSON for the webview to lay out itself. `<` is escaped so a rule name can never close
 * the embedding `script` tag; everything else is valid JSON and (in a JS object literal) valid JS.
 */
export function flameData(flame: StatsFlame): string {
	return JSON.stringify({ root: flame.node, measure: flame.measure }).replace(/</g, '\\u003c');
}

/**
 * The webview half of the flame graph. It lays the tree out into positioned `div`s and wires the
 * interactions that make a dense graph readable:
 *
 * - hover a frame to spotlight its stack and read a tooltip that follows the pointer;
 * - click a frame to zoom into that subtree (the only way to see frames too thin to draw), and to
 *   filter the rule table below to that rule;
 * - filter by rule name, which flags every matching frame and hides non-matching rows;
 * - click or hover a table row to filter to that rule and zoom the graph to where it runs.
 *
 * It runs as a plain script because the layout has to be redone live on zoom, and because a native
 * `title` tooltip cannot be positioned or shown for sub-pixel frames. It is dependency-free so it
 * fits under the webview CSP, and it owns no strings from the grammar - `textContent` only.
 */
export function flameScript(): string {
	return `(function () {
	'use strict';
	var data = window.__FLAME_DATA__;
	var host = document.getElementById('flame');
	if (!data || !host) { return; }
	var tip = document.getElementById('flame-tip');
	var crumb = document.getElementById('flame-crumb');
	var search = document.getElementById('flame-search');
	var count = document.getElementById('flame-count');
	var clear = document.getElementById('flame-clear');
	var rowsHost = document.getElementById('rows');
	var ROW_HEIGHT = ${ROW_HEIGHT};
	var MIN_WIDTH = ${MIN_WIDTH};
	var LABEL_WIDTH = ${LABEL_WIDTH};
	var PALETTE = [
		'var(--vscode-charts-blue, #3b82f6)',
		'var(--vscode-charts-purple, #a855f7)',
		'var(--vscode-charts-green, #22c55e)',
		'var(--vscode-charts-orange, #f97316)',
		'var(--vscode-charts-red, #ef4444)',
		'var(--vscode-charts-yellow, #eab308)'
	];

	// parent links, so a frame can walk up to its stack without rebuilding the tree
	(function link(node) {
		var kids = node.children || [];
		for (var i = 0; i < kids.length; i++) {
			kids[i].__parent = node;
			link(kids[i]);
		}
	})(data.root);

	// the rule table, indexed once so filtering stays cheap
	var rowEls = [];
	var rowNames = [];
	var rowTexts = [];
	if (rowsHost) {
		for (var r = 0; r < rowsHost.children.length; r++) {
			var tr = rowsHost.children[r];
			var text = '';
			for (var c = 0; c < tr.children.length; c++) {
				text += (c > 0 ? ' ' : '') + tr.children[c].textContent;
			}
			rowEls.push(tr);
			rowTexts.push(text);
			rowNames.push(tr.children.length > 0 ? tr.children[0].textContent : '');
		}
	}

	var zoom = data.root;
	var frames = [];
	var hovered = null;
	var rowHover = null;
	var query = '';

	function formatValue(value) {
		if (value >= 1000) { return String(Math.round(value)); }
		if (value >= 1) { return String(Number(value.toFixed(2))); }
		return String(Number(value.toPrecision(3)));
	}

	function color(name) {
		var hash = 0;
		for (var i = 0; i < name.length; i++) {
			hash = (hash * 31 + name.charCodeAt(i)) | 0;
		}
		return PALETTE[Math.abs(hash) % PALETTE.length];
	}

	function ancestorsOf(node) {
		var out = new Set();
		for (var parent = node.__parent; parent !== undefined; parent = parent.__parent) {
			out.add(parent);
		}
		return out;
	}

	function isUnder(node, ancestor) {
		for (var parent = node.__parent; parent !== undefined; parent = parent.__parent) {
			if (parent === ancestor) { return true; }
		}
		return false;
	}

	function hasRow(name) {
		for (var i = 0; i < rowNames.length; i++) {
			if (rowNames[i] === name) { return true; }
		}
		return false;
	}

	// the biggest frame carrying a rule name, so a table click lands where it actually costs
	function findNode(name) {
		var best = null;
		(function walk(node) {
			if (node.name === name && (best === null || node.value > best.value)) { best = node; }
			var kids = node.children || [];
			for (var i = 0; i < kids.length; i++) { walk(kids[i]); }
		})(data.root);
		return best;
	}

	// width is the node's share of the zoom root; children keep their true share so self time shows
	// as a gap. When timer noise makes children sum past their parent they are scaled back in.
	function layout(node, depth, x, width, into) {
		if (width < MIN_WIDTH) { return; }
		into.push({ node: node, depth: depth, x: x, width: width, base: 'frame' + (node.tone ? ' ' + node.tone : ''), el: null });
		var kids = (node.children || []).filter(function (child) { return child.value > 0; }).sort(function (a, b) { return b.value - a.value; });
		var total = 0;
		for (var i = 0; i < kids.length; i++) { total += kids[i].value; }
		var unit = node.value > 0 ? width / node.value : 0;
		var scale = total * unit > width ? width / (total * unit) : 1;
		var cursor = x;
		for (var j = 0; j < kids.length; j++) {
			var childWidth = kids[j].value * unit * scale;
			layout(kids[j], depth + 1, cursor, childWidth, into);
			cursor += childWidth;
		}
	}

	function build() {
		frames = [];
		layout(zoom, 0, 0, 1, frames);
		var rows = 1;
		for (var i = 0; i < frames.length; i++) { rows = Math.max(rows, frames[i].depth + 1); }
		host.style.height = (rows * ROW_HEIGHT) + 'px';
		host.textContent = '';
		for (var j = 0; j < frames.length; j++) {
			var frame = frames[j];
			var el = document.createElement('div');
			el.className = frame.base;
			el.style.left = (frame.x * 100) + '%';
			el.style.width = (frame.width * 100) + '%';
			el.style.top = (frame.depth * ROW_HEIGHT) + 'px';
			el.style.background = frame.node.tone === 'bad' ? 'var(--vscode-errorForeground, #ef4444)' : color(frame.node.name);
			el.style.borderColor = 'var(--vscode-panel-border)';
			el.__frame = frame;
			if (frame.width >= LABEL_WIDTH) {
				var label = document.createElement('span');
				label.textContent = frame.node.name + (frame.node.recursive === true ? ' \u21bb' : '');
				el.appendChild(label);
			}
			frame.el = el;
			host.appendChild(el);
		}
		renderCrumb();
		refresh();
	}

	function renderCrumb() {
		crumb.textContent = '';
		var path = [];
		for (var node = zoom; node !== undefined; node = node.__parent) { path.unshift(node); }
		if (path.length > 1) {
			var reset = document.createElement('a');
			reset.className = 'item reset';
			reset.href = '#';
			reset.textContent = 'reset';
			reset.addEventListener('click', function (event) { event.preventDefault(); resetView(); });
			crumb.appendChild(reset);
			appendSep();
		}
		for (var i = 0; i < path.length; i++) {
			if (i > 0) { appendSep(); }
			var item = path[i];
			var last = i === path.length - 1;
			var chip = document.createElement(last ? 'span' : 'a');
			chip.className = last ? 'item current' : 'item';
			chip.textContent = item.name;
			if (!last) {
				chip.href = '#';
				chip.addEventListener('click', zoomHandler(item));
			}
			crumb.appendChild(chip);
		}
	}

	function appendSep() {
		var sep = document.createElement('span');
		sep.className = 'sep';
		sep.textContent = '\u203a';
		crumb.appendChild(sep);
	}

	function zoomHandler(node) {
		return function (event) { event.preventDefault(); zoomTo(node); };
	}

	function zoomTo(node) {
		if (node === zoom) { return; }
		zoom = node;
		hovered = null;
		hideTip();
		build();
	}

	/** Back to the whole graph with no filter - the two are one view, so they reset together. */
	function resetView() {
		query = '';
		if (search) { search.value = ''; }
		zoomTo(data.root);
		refresh();
	}

	/** The filter drives both the frame highlight and the rule table, so they never disagree. */
	function setQuery(name) {
		query = name;
		if (search) { search.value = name; }
		refresh();
	}

	/** After a frame is picked, filter to its rule - unless the table has no such row (the roots). */
	function selectFrame(name) {
		setQuery(hasRow(name) ? name : '');
	}

	function refresh() {
		var needle = query.toLowerCase();
		var matches = 0;
		var ancestors = hovered === null ? null : ancestorsOf(hovered.node);
		for (var i = 0; i < frames.length; i++) {
			var frame = frames[i];
			var role = '';
			if (hovered !== null) {
				if (frame === hovered) { role = 'hover'; }
				else if (ancestors.has(frame.node)) { role = 'ancestor'; }
				else if (isUnder(frame.node, hovered.node)) { role = 'descendant'; }
				else if (frame.node.name === hovered.node.name) { role = 'match'; }
				else { role = 'dim'; }
			}
			var isMatch = (needle.length > 0 && frame.node.name.toLowerCase().indexOf(needle) !== -1) || (rowHover !== null && frame.node.name === rowHover);
			if (isMatch) {
				matches++;
				if (role === '' || role === 'dim') { role = 'match'; }
			}
			frame.el.className = role === '' ? frame.base : frame.base + ' ' + role;
		}
		// an exact rule name (from a frame/row click) filters to that one row; free typing matches
		// any cell, so "group" still narrows by type
		var exact = false;
		for (var e = 0; e < rowNames.length; e++) {
			if (rowNames[e] === query) { exact = true; break; }
		}
		var shown = 0;
		for (var r = 0; r < rowEls.length; r++) {
			var keep = needle.length === 0 || (exact ? rowNames[r] === query : rowTexts[r].toLowerCase().indexOf(needle) !== -1);
			rowEls[r].hidden = !keep;
			if (keep) { shown++; }
		}
		var parts = [];
		if (needle.length > 0) {
			parts.push(shown + ' of ' + rowEls.length + ' rows');
			if (matches > 0) { parts.push(matches + (matches === 1 ? ' frame' : ' frames')); }
		}
		count.textContent = parts.join(' \u00b7 ');
		if (clear) { clear.hidden = needle.length === 0; }
	}

	function tipLine(key, value) {
		var row = document.createElement('div');
		if (key.length > 0) {
			var k = document.createElement('span');
			k.className = 'tip-key';
			k.textContent = key + ' ';
			row.appendChild(k);
		}
		var v = document.createElement('span');
		v.className = 'tip-value';
		v.textContent = value;
		row.appendChild(v);
		tip.appendChild(row);
	}

	function showTip(frame, x, y) {
		var node = frame.node;
		tip.textContent = '';
		var title = document.createElement('div');
		title.className = 'tip-title';
		title.textContent = node.name + (node.recursive === true ? ' \u21bb' : '');
		tip.appendChild(title);
		var share = zoom.value > 0 ? node.value / zoom.value : 0;
		tipLine('view', (share * 100).toFixed(2) + '%');
		tipLine(data.measure, formatValue(node.value));
		tipLine('self', formatValue(node.self));
		if (node.detail) {
			for (var i = 0; i < node.detail.length; i++) { tipLine('', node.detail[i]); }
		}
		tip.hidden = false;
		placeTip(x, y);
	}

	function placeTip(x, y) {
		var width = tip.offsetWidth;
		var height = tip.offsetHeight;
		var left = x + 16;
		var top = y + 16;
		if (left + width > window.innerWidth - 8) { left = x - width - 16; }
		if (top + height > window.innerHeight - 8) { top = y - height - 16; }
		tip.style.left = Math.max(8, left) + 'px';
		tip.style.top = Math.max(8, top) + 'px';
	}

	function hideTip() {
		tip.hidden = true;
	}

	host.addEventListener('mousemove', function (event) {
		var el = event.target && event.target.closest ? event.target.closest('.frame') : null;
		var frame = el && el.__frame ? el.__frame : null;
		if (frame === hovered) {
			if (frame !== null) { placeTip(event.clientX, event.clientY); }
			return;
		}
		hovered = frame;
		refresh();
		if (frame === null) { hideTip(); return; }
		showTip(frame, event.clientX, event.clientY);
	});

	host.addEventListener('mouseleave', function () {
		if (hovered === null) { return; }
		hovered = null;
		refresh();
		hideTip();
	});

	// clicking a frame zooms into it and filters the table to its rule
	host.addEventListener('click', function (event) {
		var el = event.target && event.target.closest ? event.target.closest('.frame') : null;
		if (!el || !el.__frame) { return; }
		zoomTo(el.__frame.node);
		selectFrame(el.__frame.node.name);
	});

	if (rowsHost) {
		// clicking a row filters to that rule and jumps the graph to where it runs
		rowsHost.addEventListener('click', function (event) {
			var tr = event.target && event.target.closest ? event.target.closest('tr') : null;
			if (!tr || tr.children.length === 0) { return; }
			var name = tr.children[0].textContent;
			if (name.length === 0) { return; }
			var node = findNode(name);
			if (node !== null) { zoomTo(node); }
			setQuery(name);
		});
		rowsHost.addEventListener('mouseover', function (event) {
			var tr = event.target && event.target.closest ? event.target.closest('tr') : null;
			var name = tr && tr.children.length > 0 ? tr.children[0].textContent : null;
			if (name === rowHover) { return; }
			rowHover = name;
			refresh();
		});
		rowsHost.addEventListener('mouseleave', function () {
			if (rowHover === null) { return; }
			rowHover = null;
			refresh();
		});
	}

	if (search) {
		search.addEventListener('input', function () {
			query = search.value.trim();
			refresh();
		});
	}

	if (clear) {
		clear.addEventListener('click', function () { setQuery(''); });
	}

	document.addEventListener('keydown', function (event) {
		if (event.key !== 'Escape') { return; }
		if (query.length > 0) { setQuery(''); }
		else { resetView(); }
	});

	build();
})();`;
}
