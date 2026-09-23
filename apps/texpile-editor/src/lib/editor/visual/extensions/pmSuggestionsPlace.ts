// where a suggestion sits in the rendered document: the file around it parsed with and without it,
// the two compared, and each change carried into the editor's document through the source map
import type { Fragment, Mark, Node as PMNode } from 'prosemirror-model';
import type { SuggestionMark } from '$lib/comments/activeSuggestions.svelte';
import { chipLetters } from '$lib/editor/spellcheck/blockSpellText';
import {
	bySource,
	indexStartingBy,
	pmToSource,
	sourceToPm,
	type RegionParse,
	type RegionParser,
	type Segment,
	type SourceMap
} from '../sourceSpans';
import { blockAtPm, blockAtSource } from '../sourceMap';
import { isSelfRendered } from '../diff/selfRendered';
import { diffDocs, textOf, type DocChange } from './pmSuggestionDiff';

/** a run of the words a change took out: text with its marks, or a node standing as one character */
export type OldRun = { text: string; marks: readonly Mark[]; node?: PMNode };

/** content taken out across block edges: the end of the block it started in, whole blocks, the start of the one it ended in */
export type GoneContent = { head: OldRun[]; blocks: PMNode[]; tail: OldRun[] };

export type PmSuggestionRange = {
	id: string;
	from: number;
	to: number;
	restore: string;
	mine: boolean;
	/** what stood at `from`, struck out there */
	old: OldRun[];
	/** the blocks the change is in, tinted whole: the map places it no closer */
	partial: boolean;
	/** the same words with other formatting: the tint says it all, nothing is struck */
	format?: boolean;
	/** a node that draws its own content, tinted whole */
	node?: boolean;
	/** the node it was, set beside the one it is now */
	was?: PMNode;
	/** what was taken out across block edges, drawn as a block of its own where it stood */
	gone?: GoneContent;
	/** a change that only moves a block boundary, and which way it went */
	brk?: 'added' | 'removed';
};

export type SuggestionSource = {
	/** the file's text, which the marks are offsets of and the map describes */
	text: string;
	map: SourceMap;
	/** the stretch of the text the document is: the body, without preamble or postamble */
	body: { from: number; to: number };
	parse: RegionParser;
};

export type PlacedSuggestions = {
	ranges: PmSuggestionRange[];
	partial: Set<string>;
	hidden: Set<string>;
	/** marks of another text than the one given; their last placement stands until the next */
	stale: Set<string>;
};

type Span = { from: number; to: number };
type Side = -1 | 1;

// the top-level blocks the mark's bytes touch, and one more on each side, since a change at a
// block's edge can be the edge itself moving
function regionOf(map: SourceMap, s: Span, body: Span): Span {
	const blocks = bySource(map.blocks);
	if (blocks.length === 0) return body;
	let first = blocks.findIndex((b) => b.srcTo >= s.from);
	let last = -1;
	for (let i = 0; i < blocks.length && blocks[i].srcFrom <= s.to; i++) last = i;
	if (first < 0) first = blocks.length - 1;
	if (last < 0) last = 0;
	if (first > last) [first, last] = [last, first];
	first = Math.max(0, first - 1);
	last = Math.min(blocks.length - 1, last + 1);
	return {
		from: Math.max(body.from, Math.min(blocks[first].srcFrom, s.from)),
		to: Math.min(body.to, Math.max(blocks[last].srcTo, s.to))
	};
}

function plainText(doc: PMNode, from: number, to: number): string {
	return doc.textBetween(from, to, '\n', '￼').replace(/\s+/g, ' ').trim();
}

// a stretch parsed on its own reads as the file does only when its blocks come out the same; a brace
// whose partner is outside the stretch, say, makes a document that is not the one on screen
function readsAsShown(doc: PMNode, map: SourceMap, region: Span, after: RegionParse): boolean {
	const shown = bySource(map.blocks).filter((b) => b.srcFrom >= region.from && b.srcTo <= region.to);
	const parsed = after.map.blocks;
	if (shown.length !== parsed.length) return false;
	return shown.every((b, i) => plainText(doc, b.pmFrom, b.pmTo) === plainText(after.doc, parsed[i].pmFrom, parsed[i].pmTo));
}

