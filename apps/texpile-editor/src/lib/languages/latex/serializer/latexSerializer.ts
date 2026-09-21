/**
 * Deterministic ProseMirror to LaTeX serializer: each node/mark maps to fixed LaTeX, no rules
 * engine, styling delegated to the verbatim-preserved preamble. leaves reuse the schema's own
 * NodeSpec.leafText; everything else is a handler keyed by node.type.name; marks are open/close
 * pairs.
 */

import { Fragment, type Node, type Mark } from 'prosemirror-model';
import { serializeTable, serializeRowCells, serializeCell } from './tableSerializer';
import { FIG_IMG_SLOT, FIG_CAP_SLOT, FIG_LAB_SLOT } from '../parser/converter';
import { createBlockAssembly, follows, isLastOfParse, type DocSerializeResult, type Neighbour } from '$lib/serializer/blockAssembly';
import type { Ctx, NodeHandler } from '$lib/serializer/types';
// direct, not through the image barrel: that one pulls in svelte and the DOM
import { DEFAULT_FIGURE_FRACTION } from '$lib/editor/visual/extensions/image/figureDefaults';
import { esc, applyMarks, joinInline, markableMarks, marksKey, setBareUrl } from './textEscapes';
import { blockMath, alignEnvironment } from './mathBlocks';
import {
	blockOriginOf,
	spansOfChars,
	type BlockOrigin,
	type CharSource,
	type ParseOrigins,
	type Segment
} from '$lib/editor/visual/sourceSpans';
export { esc, sanitizeText, type EscMode } from './textEscapes';

export type { DocSerializeResult } from '$lib/serializer/blockAssembly';

// ---- source map. A shadow run of a block stands a private-use character in for the characters
// of every leaf, keeping the ones the joins and trims look at, so each leaf can be found in the
// real output afterwards. The shadow is believed only where it equals the real output everywhere
// else; a block whose shadow differs maps no leaves at all
const PUA_FIRST = 0xe000;
const PUA_LAST = 0xf8ff;
type ShadowLeaf = { node: Node; emitted: string; placeholder: string; bare?: boolean };
let shadow: ShadowLeaf[] | null = null;
// what the joins, the trims and the comment checks read. A space is kept as a no-break space: still
// whitespace to every trim, but never a byte of markup, so an edge a handler trimmed can be told
// from the bytes beside it
const KEPT = /[\n\t\r%\\{}]/;
// nodes whose handler output is one run: their bytes come from attrs, not from text leaves
const HANDLER_LEAVES = new Set([
	'block_math',
	'code_block',
	'raw_latex',
	'citation',
	'ref',
	'label',
	'hard_break',
	'includedoc',
	'horizontal_rule'
]);

function isPua(ch: string): boolean {
	const c = ch.charCodeAt(0);
	return c >= PUA_FIRST && c <= PUA_LAST;
}

function isHandlerLeaf(node: Node): boolean {
	return HANDLER_LEAVES.has(node.type.name) || (node.type.name === 'image' && node.childCount === 0);
}

function placeholderFor(emitted: string, k: number): string {
	const id = String.fromCharCode(PUA_FIRST + k);
	// a trailing control word stays: the join after it looks for one
	const tail = /\\[a-zA-Z@]+$/.exec(emitted);
	const keep = tail ? tail.index : emitted.length;
	let out = '';
	for (let i = 0; i < keep; i++) {
		const c = emitted[i];
		// the join after a control word looks for a letter first, and a comment chip is known by its %
		if (i === 0 && /[a-zA-Z%\\]/.test(c)) out += c;
		else if (c === ' ') out += ' ';
		else out += KEPT.test(c) ? c : id;
	}
	return out + emitted.slice(keep);
}

/** in a shadow run, what stands for this leaf's emission; the emission itself otherwise */
function shadowed(node: Node, emitted: string): string {
	if (!shadow || shadow.length > PUA_LAST - PUA_FIRST) return emitted;
	const placeholder = placeholderFor(emitted, shadow.length);
	shadow.push({ node, emitted, placeholder });
	return placeholder;
}

const shadowBareUrl = (text: string, href: string): string | null => {
	const k = shadow ? shadow.findIndex((l) => l.placeholder === text) : -1;
	if (k < 0) return null;
	const leaf = shadow![k];
	if (leaf.emitted !== esc(href, 'text')) return null;
	// the call carries the raw href, so that is what the leaf's characters are from now on
	leaf.emitted = href;
	leaf.placeholder = placeholderFor(href, k);
	leaf.bare = true;
	return `\\url{${leaf.placeholder}}`;
};

/** the characters of a text leaf against its emission, one by one; the whole run when they cannot be told */
function textLeafSpans(leaf: ShadowLeaf): CharSource[] {
	const text = leaf.node.text ?? '';
	const chars: CharSource[] = [];
	if (leaf.bare) {
		if (leaf.emitted !== text) return new Array<CharSource>(text.length).fill({ srcFrom: 0, srcTo: leaf.emitted.length, kind: 'sub' });
		for (let i = 0; i < text.length; i++) chars.push({ srcFrom: i, srcTo: i + 1, kind: 'text' });
		return chars;
	}
	const isCode = leaf.node.marks.some((m) => m.type.name === 'code');
	let off = 0;
	for (let i = 0; i < text.length; i++) {
		const e = bareTextString(text[i], isCode);
		if (!leaf.emitted.startsWith(e, off))
			return new Array<CharSource>(text.length).fill({ srcFrom: 0, srcTo: leaf.emitted.length, kind: 'sub' });
		chars.push({ srcFrom: off, srcTo: off + e.length, kind: e === text[i] ? 'text' : 'sub' });
		off += e.length;
	}
	if (off !== leaf.emitted.length) return new Array<CharSource>(text.length).fill({ srcFrom: 0, srcTo: leaf.emitted.length, kind: 'sub' });
	return chars;
}