// the block a position of a region's document is in; at a boundary two blocks share, the side names it
function blockOnSide(blocks: Segment[], pos: number, assoc: Side): Segment | null {
	const i = indexStartingBy(blocks, 'pmFrom', pos);
	const at = i >= 0 ? blocks[i] : null;
	if (assoc < 0 && at && at.pmFrom === pos && i > 0 && blocks[i - 1].pmTo === pos) return blocks[i - 1];
	return at && pos <= at.pmTo ? at : null;
}

// the byte of a position in a region's document: exact in a run, else the nearest run's edge in the
// innermost block on the side named, else that block's own edge
function regionByte(region: RegionParse, pos: number, assoc: Side): number | null {
	const { leaves } = region.map;
	const exact = pmToSource(leaves, pos, assoc);
	if (exact !== null) return exact;
	const block = blockAtPm(region.map, pos, assoc);
	if (!block) return null;
	const i = indexStartingBy(leaves, 'pmFrom', pos);
	const within = (s: Segment | null) => (s && s.pmFrom >= block.pmFrom && s.pmTo <= block.pmTo ? s : null);
	const before = within(i >= 0 ? leaves[i] : null);
	const after = within(i + 1 < leaves.length ? leaves[i + 1] : null);
	const pick = assoc < 0 ? (before ?? after) : (after ?? before);
	if (pick) return pick === before ? pick.srcTo : pick.srcFrom;
	// a block with no runs: its start for a position near its start, else its end
	return pos <= block.pmFrom + 1 ? block.srcFrom : block.srcTo;
}

type Landing = { pos: number; block: Segment | null };

// a position at the very start of an inline node's content, reached from the byte before the node,
// is the node's own start; likewise its end. The node's opening and closing have no bytes of their
// own, and the runs inside it start one position in
function atNodeEdge(doc: PMNode, pos: number, assoc: Side): number {
	const $pos = doc.resolve(pos);
	if ($pos.depth === 0 || !$pos.parent.isInline || $pos.parent.isText) return pos;
	if (assoc > 0 && $pos.parentOffset === 0) return $pos.before();
	if (assoc < 0 && $pos.parentOffset === $pos.parent.content.size) return $pos.after();
	return pos;
}

// the editor position of a byte: exact in a run, the nearest run's edge in the same block, or the
// block itself when it has no runs
function land(map: SourceMap, offset: number, assoc: Side): Landing | null {
	const exact = sourceToPm(map.leaves, offset, assoc);
	if (exact !== null) return { pos: exact, block: null };
	const block = blockAtSource(map, offset);
	const sorted = bySource(map.leaves);
	const i = indexStartingBy(sorted, 'srcFrom', offset);
	const within = (s: Segment | null) => (s && block && s.srcFrom >= block.srcFrom && s.srcTo <= block.srcTo ? s : null);
	const before = within(i >= 0 ? sorted[i] : null);
	const after = within(i + 1 < sorted.length ? sorted[i + 1] : null);
	const pick = assoc < 0 ? (before ?? after) : (after ?? before);
	if (pick) return { pos: pick === before ? pick.pmTo : pick.pmFrom, block: null };
	return block ? { pos: block.pmFrom, block } : null;
}

// a change the comparison cut between two open tokens, or two close tokens, is the same change cut at
// the blocks' edges, which is how the reader sees it: a whole paragraph came or went
function slide(doc: PMNode, from: number, to: number): Span {
	if (to <= from) return { from, to };
	for (;;) {
		const $from = doc.resolve(from);
		const $to = doc.resolve(to);
		if ($from.depth === 0 || $to.depth === 0 || $from.depth !== $to.depth || $from.parent.type !== $to.parent.type) return { from, to };
		if ($from.parentOffset === 0 && $to.parentOffset === 0) {
			from = $from.before();
			to = $to.before();
			continue;
		}
		if ($from.parentOffset === $from.parent.content.size && $to.parentOffset === $to.parent.content.size) {
			from = $from.after();
			to = $to.after();
			continue;
		}
		return { from, to };
	}
}