/** where the leaves of a regenerated block sit in its text, or null when the shadow could not be believed */
function mapBlockLeaves(block: Node, ctx: Ctx, real: string): Segment[] | null {
	return mapRunLeaves(block, real, () => serializeNode(block, ctx));
}

/** the inline children `from` up to `to` of a textblock as one run of inline content, and where
 *  its leaves sit in it: what the segment splice writes between the bytes it keeps */
function inlineRun(block: Node, nodes: Node[]): Node {
	return block.type.create(block.attrs, Fragment.fromArray(nodes), block.marks);
}

function inlineBytes(block: Node, nodes: Node[], atStart: boolean, ctx: Ctx): string | null {
	const run = inlineRun(block, nodes);
	// a comment chip owns its line: it cannot stand mid-line between kept bytes
	let comment = false;
	run.forEach((c) => {
		if (c.type.name === 'inline_latex' && c.textContent.startsWith('%')) comment = true;
	});
	if (comment) return null;
	const bytes = renderChildren(run, ctx.inTableCell);
	return atStart && headsItem(ctx) ? guardItemBody(bytes) : bytes;
}

function mapInlineLeaves(block: Node, nodes: Node[], text: string, _atStart: boolean, ctx: Ctx): Segment[] | null {
	const run = inlineRun(block, nodes);
	return mapRunLeaves(run, text, () => renderChildren(run, ctx.inTableCell));
}

/** where the leaves of `block` sit in `real`, the text `render` writes for it, told by a shadow run */
function mapRunLeaves(block: Node, real: string, render: () => string): Segment[] | null {
	const leaves: ShadowLeaf[] = [];
	shadow = leaves;
	setBareUrl(shadowBareUrl);
	let out: string;
	try {
		out = render();
	} finally {
		shadow = null;
		setBareUrl(null);
	}
	if (out.length !== real.length) return null;
	for (let i = 0; i < out.length; i++) {
		if (out[i] === real[i] || isPua(out[i]) || (out[i] === ' ' && real[i] === ' ')) continue;
		return null;
	}

	// the leaves' positions, relative to the block node; a block that is itself one run stands at 0.
	// A child written out as its bytes (a chunk) is one run too, its own leaves carried inside it
	const chunks = new Set<Node>();
	for (const leaf of leaves)
		if (!leaf.node.isText && !leaf.node.isLeaf && !isHandlerLeaf(leaf.node) && !leaf.node.type.spec.leafText) chunks.add(leaf.node);
	const at = new Map<Node, number>();
	let twice = false;
	if (isHandlerLeaf(block) || block.type.spec.leafText) at.set(block, 0);
	block.descendants((n, pos) => {
		const leaf = n.isText || n.isLeaf || isHandlerLeaf(n) || !!n.type.spec.leafText || chunks.has(n);
		if (!leaf) return true;
		if (at.has(n)) twice = true;
		at.set(n, pos + 1);
		return false;
	});
	if (twice) return null;

	// a leaf with a marker is found by it, allowing for whitespace a handler trimmed off its edges;
	// one without, by being the only thing in the gap between the found leaves either side of it
	type Found = { start: number; lead: number; tail: number };
	const located: (Found | null)[] = leaves.map((leaf, k) => {
		const id = String.fromCharCode(PUA_FIRST + k);
		const p = leaf.placeholder;
		const j = p.indexOf(id);
		if (j < 0) return null;
		const i0 = out.indexOf(id);
		if (i0 < 0) return null;
		const maxLead = Math.min(j, /^\s*/.exec(p)![0].length);
		const maxTail = /\s*$/.exec(p)![0].length;
		for (let lead = 0; lead <= maxLead; lead++) {
			const start = i0 - (j - lead);
			if (start < 0) continue;
			for (let tail = 0; tail <= maxTail && lead + tail < p.length; tail++) {
				if (out.startsWith(p.slice(lead, p.length - tail), start)) return { start, lead, tail };
			}
		}
		return null;
	});
	for (let k = 0; k < leaves.length; k++) {
		if (located[k] !== null || !leaves[k].emitted) continue;
		let from = 0;
		for (let p = k - 1; p >= 0; p--) {
			const f = located[p];
			if (f) {
				from = f.start + leaves[p].emitted.length - f.lead - f.tail;
				break;
			}
		}
		let to = real.length;
		for (let q = k + 1; q < leaves.length; q++) {
			const f = located[q];
			if (f) {
				to = f.start;
				break;
			}
		}
		if (from > to) continue;
		const gap = real.slice(from, to);
		const first = gap.indexOf(leaves[k].emitted);
		if (first < 0 || gap.indexOf(leaves[k].emitted, first + 1) >= 0) continue;
		located[k] = { start: from + first, lead: 0, tail: 0 };
	}

	const segs: Segment[] = [];
	for (let k = 0; k < leaves.length; k++) {
		const found = located[k];
		const leaf = leaves[k];
		const pm = at.get(leaf.node);
		if (!found || pm === undefined) continue;
		const { start, lead, tail } = found;
		const coreLen = leaf.emitted.length - lead - tail;
		if (leaf.node.isText) {
			// characters a handler trimmed off stand for nothing
			const chars = textLeafSpans(leaf).map((c) => {
				if (!c) return null;
				const srcFrom = Math.max(0, c.srcFrom - lead);
				const srcTo = Math.min(coreLen, c.srcTo - lead);
				return srcTo > srcFrom ? { srcFrom, srcTo, kind: c.kind } : null;
			});
			for (const s of spansOfChars(chars)) {
				segs.push({ pmFrom: pm + s.from, pmTo: pm + s.to, srcFrom: start + s.srcFrom, srcTo: start + s.srcTo, kind: s.kind });
			}
			continue;
		}
		// a chunk's runs are where the parse had them, moved to where its bytes landed
		if (chunks.has(leaf.node)) {
			const origin = blockOriginOf(leaf.node);
			if (!origin || origin.srcFrom === undefined || lead > 0 || tail > 0) continue;
			for (const s of origin.leaves) {
				segs.push({
					pmFrom: pm + (s.pmFrom - origin.pmFrom),
					pmTo: pm + (s.pmTo - origin.pmFrom),
					srcFrom: start + (s.srcFrom - origin.srcFrom),
					srcTo: start + (s.srcTo - origin.srcFrom),
					kind: s.kind
				});
			}
			continue;
		}
		// an atom whose text child appears once inside its emission maps that child character for character
		const core = leaf.emitted.slice(lead, lead + coreLen);
		const inner = leaf.node.childCount === 1 && leaf.node.firstChild!.isText ? (leaf.node.firstChild!.text ?? '') : '';
		const at1 = inner ? core.indexOf(inner) : -1;
		if (inner && at1 >= 0 && core.indexOf(inner, at1 + 1) < 0) {
			segs.push({ pmFrom: pm + 1, pmTo: pm + 1 + inner.length, srcFrom: start + at1, srcTo: start + at1 + inner.length, kind: 'text' });
		} else if (coreLen > 0) {
			segs.push({ pmFrom: pm, pmTo: pm + leaf.node.nodeSize, srcFrom: start, srcTo: start + coreLen, kind: 'sub' });
		}
	}
	return segs.sort((a, b) => a.pmFrom - b.pmFrom);
}