function runsOf(content: Fragment): OldRun[] {
	const runs: OldRun[] = [];
	content.forEach((node) => {
		if (node.isText) runs.push({ text: node.text!, marks: node.marks });
		else if (node.isInline) {
			// an accent chip draws as its letter, and its letter is what the reader would miss
			const letters = chipLetters(node);
			runs.push(letters ? { text: letters, marks: node.marks } : { text: '￼', marks: node.marks, node });
		}
	});
	return runs;
}

// the innermost node a slice leaves open at one end
function openEnd(fragment: Fragment, depth: number, last: boolean): PMNode | null {
	let node = last ? fragment.lastChild : fragment.firstChild;
	for (let d = 1; d < depth && node; d++) node = last ? node.lastChild : node.firstChild;
	return node;
}

type OldContent = { runs: OldRun[]; gone: GoneContent | null };

function oldContent(doc: PMNode, from: number, to: number): OldContent {
	if (to <= from) return { runs: [], gone: null };
	const $from = doc.resolve(from);
	const $to = doc.resolve(to);
	if ($from.sameParent($to) && $from.parent.isTextblock) return { runs: runsOf(doc.slice(from, to).content), gone: null };
	const slice = doc.slice(from, to);
	const first = slice.openStart ? openEnd(slice.content, slice.openStart, false) : null;
	const last = slice.openEnd ? openEnd(slice.content, slice.openEnd, true) : null;
	const head = first?.isTextblock ? first : null;
	const tail = last?.isTextblock && last !== first ? last : null;
	const blocks: PMNode[] = [];
	const collect = (node: PMNode) => {
		if (node === head || node === tail) return;
		if (node.isTextblock || node.isLeaf || node.isAtom) blocks.push(node);
		else node.forEach(collect);
	};
	slice.content.forEach(collect);
	return { runs: [], gone: { head: head ? runsOf(head.content) : [], blocks, tail: tail ? runsOf(tail.content) : [] } };
}

// the node a change sits inside that draws its own content, at or above `pos`
function selfRenderedAround(doc: PMNode, pos: number, to = pos): Span | null {
	const $pos = doc.resolve(pos);
	for (let d = $pos.depth; d > 0; d--) {
		if ($pos.node(d).isLeaf || !isSelfRendered($pos.node(d))) continue;
		return to <= $pos.after(d) ? { from: $pos.before(d), to: $pos.after(d) } : null;
	}
	return null;
}

function nodeAround(doc: PMNode, pos: number, to = pos): PMNode | null {
	const span = selfRenderedAround(doc, pos, to);
	return span ? doc.nodeAt(span.from) : null;
}

function blocksSpanning(map: SourceMap, from: number, to: number): Span | null {
	const a = blockAtPm(map, from);
	const b = blockAtPm(map, to) ?? a;
	if (!a && !b) return null;
	return { from: Math.min((a ?? b)!.pmFrom, (b ?? a)!.pmFrom), to: Math.max((a ?? b)!.pmTo, (b ?? a)!.pmTo) };
}

type Placement = { ranges: PmSuggestionRange[]; partial: boolean } | null;

/** one mark's share of a change: a range of the document before and the one after */
type Piece = { A: Span; B: Span };

/** the stretch as the editor shows it: its document, where its bytes are, and its top-level blocks in order */
type Shown = { doc: PMNode; map: SourceMap; at: number; blocks: Segment[] };