/** the real and shadow runs of one block side by side, for the oracles to say why a block maps no leaves */
export function shadowRunOf(block: Node, ctx: Ctx): { real: string; shadow: string } {
	const real = serializeNode(block, ctx);
	shadow = [];
	setBareUrl(shadowBareUrl);
	try {
		return { real, shadow: serializeNode(block, ctx) };
	} finally {
		shadow = null;
		setBareUrl(null);
	}
}

/** A text/leaf node's content WITHOUT its own marks, for runs wrapped once by the caller. */
function serializeBare(node: Node): string {
	if (node.isText) return bareText(node);
	const leafText = node.type.spec.leafText;
	return leafText ? shadowed(node, leafText(node)) : '';
}

function prevSibling(ctx: Ctx): Node | null {
	return ctx.parent && ctx.index > 0 ? ctx.parent.child(ctx.index - 1) : null;
}

function nextSibling(ctx: Ctx): Node | null {
	return ctx.parent && ctx.index < ctx.parent.childCount - 1 ? ctx.parent.child(ctx.index + 1) : null;
}

/** Serialize a node's children, threading sibling/last-child/table context. */
export function renderChildren(node: Node, inTableCell: boolean): string {
	const children: Node[] = [];
	node.forEach((child) => children.push(child));

	// adjacent inline children with the EXACT same marks serialize as ONE wrapped run. PM auto-
	// merges identical text nodes, but atom leaves never merge, so \texttt{A\ B} parses to three
	// same-marked nodes and would serialize as three separate \texttt{} calls: pointless churn
	// that multiplies per chip.
	let pieces: string[] = [];
	let i = 0;
	while (i < children.length) {
		const marks = markableMarks(children[i]);
		let j = i + 1;
		if (marks && marks.length > 0) {
			const key = marksKey(marks);
			while (j < children.length) {
				const nextMarks = markableMarks(children[j]);
				if (!nextMarks || marksKey(nextMarks) !== key) break;
				j++;
			}
		}
		if (j === i + 1) {
			pieces.push(serializeNode(children[i], { parent: node, index: i, isLastChild: i === children.length - 1, inTableCell }));
		} else {
			let inner = '';
			for (let k = i; k < j; k++) inner += serializeBare(children[k]);
			pieces.push(applyMarks(inner, marks as readonly Mark[]));
		}
		i = j;
	}
	// a container's untouched children are written out as their bytes, joined on the file's own gaps
	if (pieces.length === children.length && children.length > 0 && children[0].isBlock) pieces = assembly.verbatimParts(node, pieces);

	return joinInline(pieces);
}

/**
 * Two lists the source wrote as separate environments stay separate: the verbatim layer emits a
 * pristine neighbour with its own \begin and \end, so coalescing a regenerated one into it left
 * an unbalanced environment. Editor-made list nodes carry no source group and still coalesce.
 */
function sameSourceList(a: Node, b: Node): boolean {
	const oa = blockOriginOf(a);
	const ob = blockOriginOf(b);
	return !oa || !ob || (oa.parse === ob.parse && oa.index - oa.member === ob.index - ob.member);
}

/** the environment name a list node carries itself, if any */
function ownEnvName(node: Node): string | null {
	return typeof node.attrs.envName === 'string' && node.attrs.envName ? node.attrs.envName : null;
}

/** the environment name the first node of this run of list nodes carries, if any */
function runEnvName(node: Node, ctx: Ctx): string | null {
	if (!ctx.parent) return typeof node.attrs.envName === 'string' ? node.attrs.envName : null;
	const kind = node.attrs.kind;
	for (let i = ctx.index; i >= 0; i--) {
		const n = ctx.parent.child(i);
		if (n.type.name !== 'list' || n.attrs.kind !== kind || (i < ctx.index && !sameSourceList(n, ctx.parent.child(i + 1)))) break;
		if (typeof n.attrs.envName === 'string' && n.attrs.envName) return n.attrs.envName;
	}
	return null;
}