// where the stretch's document has `pos`, the editor's document has it too: found by the bytes of the
// run there, else of the nearest run in the same textblock, else by its place in the block, which the
// two documents share
function landIn(shown: Shown, region: RegionParse, pos: number, assoc: Side): Landing | null {
	const { leaves, blocks } = region.map;
	// inside a node that draws itself, the position stays inside: the node's bytes are one run, so
	// its start is found and the position put just past it
	const $pos = region.doc.resolve(pos);
	for (let d = $pos.depth; d > 0; d--) {
		const node = $pos.node(d);
		if (node.isLeaf || !isSelfRendered(node)) continue;
		const byte = pmToSource(leaves, $pos.before(d), 1);
		const start = byte === null ? null : sourceToPm(shown.map.leaves, shown.at + byte, 1);
		if (start === null) break;
		const own = shown.doc.nodeAt(start);
		return { pos: own && own.type === node.type ? start + 1 : start, block: null };
	}
	const exact = pmToSource(leaves, pos, assoc);
	if (exact !== null) {
		const l = land(shown.map, shown.at + exact, assoc);
		if (l && !l.block) return l;
	}
	if ($pos.parent.isTextblock) {
		const lo = $pos.start();
		const hi = $pos.end();
		const i = indexStartingBy(leaves, 'pmFrom', pos);
		const within = (s: Segment | null) => (s && s.pmFrom >= lo && s.pmTo <= hi ? s : null);
		const before = within(i >= 0 ? leaves[i] : null);
		const after = within(i + 1 < leaves.length ? leaves[i + 1] : null);
		const pick = assoc < 0 ? (before ?? after) : (after ?? before);
		if (pick) {
			const l = land(shown.map, shown.at + (pick === before ? pick.srcTo : pick.srcFrom), pick === before ? -1 : 1);
			if (l && !l.block) return l;
		}
	}
	const j = blocks.indexOf(blockOnSide(blocks, pos, assoc)!);
	const own = shown.blocks[j];
	if (j < 0 || !own) return null;
	// the same path down from the top-level block, the same offset in the innermost node
	const top = shown.doc.resolve(own.pmFrom).index(0) + ($pos.index(0) - region.doc.resolve(blocks[j].pmFrom).index(0));
	if ($pos.depth === 0)
		return top < 0 || top > shown.doc.childCount
			? { pos: own.pmFrom, block: own }
			: { pos: shown.doc.resolve(0).posAtIndex(top), block: null };
	if (top < 0 || top >= shown.doc.childCount) return { pos: own.pmFrom, block: own };
	let node = shown.doc.child(top);
	let start = shown.doc.resolve(0).posAtIndex(top);
	for (let d = 1; d < $pos.depth; d++) {
		const index = $pos.index(d);
		if (index >= node.childCount) return { pos: start + node.nodeSize - 1, block: null };
		let offset = 1;
		for (let k = 0; k < index; k++) offset += node.child(k).nodeSize;
		start += offset;
		node = node.child(index);
	}
	return { pos: start + 1 + Math.min($pos.parentOffset, node.content.size), block: null };
}

function placeChange(doc: PMNode, s: SuggestionMark, { A, B }: Piece, before: RegionParse, after: RegionParse, shown: Shown): Placement {
	const base = { id: s.id, restore: s.restore, mine: s.mine, old: [] as OldRun[], partial: false };
	const map = shown.map;
	const lenA = A.to - A.from;
	const lenB = B.to - B.from;
	const point = lenB === 0;
	const a = landIn(shown, after, B.from, point ? -1 : 1);
	const b = point ? a : landIn(shown, after, B.to, -1);
	if (!a || !b) return null;
	const size = doc.content.size;
	const edgeA = a.block ? a.pos : atNodeEdge(doc, Math.min(a.pos, size), point ? -1 : 1);
	const edgeB = b.block ? b.pos : atNodeEdge(doc, Math.min(b.pos, size), -1);
	const from = Math.min(edgeA, edgeB, size);
	const to = Math.min(Math.max(edgeA, edgeB), size);
	if (a.block || b.block) {
		const blocks = blocksSpanning(map, from, to);
		return blocks ? { ranges: [{ ...base, ...blocks, partial: true }], partial: true } : null;
	}
	const newText = textOf(after.doc, B.from, B.to);
	const oldText = textOf(before.doc, A.from, A.to);
	// inside a node that draws itself, or a change to what such a node is (its source, say) that
	// the comparison reads as its opening token. A leaf (a line break, a label) is drawn by the
	// editor like a character and takes the tint the words do
	const atStart = doc.nodeAt(from);
	const chip =
		selfRenderedAround(doc, from, to) ??
		(atStart && !atStart.isLeaf && isSelfRendered(atStart) && to <= from + atStart.nodeSize ? { from, to: from + atStart.nodeSize } : null);
	if (chip) {
		// a node the change begins inside stood before it and was changed by it; one whose opening is
		// in the change is new, or stands in place of what the change took out
		const stood = selfRenderedAround(after.doc, B.from) !== null;
		const found = stood ? nodeAround(before.doc, A.from, A.to) : lenA > 0 ? before.doc.nodeAt(A.from) : null;
		const was = found && !found.isLeaf && isSelfRendered(found) ? found : null;
		// what the node replaced, when that was not such a node itself: words, or whole blocks
		const old = was ? { runs: [], gone: null } : oldContent(before.doc, A.from, A.to);
		const ranges: PmSuggestionRange[] = [];
		if (old.gone) ranges.push({ ...base, from: chip.from, to: chip.from, gone: old.gone });
		ranges.push({ ...base, ...chip, node: true, old: old.runs, ...(was ? { was } : {}) });
		// what stood after the node it was and is in the change too (the paragraph a figure took
		// in as its caption): struck after the node, where it stood
		const beyond = was && !stood && A.from + was.nodeSize < A.to ? oldContent(before.doc, A.from + was.nodeSize, A.to) : null;
		if (beyond?.gone) ranges.push({ ...base, from: chip.to, to: chip.to, gone: beyond.gone });
		else if (beyond?.runs.length) ranges.push({ ...base, from: chip.to, to: chip.to, old: beyond.runs });
		return { ranges, partial: false };
	}
	// block boundaries moved and no words did: a break came or went, or a block became another kind
	const boundsA = lenA - oldText.length;
	const boundsB = lenB - newText.length;
	if (newText.trim() === '' && oldText.trim() === '' && (boundsA !== boundsB || lenA + lenB === boundsA + boundsB)) {
		// the space a break replaced is struck beside the mark, and one that replaced a break is tinted
		if (boundsB > boundsA)
			return { ranges: [{ ...base, from, to: from, brk: 'added', old: oldContent(before.doc, A.from, A.to).runs }], partial: false };
		if (boundsA > boundsB) return { ranges: [{ ...base, from, to, brk: 'removed' }], partial: false };
		const $from = doc.resolve(from);
		const block = $from.depth > 0 ? { from: $from.before(1), to: $from.after(1) } : { from, to };
		return { ranges: [{ ...base, ...block, node: true, format: true }], partial: false };
	}
	const old = oldContent(before.doc, A.from, A.to);
	const ranges: PmSuggestionRange[] = [];
	if (old.gone) {
		// whole blocks taken out at a block's edge stand at the join between blocks; taken out of the
		// middle of one, or with the end or start of a block among them, they stand where the text broke
		const $from = doc.resolve(from);
		const mid = $from.parent.isTextblock && $from.parentOffset > 0 && $from.parentOffset < $from.parent.content.size;
		const inline = mid || old.gone.head.length > 0 || old.gone.tail.length > 0;
		// between blocks at any depth the position is the join itself; inside a textblock, the join
		// is that block's own edge, so a block taken out of an item stands in the item
		const edge =
			inline || !$from.parent.isTextblock || $from.depth === 0 ? from : $from.parentOffset === 0 ? $from.before() : $from.after();
		ranges.push({ ...base, from: edge, to: edge, gone: old.gone });
	}
	if (newText !== '' || old.runs.length) {
		const format = newText !== '' && newText === oldText;
		ranges.push({ ...base, from, to, old: old.runs, ...(format ? { format } : {}) });
	}
	return { ranges, partial: false };
}

// marks whose stretches touch are read together: one edit can arrive as several suggestions (a
// paragraph pulled into a heading is a deleted `}` and an added one), and only with all of them put
// back does the file read as it did
type Cluster = { region: Span; marks: SuggestionMark[] };