// the same label written as source and re-serialized from the editor differs by markup, ties,
// dash ligatures and quote curling; those are folded, and any other character typed in counts
function labelKey(s: string): string {
	return s
		.replace(/\\[a-zA-Z@]+\s*/g, '')
		.replace(/[{}]/g, '')
		.replace(/~|\u00A0/g, ' ')
		.replace(/---|—/g, '-')
		.replace(/--|–/g, '-')
		.replace(/``|''|[“”"]/g, '"')
		.replace(/[`‘’]/g, "'")
		.replace(/\s+/g, ' ')
		.trim();
}

/**
 * The label at the head of an item, and the paragraph with it removed.
 *
 * The run is identified by the item_label mark createList puts on it, not by matching text: a
 * label can span several inline nodes (`\item[A $x$ B]`), and prose that merely repeats the
 * label is not the label. `latex` is the run re-serialized, which is what an edited label has
 * to be written back as; the caller prefers the untouched source when the two still agree.
 */
/** an item body beginning with `[` reads as the item's label, and one beginning with `<` as a
 *  beamer overlay: an empty group in front keeps the bytes text */
function guardItemBody(body: string): string {
	return /^[[<]/.test(body) ? '{}' + body : body;
}

/** whether `ctx` is the first block of a list item, whose bytes follow \item directly */
function headsItem(ctx: Ctx | undefined): boolean {
	return !!ctx && ctx.parent?.type.name === 'list' && ctx.index === 0;
}

function splitLeadingLabel(item: Node): { latex: string; body: Node; glued: boolean } | null {
	if (item.type.name !== 'paragraph') return null;
	// through the LAST marked node, not the first unmarked one: an atom in the middle of a label
	// (`\item[A $x$ B]` puts inline math there) carries no marks of its own
	let last = -1;
	for (let i = 0; i < item.childCount; i++) {
		const child = item.child(i);
		if (child.marks.some((m) => m.type.name === 'item_label')) last = i;
		else if (child.isText) break;
	}
	if (last < 0) return null;
	let size = 0;
	for (let i = 0; i <= last; i++) size += item.child(i).nodeSize;
	// the label's own marks are the wrapper, not content: \item[\textbf{x}] would come back
	// doubly bold otherwise
	const bare = item.type.schema.node(
		'paragraph',
		null,
		item.content.cut(0, size).content.map((n) => n.mark(n.marks.filter((m) => m.type.name !== 'item_label' && m.type.name !== 'strong')))
	);
	let rest = item.content.cut(size);
	const next = rest.firstChild;
	// the body runs straight on from the bracket when no whitespace stands between them
	const glued = !!next && !(next.isText && /^\s/.test(next.text ?? ''));
	if (next?.isText && next.text && /^\s+$/.test(next.text)) rest = rest.cut(next.nodeSize);
	else if (next?.isText && next.text && /^\s/.test(next.text))
		rest = rest.replaceChild(0, next.type.schema.text(next.text.replace(/^\s+/, ''), next.marks));
	return { latex: renderChildren(bare, false).trim(), body: item.copy(rest), glued };
}

const HEADING_CMD: Record<number, string> = {
	1: '\\section',
	2: '\\subsection',
	3: '\\subsubsection',
	4: '\\paragraph',
	5: '\\subparagraph'
};

/** Drop width=/scale=/height= entries from an \includegraphics option list (keep trim, clip, angle…). */
function stripSizeKeys(opts: string): string {
	return opts
		.split(',')
		.map((s) => s.trim())
		.filter((s) => s && !/^(width|scale|height|totalheight)\s*=/.test(s))
		.join(', ');
}

/**
 * Rebuild the \includegraphics for an image node.
 * - resized in the editor (width/maxWidth set): emit width=<frac>\textwidth, keeping other
 *   captured options (trim/clip/angle) and replacing the original size keys.
 * - options === '': the source had no brackets, emit \includegraphics{src} verbatim.
 * - options a non-empty string: emit it verbatim.
 * - options == null (editor-created, never resized): the default width.
 */
function buildIncludegraphics(node: Node): string {
	const src = String(node.attrs.src ?? '');
	const options = node.attrs.options as string | null;
	const w = Number(node.attrs.width);
	const mw = Number(node.attrs.maxWidth);
	if (Number.isFinite(w) && Number.isFinite(mw) && mw > 0) {
		const frac = Math.round((w / mw) * 100) / 100; // resize already snaps; this guards stray values
		const rest = stripSizeKeys(typeof options === 'string' ? options : '');
		const opts = [`width=${frac}\\textwidth`, rest].filter(Boolean).join(', ');
		return `\\includegraphics[${opts}]{${src}}`;
	}
	if (options === '') return `\\includegraphics{${src}}`;
	if (typeof options === 'string') return `\\includegraphics[${options}]{${src}}`;
	return `\\includegraphics[width=${DEFAULT_FIGURE_FRACTION}\\textwidth]{${src}}`;
}

/**
 * A \par the source had stays while the same block follows, so typing never rewrites how a
 * paragraph ends. `was` is what the parse knew the paragraph as before the edit; `next` is the
 * block written after it, or 'end' for the body's end.
 */
export function dropParagraphEnd(
	text: string,
	last: Node | null,
	was: BlockOrigin | null = null,
	next: BlockOrigin | 'end' | null = null
): string {
	if (last?.type.name !== 'paragraph') return text;
	const hadPar = typeof was?.text === 'string' && /\\par\s*$/.test(was.text);
	const kept = hadPar && (next === 'end' ? isLastOfParse(was!) : follows(was, next));
	return kept ? text : text.replace(/[ \t]*\\par$/, '');
}

// the file's own gap between a pair still the source pair, even a single line end: prose can
// only merge across one into prose, so after anything but a paragraph (a heading, an
// environment, a comment line) the gap is safe as written, and after a paragraph while it still
// ends in the \par the file gave it
function paragraphGap(prev: Neighbour, next: Neighbour, contiguous: boolean, before: string): string | null {
	const origin = next.origin ?? next.was;
	const pre = origin?.pre;
	// a later member of a construct (an item of a list written as one) has no gap of its own
	if (!contiguous || typeof pre !== 'string' || origin!.member !== 0) return null;
	// a paragraph, or a heading, after a paragraph on a single line end takes a blank line unless
	// a \par parts them; an environment, a list or a display the paragraph ran into opens on the
	// file's own gap, as it did
	const prose = next.node.type.name === 'paragraph' || next.node.type.name === 'heading';
	if (prev.node.type.name === 'paragraph' && prose && !/\\par\s*$/.test(before.slice(-16))) return null;
	// a comment ending what was written owns the rest of its line: the next block needs a line of its own
	return /(^|[^\\])(\\\\)*%[^\n]*\n*$/.test(before) && !pre.startsWith('\n') ? '\n' + pre : pre;
}

function envBody(node: Node): string {
	return dropParagraphEnd(renderChildren(node, false).replace(/^\n+|\n+$/g, ''), node.lastChild) + '\n';
}

// doc assembly (verbatim substitution + per-block memo) is format-neutral and shared with the
// markdown serializer; serializeNode hoists, so binding it here is safe.
const assembly = createBlockAssembly((node, ctx) => serializeNode(node, ctx), {
	beforeBreak: (text, last, next) => dropParagraphEnd(text, last.node, last.was, next.origin ?? next.was),
	boundary: paragraphGap,
	mapLeaves: mapBlockLeaves,
	shadowChunk: (node, bytes) => shadowed(node, bytes),
	// an item's label is written with \item, by the list handler, from the run at the head of the
	// item's first block: that block cannot be rendered on its own inside the item's frame
	spliceChild: (parent, index, was) =>
		!(
			parent.type.name === 'list' &&
			(splitLeadingLabel(parent.child(index)) !== null ||
				(was !== null && splitLeadingLabel(was) !== null) ||
				(index === 0 && parent.attrs.itemLabel != null))
		),
	// inside a formula, a chip or a code block the text is the source; prose is escaped the way the text handler does
	leafBytes: (leaf, parent, atStart, _block, ctx) => {
		if (parent.type.spec.leafText || parent.type.spec.code) return leaf.text ?? '';
		// a label's bytes sit inside \item[..]: a `]` in them needs the whole bracket braced
		if (leaf.marks.some((m) => m.type.name === 'item_label') && (leaf.text ?? '').includes(']')) return null;
		const bytes = bareTextString(
			leaf.text ?? '',
			leaf.marks.some((m) => m.type.name === 'code')
		);
		return atStart && headsItem(ctx) ? guardItemBody(bytes) : bytes;
	},
	inlineBytes,
	mapInlineLeaves,
	// a control word ending the fresh bytes would fuse with a letter beginning the kept tail
	keepApart: (bytes, tail) => (/\\[a-zA-Z@]+$/.test(bytes) && /^[a-zA-Z]/.test(tail) ? bytes + ' ' : bytes),
	// a block written afresh inside an environment or an item continues its lines as the file
	// indented the block it replaced, else under what stood before it on its first line
	continuation: (_parent, text, head) => {
		const nl = text.indexOf('\n');
		return nl >= 0 ? /^[ \t]*/.exec(text.slice(nl + 1))![0] : head.replace(/\S/g, ' ');
	},
	// the paragraphs of a table cell are joined by \par, as the cell handler writes them: a blank
	// line inside a tabular is not one
	childGap: (parent) => (parent.type.name === 'table_cell' || parent.type.name === 'table_header' ? ' \\par ' : null)
});

function serializeDocChildrenDetailed(doc: Node, parse?: ParseOrigins | null): DocSerializeResult {
	return assembly.serializeDocChildrenDetailed(doc, parse);
}

function serializeDocChildren(doc: Node): string {
	return serializeDocChildrenDetailed(doc).text;
}

/** The text handler's escaping, WITHOUT wrapping in the node's own marks (shared with
 * serializeBare's run merge). */
function bareText(node: Node): string {
	return shadowed(
		node,
		bareTextString(
			node.text ?? '',
			node.marks.some((m) => m.type.name === 'code')
		)
	);
}

// character by character: every rule below maps one character to its bytes, which is what lets
// the source map tell a text leaf's characters apart
function bareTextString(text: string, isCode: boolean): string {
	let result = esc(text, 'text');
	// a pasted tab becomes one space: there's no clean tab mapping and a space is idempotent.
	// a bare " stays as-is: \texttt{"} re-parses to a code mark and compounds every save.
	result = result.replace(/\t/g, ' ');
	// Every tie became a no-break space on the way in, so a tilde still here is one someone typed
	// meaning the character - emitted bare it would compile to a tie and vanish from the PDF.
	// MUST run before the no-break space goes back to ~, or it would escape that one too. Code
	// keeps its literal bytes and never had the tie converted, so it is left alone.
	if (!isCode) result = result.replace(/~/g, '\\textasciitilde{}');
	// a no-break space (from a ~ tie) must go back to ~, not a raw U+00A0 byte (renders
	// differently without inputenc, and is unfaithful to the source either way).
	result = result.replace(/\u00A0/g, '~');
	// typographic chars become LaTeX ligatures so the .tex stays ASCII and round-trips; skipped
	// in code, where they are literal.
	if (!isCode) {
		result = result
			.replace(/\u2014/g, '---')
			.replace(/\u2013/g, '--')
			.replace(/\u201C/g, '``')
			.replace(/\u201D/g, "''")
			.replace(/\u2018/g, '`')
			.replace(/\u2019/g, "'")
			// \ldots reads back as U+2026, which had no way home and left a non-ASCII byte behind
			.replace(/\u2026/g, '\\ldots{}');
	}
	return result;
}

const NODES: Record<string, NodeHandler> = {
	doc: (node) => serializeDocChildren(node),

	paragraph(node, ctx) {
		// an empty paragraph emits nothing: blank lines are semantic no-ops (WYSIWYM). a user who
		// wants real space types \vspace/\bigskip, which round-trips as a raw chip.
		if (isEmptyParagraph(node)) return '';
		// a \label on its own line is an anchor, not prose: it has no paragraph to end, so \par
		// here would add a token the source never had, on every save, after every section label
		if (isLabelOnlyParagraph(node) && !ctx.inTableCell) {
			return (prevSibling(ctx)?.type.name === 'heading' ? '' : '\n') + renderChildren(node, false).trim() + '\n';
		}
		const rawContent = renderChildren(node, ctx.inTableCell);
		if (ctx.inTableCell) return rawContent; // no \par inside table cells
		// \item already opens the paragraph, so a break before it puts the body on its own line and
		// a \par after it adds a token the source never had. A second paragraph of the same item is
		// separated by the blank line the list handler puts in front of every continuation block
		if (ctx.parent?.type.name === 'list') return rawContent.replace(/^\s+|\s+$/g, '') + '\n';

		// trim edge whitespace: the parser re-absorbs a space before \par, so it would
		// accumulate one per save.
		const trimmed = rawContent.replace(/^\s+|\s+$/g, '');
		const content = /(^|[^\\])(\\\\)*%[^\n]*$/.test(trimmed) ? trimmed + '\n' : trimmed;
		// first-line indent override (Tab cycles it): 'auto' emits nothing
		const indent = node.attrs.indent === 'indent' ? '\\indent ' : node.attrs.indent === 'noindent' ? '\\noindent ' : '';
		const prev = prevSibling(ctx);
		const next = nextSibling(ctx);
		// a display the source kept inside this paragraph: no \par before it and no blank line
		// after it, or the continuation becomes a new, indented paragraph with space above
		const runsIntoDisplay = next?.type.name === 'block_math' && next.attrs.inParagraph === true;
		const continuesDisplay = prev?.type.name === 'block_math' && prev.attrs.continuesAfter === true;
		const before = prev?.type.name === 'heading' || continuesDisplay ? '' : '\n';
		const after = next?.type.name === 'heading' ? '\n' : '';
		if (runsIntoDisplay) return before + indent + content + '\n';
		// an environment, a list or a display ends the paragraph itself: no \par of its own before
		// one, as the file had none when the two stood on a single line end
		const endsItself =
			!!next && ['list', 'environment', 'block_math', 'table_wrapper', 'image', 'code_block', 'abstract'].includes(next.type.name);
		return before + indent + content + (endsItself ? '\n' : ' \\par\n') + after;
	},

	heading(node) {
		if (node.childCount === 0) return '';
		const text = renderChildren(node, false);
		// \chapter and \part have no level of their own in the editor; the source command is kept
		const cmd =
			typeof node.attrs.command === 'string' && node.attrs.command
				? `\\${node.attrs.command}`
				: (HEADING_CMD[Number(node.attrs.level ?? 1)] ?? '\\section');
		const star = node.attrs.numbered === false ? '*' : '';
		// a `]` inside the short title would close the optional argument early; bracing the whole
		// argument is how LaTeX carries one
		const shortTitle = typeof node.attrs.shortTitle === 'string' ? node.attrs.shortTitle : '';
		const short = shortTitle ? `[${shortTitle.includes(']') ? `{${shortTitle}}` : shortTitle}]` : '';
		return `${cmd}${star}${short}{${text}}\n`;
	},

	text(node) {
		return applyMarks(bareText(node), node.marks);
	},

	hard_break(node, ctx) {
		// legacy lineBreak:false (a blank-line gap) is a semantic no-op: emit nothing
		if (node.attrs?.lineBreak === false) return '';
		const suffix = typeof node.attrs?.suffix === 'string' ? node.attrs.suffix : '';
		if (node.attrs?.command === 'newline' || (ctx.inTableCell && !suffix)) return '\\newline\n';
		return `\\\\${suffix}\n`;
	},

	block_math(node) {
		const content = node.textContent;
		const numbered = Boolean(node.attrs.numbered ?? false);
		const label = (node.attrs.label as string) || '';
		const environment = (node.attrs.environment as string | null) ?? null;
		const lineLabels = (node.attrs.lineLabels as string[]) ?? [];
		if (environment) {
			return alignEnvironment(content, { environment, lineLabels, label: label || undefined, numbered });
		}
		return blockMath(content, { numbered, label: label || undefined, starredEnv: node.attrs.starredEnv === true });
	},

	// verbatim, no escaping. env/args remember the source environment and options so
	// \begin{lstlisting}[language=Python] round-trips as itself (losing the options silently
	// drops \lstset styling).
	code_block: (node) => {
		const env = String(node.attrs.env ?? 'verbatim');
		const args = String(node.attrs.args ?? '');
		return `\\begin{${env}}${args}\n${node.textContent}\n\\end{${env}}\n\n`;
	},

	blockquote: (node) => {
		const env = node.attrs.env === 'quotation' ? 'quotation' : 'quote';
		return `\\begin{${env}}\n${envBody(node)}\\end{${env}}\n`;
	},

	raw_latex: (node) => node.textContent + '\n',

	// emit the exact include command captured at parse time, path verbatim
	includedoc: (node) => `\\${String(node.attrs.command ?? 'input')}{${String(node.attrs.path ?? '')}}\n`,

	environment: (node) => {
		const name = String(node.attrs.name ?? 'environment');
		const args = String(node.attrs.args ?? ''); // verbatim \begin{name}<args> (e.g. "{0.5\textwidth}")
		return `\\begin{${name}}${args}\n${renderChildren(node, false)}\\end{${name}}\n`;
	},

	// sourceForm remembers which shape the file used. the command form only fits a single-
	// paragraph abstract (its arg is inline); multi-paragraph auto-promotes to the env form.
	abstract: (node) => {
		const sourceForm = String(node.attrs.sourceForm ?? 'env');
		if (sourceForm === 'macro' && node.childCount === 1 && node.firstChild?.type.name === 'paragraph') {
			return `\\abstract{${renderChildren(node.firstChild, false).trimEnd()}}\n`;
		}
		return `\\begin{abstract}\n${envBody(node)}\\end{abstract}\n`;
	},

	horizontal_rule: () => '\\par\\noindent\\rule{\\linewidth}{0.4pt}\n',

	// pre/post notes are NOT text-escaped: they come from getTextContent, which falls back to a
	// macro's raw source (a \eg shorthand pre-note), and escaping would mangle it into
	// \textbackslash{}eg. a 'string' AST node never contains an unescaped special to begin with.
	citation(node) {
		const key = node.textContent;
		const variant = String(node.attrs.variant ?? 'cite');
		const pre = node.attrs.prenote ? String(node.attrs.prenote) : '';
		const post = node.attrs.postnote ? String(node.attrs.postnote) : '';
		const NO_NOTES = new Set(['supercite', 'citeauthor', 'citeyear']); // don't take [pre][post]
		if (NO_NOTES.has(variant) || (!pre && !post)) return `\\${variant}{${key}}`;
		// one bracket is the postnote for natbib, biblatex and plain \cite alike; only a prenote
		// needs the two-bracket form, which plain LaTeX's \cite does not understand
		if (!pre) return `\\${variant}[${post}]{${key}}`;
		return `\\${variant}[${pre}][${post}]{${key}}`;
	},

	// preserve the original reference command so the output matches the user's preamble
	ref: (node) => `\\${String(node.attrs.command ?? 'ref')}{${node.textContent}}`,

	// back exactly where it stood: a \label names whichever counter was last incremented, so its
	// position IS its meaning, and moving it would silently repoint it
	label: (node) => `\\label{${String(node.attrs.name ?? '')}}`,

	image(node) {
		const numbered = node.attrs.numbered !== false;
		const showCaption = node.attrs.showCaption !== false;
		const graphics = buildIncludegraphics(node);
		const capContent = renderChildren(node, false);
		// verbatim short-caption \caption[short]{long}; see the captionOpt attr in schema.ts
		const capOpt = typeof node.attrs.captionOpt === 'string' && node.attrs.captionOpt ? `[${node.attrs.captionOpt}]` : '';
		const caption = showCaption ? `\\caption${numbered ? '' : '*'}${capOpt}{${capContent}}` : '';
		const labelText = numbered && showCaption ? String(node.attrs.label ?? '') : '';
		const label = labelText ? `\\label{${labelText}}` : '';

		// imported figure: substitute the editable bits back into the verbatim float template so
		// all surrounding scaffolding (centerline, vspace, captionsetup, placement) is preserved.
		const template = node.attrs.figureTemplate as string | null;
		if (typeof template === 'string' && template) {
			let out = template.split(FIG_IMG_SLOT).join(graphics).split(FIG_CAP_SLOT).join(caption).split(FIG_LAB_SLOT).join(label);
			// a caption added in the editor to a figure that had none has no slot to fill; drop
			// it in just before \end{figure}.
			if (showCaption && capContent && !template.includes(FIG_CAP_SLOT)) {
				out = out.replace(/(\n?)(\\end\{figure\*?\})\s*$/, `\n${caption}\n$2`);
			}
			return out.replace(/\s*$/, '') + '\n';
		}

		// a \includegraphics that was standalone in the source round-trips bare: synthesizing a
		// \begin{figure} is often a compile error (nested floats), and this image never had a
		// \caption/\label to begin with. see the bareOriginal attr in schema.ts. A caption typed
		// in the editor since needs a float to live in, so that one does get the figure below
		if (node.attrs.bareOriginal && !(showCaption && capContent.trim())) return graphics + '\n';

		// editor-created image: a standard centered figure
		const env = node.attrs.spanning === true ? 'figure*' : 'figure';
		const captionLine = caption ? caption + '\n' : '';
		const labelLine = label ? label + '\n' : '';
		return `\\begin{${env}}[h]\n\\centering\n${graphics}\n${captionLine}${labelLine}\\end{${env}}\n`;
	},

	// prosemirror-flat-list: each `list` node is ONE item; same-kind siblings coalesce.
	list(node, ctx) {
		const kind = String(node.attrs.kind ?? 'bullet');
		const prev = prevSibling(ctx);
		const next = nextSibling(ctx);
		const defaultEnv = kind === 'ordered' ? 'enumerate' : 'itemize';
		// a description environment is remembered on the run's first node; the rest inherit it. A
		// node naming an environment of its own opens a new run: a description after an itemize
		// is not its continuation, whatever the kinds say
		const envName = runEnvName(node, ctx);
		const env = envName ?? defaultEnv;
		const own = ownEnvName(node);
		const prevEnv = prev?.type.name === 'list' ? (runEnvName(prev, { ...ctx, index: ctx.index - 1 }) ?? defaultEnv) : null;
		const prevSame =
			prev?.type.name === 'list' && prev.attrs.kind === kind && sameSourceList(prev, node) && (own === null || own === prevEnv);
		const nextOwn = next?.type.name === 'list' ? ownEnvName(next) : null;
		const nextSame =
			next?.type.name === 'list' && next.attrs.kind === kind && sameSourceList(node, next) && (nextOwn === null || nextOwn === env);
		// \item[label]: the editor shows it as leading bold text, so it is taken back out of the
		// body before the bracket is rewritten. The SOURCE label is preferred while the run still
		// says the same thing, since re-serializing turns a tie into a no-break space and a `--`
		// into a dash; once the run says something else, the user edited the label and that wins
		const itemLabel = typeof node.attrs.itemLabel === 'string' ? node.attrs.itemLabel : null;
		// the label is compared with the source's by its words, which a shadow run would not have
		const shadowing = shadow;
		shadow = null;
		// the block carrying the label: the first, unless a line break at its start left empty
		// paragraphs in front of it, which \item writes as nothing
		let first = 0;
		let labelled: ReturnType<typeof splitLeadingLabel>;
		try {
			while (first < node.childCount - 1 && isEmptyParagraph(node.child(first)) && splitLeadingLabel(node.child(first + 1)) !== null)
				first++;
			labelled = node.childCount > 0 ? splitLeadingLabel(node.child(first)) : null;
		} finally {
			shadow = shadowing;
		}
		const sourceHolds = itemLabel != null && labelled != null && labelKey(labelled.latex) === labelKey(itemLabel);
		const label = labelled ? (sourceHolds ? itemLabel : labelled.latex) : itemLabel === '' ? '' : null;
		// a `]` in the label would close the bracket early: braces around it keep it inside
		const bracketed = label != null && label.includes(']') && !/^\{[^]*\}$/.test(label) ? `{${label}}` : label;
		const itemCmd = label == null ? '\\item' : `\\item[${bracketed}]`;

		// an item's untouched blocks are written out as their bytes; the labelled first block is shown
		// without its label, so it is always rendered afresh
		const inners: string[] = [];
		node.forEach((item, _offset, i) => {
			const shown = i === first && labelled ? labelled.body : item;
			inners.push(serializeNode(shown, { parent: node, index: i, isLastChild: i === node.childCount - 1, inTableCell: ctx.inTableCell }));
		});
		const rendered = assembly.verbatimParts(node, inners, { join: false, keep: (i) => i === first && !!labelled });
		const parts: string[] = [];
		node.forEach((item, _offset, i) => {
			const inner = rendered[i];
			if (i < first) return;
			if (item.type.name === 'list') {
				// only the FIRST of a run of same-kind sub-lists opens \item[]; the rest coalesce
				// into the same nested env (prevSame means no \begin), and another \item[] would
				// re-parse as an extra empty item and double every save.
				const prevChild = i > 0 ? node.child(i - 1) : null;
				const continues = prevChild?.type.name === 'list' && prevChild.attrs.kind === item.attrs.kind;
				// a sub-list under the item's OWN body needs no \item[]: that item is already open, and
				// the break the nested env opens with would put a blank line between the two
				const afterBody = !!prevChild && prevChild.type.name !== 'list';
				parts.push(continues ? `\n${inner}` : afterBody ? inner.replace(/^\n/, '') : `\\item[] ${inner}`);
			} else if (i === first) {
				const alone = labelled && !inner.trim() && node.childCount > first + 1 && node.child(first + 1).type.name !== 'list';
				parts.push(alone ? `${itemCmd} \\par` : `${itemCmd}${labelled?.glued ? '' : ' '}${guardItemBody(inner)}`);
			} else parts.push('\n' + inner); // continuation block within the same item
		});

		let out = '';
		if (!prevSame) {
			// enumitem-style options the source gave the environment; see createList
			const envArgs = typeof node.attrs.envArgs === 'string' ? node.attrs.envArgs : '';
			out += `\n\\begin{${env}}${envArgs}\n`;
			// raw setup content that preceded the first \item in the source; see createList
			const preBody = typeof node.attrs.preBody === 'string' ? node.attrs.preBody : '';
			if (preBody) out += preBody + '\n';
		}
		out += parts.join('');
		// an item body already ends its line, so a break of our own would open a blank one above \end
		if (!nextSame) out += `${out.endsWith('\n') ? '' : '\n'}\\end{${env}}\n`;
		return out;
	},

	// table family lives in tableSerializer.ts
	table_wrapper: (node) => serializeTable(node, serializeNode),
	table: (node) => serializeTable(node, serializeNode),
	table_caption: (node) => serializeTable(node, serializeNode),
	table_notes: (node) => serializeTable(node, serializeNode),
	table_row: (node, ctx) => serializeRowCells(node, ctx.parent?.type.name === 'table' ? ctx.parent : null, serializeNode),
	table_cell: (node, ctx) => serializeCell(node, ctx.index === 0, serializeNode),
	table_header: (node) => serializeTable(node, serializeNode)
};

/** Serialize one node. Leaves use the schema's own leafText; unknowns preserve content. */
export function serializeNode(node: Node, ctx: Ctx): string {
	// leafText atoms (inline_math, inline_latex) CAN carry marks (converter.ts attaches one when
	// an unknown macro sits inside \textbf, since there's no text node inside to carry it), so
	// wrap them the same way `text` does.
	const leafText = node.type.spec.leafText;
	if (leafText && !node.isText) {
		const text = applyMarks(shadowed(node, leafText(node)), node.marks);
		// A comment chip owns the rest of its line: % consumes to the newline, so one is restored
		// here or the prose after the chip would be commented out. The chip's own text stays
		// single-line for display (a baked-in newline rendered as an empty second chip line).
		if (node.type.name === 'inline_latex' && text.startsWith('%') && !text.endsWith('\n')) return text + '\n';
		return text;
	}

	const handler = NODES[node.type.name];
	if (handler) {
		const text = handler(node, ctx);
		return isHandlerLeaf(node) ? shadowed(node, text) : text;
	}

	// unknown node: preserve content rather than dropping it
	return node.isText ? esc(node.text ?? '', 'text') : renderChildren(node, ctx.inTableCell);
}

/**
 * Serialize a ProseMirror doc to a LaTeX body. trimming happens INSIDE
 * serializeDocChildrenDetailed (only at unprotected edges); an outer .trim() here would strip a
 * preserved boundary right back off.
 */
export function serializeToLatex(doc: Node): string {
	return serializeDocChildrenDetailed(doc).text;
}

/**
 * Like serializeToLatex, but also reports whether each edge is a verbatim-preserved original
 * boundary: latexRoundtrip.ts must NOT insert its own separator around a protected edge (the
 * body already carries the exact original bytes), only around a regenerated one.
 */
export function serializeToLatexDetailed(doc: Node, parse?: ParseOrigins | null): DocSerializeResult {
	return serializeDocChildrenDetailed(doc, parse);
}

/** Nothing but labels (and whitespace) - the paragraph the importer makes for a \label sitting on
 *  its own line under a heading. */
function isLabelOnlyParagraph(node: Node): boolean {
	let sawLabel = false;
	let sawOther = false;
	node.forEach((c) => {
		if (c.type.name === 'label') sawLabel = true;
		else if (c.isText) sawOther ||= (c.text ?? '').trim() !== '';
		else sawOther = true;
	});
	return sawLabel && !sawOther;
}

function isEmptyParagraph(node: Node): boolean {
	if (node.childCount === 0) return true;
	let empty = true;
	node.forEach((c) => {
		if (c.isText) {
			if (c.text && c.text.trim() !== '') empty = false;
		} else if (c.type.name !== 'hard_break') {
			empty = false;
		}
	});
	return empty;
}