function clustersOf(marks: SuggestionMark[], map: SourceMap, body: Span): Cluster[] {
	const out: Cluster[] = [];
	for (const s of [...marks].sort((x, y) => x.from - y.from || x.to - y.to)) {
		const region = regionOf(map, s, body);
		const last = out[out.length - 1];
		if (last && region.from <= last.region.to) {
			last.region.to = Math.max(last.region.to, region.to);
			last.marks.push(s);
		} else out.push({ region, marks: [s] });
	}
	return out;
}

/** a mark with its bytes in the stretch before (its words put back) and after (as the file is) */
type MarkBytes = { mark: SuggestionMark; a: Span; b: Span };

function touches(s: Span, bytes: Span | null): boolean {
	if (!bytes) return false;
	if (bytes.from === bytes.to) return s.from <= bytes.from && bytes.from <= s.to;
	if (s.from === s.to) return bytes.from <= s.from && s.from <= bytes.to;
	return s.from < bytes.to && bytes.from < s.to;
}

function distance(s: Span, at: number): number {
	return at < s.from ? s.from - at : at > s.to ? at - s.to : 0;
}

// the position of a byte in a region's document: exact in a run, else the nearest run's edge in the
// block, else the block's own edge
function regionPos(region: RegionParse, byte: number, assoc: Side): number | null {
	const { leaves, blocks } = region.map;
	const exact = sourceToPm(leaves, byte, assoc);
	if (exact !== null) return exact;
	const sorted = bySource(leaves);
	const block = blocks.find((b) => b.srcFrom <= byte && byte <= b.srcTo) ?? null;
	const i = indexStartingBy(sorted, 'srcFrom', byte);
	const within = (s: Segment | null) => (s && block && s.srcFrom >= block.srcFrom && s.srcTo <= block.srcTo ? s : null);
	const before = within(i >= 0 ? sorted[i] : null);
	const after = within(i + 1 < sorted.length ? sorted[i + 1] : null);
	const pick = assoc < 0 ? (before ?? after) : (after ?? before);
	if (pick) return pick === before ? pick.pmTo : pick.pmFrom;
	if (!block) return null;
	return byte <= block.srcFrom ? block.pmFrom : byte >= block.srcTo ? block.pmTo : Math.min(block.pmFrom + 1, block.pmTo);
}

function bytesOf(region: RegionParse, span: Span): Span | null {
	const point = span.to === span.from;
	const from = regionByte(region, span.from, point ? -1 : 1);
	const to = point ? from : regionByte(region, span.to, -1);
	return from === null || to === null ? null : { from, to: Math.max(from, to) };
}

// a change shared out among the marks whose bytes it lies in, cut where the next mark's bytes begin:
// two words taken out at one spot by two people are two changes, not one
type Stretch = { fromA: number; toA: number; fromB: number; toB: number; joined?: boolean };

// words the comparison matched, but that the reader sees in another kind of place: in prose on one
// side and inside a node that draws itself (a figure's caption) on the other. The comparison reads
// only the node's tokens as changed, so the words would draw as untouched while the block they
// came from vanished; the changes on either side are read as one that takes the words in
function movedIntoNode(before: RegionParse, aFrom: number, aTo: number, after: RegionParse, bFrom: number, bTo: number): boolean {
	if (aTo <= aFrom || bTo <= bFrom || textOf(before.doc, aFrom, aTo).trim() === '') return false;
	return (selfRenderedAround(before.doc, aFrom, aTo) !== null) !== (selfRenderedAround(after.doc, bFrom, bTo) !== null);
}

// the first edge of a node that draws itself which a range crosses: the node's start when the
// range takes the node in after words of its own, its end when the range leaves the node
function crossedEdge(doc: PMNode, from: number, to: number): { pos: number; side: 'start' | 'end' } | null {
	let found: { pos: number; side: 'start' | 'end' } | null = null;
	doc.nodesBetween(from, to, (node, pos) => {
		if (found || node.isLeaf || node.isText || !isSelfRendered(node)) return !found;
		const end = pos + node.nodeSize;
		if (pos > from && pos < to) found = { pos, side: 'start' };
		else if (pos < from && end > from && end < to) found = { pos: end, side: 'end' };
		return false;
	});
	return found;
}

// a change that runs from words into a node that draws itself (or out of one) is two: the words,
// and the node, which is then set beside the node it was rather than struck as a block with them
function splitAtNodes(changes: DocChange[], before: RegionParse, after: RegionParse): Stretch[] {
	const out: Stretch[] = [];
	for (const c of changes) {
		let cur: Stretch = { fromA: c.fromA, toA: c.toA, fromB: c.fromB, toB: c.toB };
		for (;;) {
			const a = crossedEdge(before.doc, cur.fromA, cur.toA);
			const b = crossedEdge(after.doc, cur.fromB, cur.toB);
			if (!a || !b || a.side !== b.side) break;
			out.push({ fromA: cur.fromA, toA: a.pos, fromB: cur.fromB, toB: b.pos });
			cur = { fromA: a.pos, toA: cur.toA, fromB: b.pos, toB: cur.toB };
		}
		out.push(cur);
	}
	return out;
}

function joinAcrossNodes(changes: Stretch[], before: RegionParse, after: RegionParse): Stretch[] {
	const out: Stretch[] = [];
	for (const c of changes) {
		const prev = out[out.length - 1];
		if (prev && movedIntoNode(before, prev.toA, c.fromA, after, prev.toB, c.fromB)) {
			prev.toA = c.toA;
			prev.toB = c.toB;
			prev.joined = true;
		} else out.push({ fromA: c.fromA, toA: c.toA, fromB: c.fromB, toB: c.toB });
	}
	return out;
}

function shareOut(c: Stretch, before: RegionParse, after: RegionParse, marks: MarkBytes[]): { mark: SuggestionMark; piece: Piece }[] {
	const A = slide(before.doc, c.fromA, c.toA);
	const B = slide(after.doc, c.fromB, c.toB);
	const aBytes = bytesOf(before, A);
	const bBytes = bytesOf(after, B);
	let involved = marks.filter((m) => touches(m.a, aBytes) || touches(m.b, bBytes));
	if (involved.length === 0) {
		const at = bBytes?.from ?? aBytes?.from ?? 0;
		involved = [marks.reduce((best, m) => (distance(m.b, at) < distance(best.b, at) ? m : best))];
	}
	// a change read as one across a node is drawn whole, by the first of its marks; the others
	// ride with it
	if (involved.length === 1 || c.joined) return [{ mark: involved[0].mark, piece: { A, B } }];
	const clamp = (pos: number | null, lo: number, hi: number) => Math.min(hi, Math.max(lo, pos ?? lo));
	const out: { mark: SuggestionMark; piece: Piece }[] = [];
	let prevA = A.from;
	let prevB = B.from;
	for (let i = 1; i < involved.length; i++) {
		const cutA = clamp(regionPos(before, involved[i].a.from, 1), prevA, A.to);
		const cutB = clamp(regionPos(after, involved[i].b.from, 1), prevB, B.to);
		out.push({ mark: involved[i - 1].mark, piece: { A: { from: prevA, to: cutA }, B: { from: prevB, to: cutB } } });
		prevA = cutA;
		prevB = cutB;
	}
	out.push({ mark: involved[involved.length - 1].mark, piece: { A: { from: prevA, to: A.to }, B: { from: prevB, to: B.to } } });
	return out;
}

export function placePmSuggestions(doc: PMNode, marks: SuggestionMark[], source: SuggestionSource): PlacedSuggestions {
	const ranges: PmSuggestionRange[] = [];
	const partial = new Set<string>();
	const hidden = new Set<string>();
	const stale = new Set<string>();
	if (marks.length === 0) return { ranges, partial, hidden, stale };
	const { text, map, body, parse } = source;
	const asBlocks = (s: SuggestionMark) => {
		const a = blockAtSource(map, s.from);
		const b = blockAtSource(map, s.to) ?? a;
		if (!a && !b) {
			hidden.add(s.id);
			return;
		}
		ranges.push({
			id: s.id,
			from: Math.min((a ?? b)!.pmFrom, (b ?? a)!.pmFrom),
			to: Math.max((a ?? b)!.pmTo, (b ?? a)!.pmTo),
			restore: s.restore,
			mine: s.mine,
			old: [],
			partial: true
		});
		partial.add(s.id);
	};
	const live: SuggestionMark[] = [];
	for (const s of marks) {
		if (s.to < s.from || text.slice(s.from, s.to) !== s.anchor.quote) stale.add(s.id);
		else if (s.from < body.from || s.to > body.to) hidden.add(s.id);
		else live.push(s);
	}
	for (const { region, marks: group } of clustersOf(live, map, body)) {
		const after = parse(text.slice(region.from, region.to));
		// a parser that says where no run of the stretch came from leaves the blocks as all that can be said
		if (after.map.leaves.length === 0 || !readsAsShown(doc, map, region, after)) {
			group.forEach(asBlocks);
			continue;
		}
		const shown: Shown = {
			doc,
			map,
			at: region.from,
			blocks: bySource(map.blocks).filter((b) => b.srcFrom >= region.from && b.srcTo <= region.to)
		};
		let beforeSrc = text.slice(region.from, region.to);
		for (const s of [...group].reverse())
			beforeSrc = beforeSrc.slice(0, s.from - region.from) + s.restore + beforeSrc.slice(s.to - region.from);
		const before = parse(beforeSrc);
		const bytes: MarkBytes[] = [];
		let shift = 0;
		for (const mark of group) {
			const from = mark.from - region.from + shift;
			bytes.push({ mark, a: { from, to: from + mark.restore.length }, b: { from: mark.from - region.from, to: mark.to - region.from } });
			shift += mark.restore.length - (mark.to - mark.from);
		}
		const owned = new Map<SuggestionMark, Piece[]>(group.map((s) => [s, []]));
		// the node it was is set beside a node once, however many marks changed it
		const wasAt = new Set<string>();
		for (const c of joinAcrossNodes(splitAtNodes(diffDocs(before.doc, after.doc), before, after), before, after)) {
			for (const { mark, piece } of shareOut(c, before, after, bytes)) owned.get(mark)!.push(piece);
		}
		// a mark with nothing readable of its own - the closing brace of a wrapper whose opening
		// brace is another mark, whitespace beside a mark that changed words - rides with the marks
		// of its cluster that did change something the reader sees: placed where they are, drawing
		// nothing of its own. Only when no mark of the cluster changed anything readable do the
		// blocks say that something did.
		const visible = (pieces: Piece[]) => pieces.some((p) => p.A.to > p.A.from || p.B.to > p.B.from);
		const riders: SuggestionMark[] = [];
		const anchors: PmSuggestionRange[] = [];
		for (const [s, pieces] of owned) {
			if (!visible(pieces)) {
				riders.push(s);
				continue;
			}
			const placed = pieces.map((piece) => placeChange(doc, s, piece, before, after, shown));
			if (placed.some((p) => !p)) {
				hidden.add(s.id);
				continue;
			}
			// a node changed in several places is one outline
			const outlined = new Map<string, PmSuggestionRange>();
			for (const p of placed) {
				if (p!.partial) partial.add(s.id);
				for (const r of p!.ranges) {
					if (!r.node) {
						ranges.push(r);
						continue;
					}
					const key = `${r.from}:${r.to}`;
					if (r.was) {
						if (wasAt.has(key)) delete r.was;
						else wasAt.add(key);
					}
					const seen = outlined.get(key);
					if (!seen) {
						outlined.set(key, r);
						ranges.push(r);
					} else if (!seen.was && r.was) seen.was = r.was;
				}
			}
			for (const p of placed) if (!p!.partial) for (const r of p!.ranges) if (!r.partial) anchors.push(r);
		}
		for (const s of riders) {
			if (anchors.length === 0) {
				asBlocks(s);
				continue;
			}
			// at the start of the first mate's range, nothing of its own to draw
			const at = anchors.reduce((best, r) => (r.from < best.from ? r : best));
			ranges.push({ id: s.id, from: at.from, to: at.from, restore: s.restore, mine: s.mine, old: [], partial: false, format: true });
		}
	}
	return { ranges, partial, hidden, stale };
}
