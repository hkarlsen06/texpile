// Format-neutral doc assembly: verbatim substitution over top-level blocks, shared by the LaTeX,
// Markdown and Typst serializers. Knows nothing about any syntax — it deals in what the parse
// remembers of each block (its bytes, the gap before them, its place in the parse's order) and in
// the deterministic text the dialect writes for a block the parse no longer knows.
import type { Node } from 'prosemirror-model';
import type { Ctx } from './types';
import {
	containerOriginsOf,
	isContainer,
	originsOf,
	parseOf,
	shiftSegment,
	type BlockOrigin,
	type ParseOrigins,
	type Segment,
	type SourceMap
} from '$lib/editor/visual/sourceSpans';

/** a top-level block as the dialect hooks see it: the node, what the parse still knows it as, and
 *  what it most likely replaced when the parse no longer knows it */
export type Neighbour = { node: Node; origin: BlockOrigin | null; was: BlockOrigin | null };

export type DocSerializeResult = {
	text: string;
	/** True iff the leading bytes are the body's verbatim original leading gap; the caller
	 *  (the roundtrip glue) must NOT prepend its own separator then, or it duplicates. */
	leadProtected: boolean;
	/** Same, for the trailing edge. */
	tailProtected: boolean;
	/** The gap the body had at that edge, when the block standing there is still the one that stood
	 *  there at parse time. An EDITED edge block loses its protection but not its gap, and a caller
	 *  that falls back to a separator of its own would drop the blank line that was in the file. */
	leadGap: string | null;
	tailGap: string | null;
	trailingRegenerated: Neighbour | null;
	/** where every run and block of the doc landed in `text` */
	map: SourceMap;
};

/** the parse's last block, which the body's trailing gap follows */
export function isLastOfParse(o: BlockOrigin): boolean {
	return o.index === o.parse.origins.length - 1;
}

/** whether `next` directly followed `prev` in the parse's order */
export function follows(prev: BlockOrigin | null, next: BlockOrigin | null): boolean {
	return !!prev && !!next && prev.parse === next.parse && next.index === prev.index + 1;
}

// the gaps at the body's edges belong to the body, not to the block standing there: a block written
// afresh at an edge, or put there in place of the one the file had, keeps the file's gap
function edgeGaps(neighbours: Neighbour[], parse: ParseOrigins | null): { leadGap: string | null; tailGap: string | null } {
	if (neighbours.length === 0) return { leadGap: null, tailGap: null };
	const first = neighbours[0].origin ?? neighbours[0].was ?? parse?.origins[0] ?? null;
	const lastN = neighbours[neighbours.length - 1];
	const last = lastN.origin ?? lastN.was ?? parse?.origins[parse.origins.length - 1] ?? null;
	return {
		leadGap: first && first.index === 0 && first.pre != null ? first.pre : null,
		tailGap: last && isLastOfParse(last) ? last.parse.tail : null
	};
}

function neighborKey(sib: Neighbour | null): string {
	if (!sib) return '';
	if (sib.node.type.name !== 'list') return sib.node.type.name;
	// the LaTeX list handler coalesces only within one source construct (see sameSourceList)
	const o = sib.origin;
	return `list:${String(sib.node.attrs.kind ?? '')}:${o ? String(o.index - o.member) : ''}`;
}

export type BlockAssemblyOptions = {
	/**
	 * The separator between two adjacent emissions when at least one of them regenerated, or
	 * they are pristine but no longer source-adjacent. `contiguous` says whether `next` still
	 * directly followed `prev` in the source. `before` is the end of what was written so far (its
	 * last 64 characters at least). null keeps the default: a hard blank line.
	 */
	boundary?: (prev: Neighbour, next: Neighbour, contiguous: boolean, before: string) => string | null;
	/** the text of the last block written, before a blank line goes after it: what a paragraph's
	 *  end should be once something follows */
	beforeBreak?: (text: string, last: Neighbour, next: Neighbour) => string;
	/** the leaf runs of a block the dialect regenerated, against that block's own text, positions
	 *  relative to the block node; null when they could not be told apart */
	mapLeaves?: (node: Node, ctx: Ctx, text: string) => Segment[] | null;
	/** in a shadow run, what stands for a child written out as its bytes inside a regenerated
	 *  block; the bytes themselves otherwise */
	shadowChunk?: (node: Node, bytes: string) => string;
	/** whether a changed child may be rendered on its own inside its container's frame; false
	 *  for one the container's handler renders together with its frame (an item's label) */
	spliceChild?: (parent: Node, index: number, was: Node | null) => boolean;
	/** what goes before every line but the first of a child written afresh inside its container's
	 *  frame, told from the bytes the child had (`text`) and what stood on its first line before
	 *  it (`head`: a list marker, a quote prefix, indentation); null or '' for nothing. Dialects
	 *  whose blocks continue by indentation or a line prefix provide it */
	continuation?: (parent: Node, text: string, head: string) => string | null;
	/** what separates two children of `parent` when the file shows no gap to copy (a container that
	 *  had one child): null for a blank line prefixed with `prefix`, the dialect's own otherwise (a
	 *  \par between the paragraphs of a LaTeX table cell) */
	childGap?: (parent: Node, prefix: string) => string | null;
	/** the bytes a text leaf is written as, on its own, its marks left to the wrappers around
	 *  it: the dialect's escaping for prose, the text itself inside a formula or a chip. Null
	 *  when the leaf cannot be written on its own. `atStart` says the bytes begin the block's
	 *  content, where a dialect's line-start markup binds */
	leafBytes?: (leaf: Node, parent: Node, atStart: boolean, block: Node, ctx?: Ctx) => string | null;
	/** inline `nodes` of a textblock, written as the dialect writes a run of inline content, with
	 *  no block-level decoration; null when they cannot be written on their own (a comment chip,
	 *  which owns its line) */
	inlineBytes?: (block: Node, nodes: Node[], atStart: boolean, ctx: Ctx) => string | null;
	/** the leaf runs of that text, positions relative to a block holding just those nodes; null
	 *  when they could not be told apart */
	mapInlineLeaves?: (block: Node, nodes: Node[], text: string, atStart: boolean, ctx: Ctx) => Segment[] | null;
	/** the fresh `bytes` as they must be written between the file's bytes before them (`head`) and
	 *  after them (`tail`), so no two of the three read as one (a LaTeX control word before a
	 *  letter takes a space); `bytes` is empty where the change only took bytes out, and the two
	 *  sides then meet; `gone` is what the change took out from between them. Null for a seam the
	 *  dialect cannot write, which gives up the splice and writes the block afresh */
	keepApart?: (bytes: string, tail: string, head: string, gone: string) => string | null;
};

/** how a dialect's own rendering of a container's children is joined */
export type PartsOptions = {
	/** join pristine neighbours on the bytes the file had between them, leaving '' for the parts
	 *  folded into the one before; off for a dialect that prefixes every part itself */
	join?: boolean;
	/** children whose part must stay the dialect's own, whatever the parse knows */
	keep?: (i: number) => boolean;
};

/**
 * Builds the doc-children serializer for one dialect. Each dialect gets its OWN memo cache: the
 * cache is keyed by node identity, and the same node object must never resolve to another
 * dialect's cached text.
 *
 * Assembly semantics: a block the parse still knows re-emits the bytes it came from; pristine
 * neighbours (consecutive in the parse) re-join on their original inter-block bytes; every
 * verbatim/regenerated boundary gets a hard blank line so paragraphs can't merge on re-parse,
 * unless the dialect's `boundary` hook decides otherwise. with no parse this equals plain
 * concatenation. also reproduces the body's leading/trailing gaps (they belong to no node) and
 * does the final trim, ONLY at edges that aren't verbatim-protected.
 */
export function createBlockAssembly(serializeNode: (node: Node, ctx: Ctx) => string, options: BlockAssemblyOptions = {}) {
	// per-block memo. PM nodes are immutable and structurally shared across transactions, so an
	// untouched top-level block keeps its object identity keystroke to keystroke: serializing the
	// whole doc becomes O(edited blocks), not O(doc). a block's output depends only on itself plus
	// the neighbour facts handlers read via prevSibling/nextSibling (heading adjacency for
	// paragraph, type+kind for list coalescing) — captured in `key`. if a handler ever reads more
	// of Ctx at the top level, widen the key.
	type Placed = { key: string; block: Segment; leaves: Segment[]; inner: Segment[] };
	type Entry = { key: string; text: string; leaves?: Segment[] | null; inner?: Segment[] | null; placed?: Placed };
	/** what a splice hands back: the bytes, the leaf runs in them, and the range of every block below
	 *  the top level in them, all relative to the text and to the first node */
	type Spliced = { text: string; leaves: Segment[]; inner: Segment[] };
	const blockCache = new WeakMap<Node, Entry>();

	// a block's placed runs are the same objects call after call while it lands at the same place;
	// nothing changes them in place, so sharing them is safe
	function placedRuns(entry: Entry, key: string, make: () => { block: Segment; leaves: Segment[]; inner: Segment[] }): Placed {
		if (!entry.placed || entry.placed.key !== key) entry.placed = { key, ...make() };
		return entry.placed;
	}

	function ctxFor(doc: Node, i: number, n: number): Ctx {
		return { parent: doc, index: i, isLastChild: i === n - 1, inTableCell: false };
	}

	// prosemirror-tables tags the cell nodes; a dialect writes a line break and a paragraph's end
	// differently inside one, so a child of a cell inherits the flag its container's own handler sets
	function inCell(node: Node): boolean {
		const role = node.type.spec.tableRole;
		return role === 'cell' || role === 'header_cell';
	}

	function serializeTopBlock(doc: Node, i: number, n: number, neighbours: Neighbour[]): Entry {
		const node = doc.child(i);
		const key = neighborKey(i > 0 ? neighbours[i - 1] : null) + '>' + neighborKey(i < n - 1 ? neighbours[i + 1] : null);
		const hit = blockCache.get(node);
		if (hit && hit.key === key) return hit;
		const entry: Entry = { key, text: serializeNode(node, ctxFor(doc, i, n)) };
		// a container that changed inside keeps its frame and its untouched children as their bytes;
		// a block that changed in its text alone keeps everything but the leaves that changed
		const was = neighbours[i].was;
		const spliced = was
			? (frameSplice(node, was, ctxFor(doc, i, n)) ??
				leafSplice(node, was, ctxFor(doc, i, n)) ??
				segmentSplice(node, was, ctxFor(doc, i, n)))
			: null;
		if (spliced) {
			const lead = /^[ \t\r\n]*/.exec(entry.text)![0];
			const trail = /[ \t\r\n]*$/.exec(entry.text)![0];
			entry.text = lead + spliced.text + trail;
			entry.leaves = spliced.leaves.map((s) => ({ ...s, srcFrom: s.srcFrom + lead.length, srcTo: s.srcTo + lead.length }));
			entry.inner = spliced.inner.map((s) => ({ ...s, srcFrom: s.srcFrom + lead.length, srcTo: s.srcTo + lead.length }));
		}
		blockCache.set(node, entry);
		return entry;
	}

	const WS = /^[ \t\r\n]*/;
	const WS_END = /[ \t\r\n]*$/;
	const BLANK = /\n[ \t]*\n/;

	/**
	 * A construct whose shape the parse still knows, written out as the bytes it came from with
	 * only its changed children rendered afresh: the frame around the children, and the gaps
	 * between them, are the file's own. `members` are what the parse knew the construct's blocks
	 * as (one container, or the list nodes an itemize became), `nodes` the blocks standing for
	 * them now. Null when a child was added, removed or moved, a container's own markup changed,
	 * or a child's place in the file is unknown; the dialect's handlers then render the whole
	 * construct. The runs are relative to the first node and to the text.
	 */
	function spliceMembers(
		nodes: Node[],
		members: BlockOrigin[],
		ctx: Ctx,
		lineHead = '',
		owns: BlockOrigin[] | null = null
	): Spliced | null {
		const first = members[0];
		if (nodes.length !== members.length || !first.parse.verbatim || first.text === undefined) return null;
		const src = first.text;
		const base = first.srcFrom!;
		let text = '';
		const leaves: Segment[] = [];
		const inner: Segment[] = [];
		let cursor = base;
		let nodePm = 0;
		for (let m = 0; m < nodes.length; m++) {
			const node = nodes[m];
			const origin = members[m];
			const own = owns?.[m] ?? origin;
			if (own !== origin) {
				// a member dragged into another member's slot: the slot's frame (its marker, the gap
				// before it), then the member's own bytes as the file had them, untouched
				if (node !== own.node) return null;
				const rec = containerOriginsOf(own.node);
				const slotRec = containerOriginsOf(origin.node);
				if (!rec || !slotRec || rec.origins.length === 0 || slotRec.origins.length === 0) return null;
				const ownFrom = rec.origins[0].srcFrom;
				const ownTo = rec.origins[rec.origins.length - 1].srcTo;
				const slotFrom = slotRec.origins[0].srcFrom;
				const slotTo = slotRec.origins[slotRec.origins.length - 1].srcTo;
				if (ownFrom === undefined || ownTo === undefined || slotFrom === undefined || slotTo === undefined || slotFrom < cursor)
					return null;
				for (const co of rec.origins) if (co.text === undefined) return null;
				text += src.slice(cursor - base, slotFrom - base);
				const at = text.length;
				text += src.slice(ownFrom - base, ownTo - base);
				const pmShift = nodePm + 1 - rec.origins[0].pmFrom;
				const srcShift = at - ownFrom;
				for (const co of rec.origins) for (const l of co.leaves) leaves.push(shiftSegment(l, pmShift, srcShift));
				for (const seg of nestedOf([node], rec.origins[0].pmFrom - 1)) inner.push(shiftSegment(seg, pmShift, srcShift));
				cursor = slotTo;
				nodePm += node.nodeSize;
				continue;
			}
			if (!isContainer(node) || !node.sameMarkup(origin.node)) return null;
			const record = containerOriginsOf(origin.node);
			if (!record || record.origins.length === 0) return null;
			const parsed = record.origins;
			for (const o of parsed) if (o.text === undefined || o.srcFrom === undefined || o.srcTo === undefined) return null;
			if (parsed[0].srcFrom! < cursor) return null;
			// the frame: what opens the container (up to its first child), the gap before each parsed
			// child, and what closes it; a child that went keeps nothing of its own but the frame
			// around it stays
			const gapBefore = (j: number): string => src.slice(parsed[j - 1].srcTo! - base, parsed[j].srcFrom! - base);
			const gapAfter = (j: number): string =>
				j + 1 < parsed.length ? gapBefore(j + 1) : m + 1 < nodes.length ? '' : src.slice(parsed[parsed.length - 1].srcTo! - base);
			const headOf = (j: number): string => {
				const lineStart = src.lastIndexOf('\n', parsed[j].srcFrom! - base - 1) + 1;
				return (lineStart === 0 ? lineHead : '') + src.slice(lineStart, parsed[j].srcFrom! - base);
			};
			// a gap for a child the file never had: the gap before some parsed child that had one, else a
			// blank line, prefixed as the container continues its lines
			const p = options.continuation ? (options.continuation(node, parsed[0].text!, headOf(0)) ?? '') : '';
			const blankGap = options.childGap?.(node, p) ?? '\n' + p.replace(/[ \t]+$/, '') + '\n' + p;
			let usualGap: string | null = null;
			for (let j = 1; j < parsed.length && usualGap === null; j++) if (parsed[j].member === 0) usualGap = gapBefore(j);
			if (usualGap === null) usualGap = blankGap;
			// prose after anything needs the blank line, or it reads on as the block before it (a lazy
			// continuation of an item, one paragraph with the one above); a nested list or environment
			// may follow on the next line, as the file's own gap before one shows
			const gapFor = (child: Node): string => (child.isTextblock && !BLANK.test(usualGap!) ? blankGap : usualGap!);
			const { origins, was } = originsOf(node, record);
			const n = node.childCount;
			// the children in groups: one construct the parse knew as several blocks (a nested list, one
			// node per item) is one group, placed and written as one. Each group stands for a parsed
			// group (kept as it was, dragged from elsewhere, or changed inside), or for none: written afresh
			type Slot = { k: number; size: number; ref: BlockOrigin | null; kept: boolean };
			const slots: Slot[] = [];
			for (let k = 0; k < n;) {
				const ref = origins[k] ?? was[k];
				// a kept child may stand anywhere (dragged); a changed one stands for a parsed child in order
				const inOrder = origins[k] === ref || !slots.some((sl) => sl.ref && sl.ref.index >= ref!.index);
				if (ref && ref.member === 0 && k + ref.size <= n && inOrder) {
					let whole = true;
					for (let t = 1; t < ref.size; t++) if ((origins[k + t] ?? was[k + t]) !== parsed[ref.index + t]) whole = false;
					if (whole) {
						let kept = true;
						for (let t = 0; t < ref.size; t++) if (origins[k + t] !== parsed[ref.index + t]) kept = false;
						slots.push({ k, size: ref.size, ref, kept });
						k += ref.size;
						continue;
					}
				}
				if (ref && ref.member !== 0) return null; // part of a group the parse wrote as one: written whole or not at all
				slots.push({ k, size: 1, ref: null, kept: false });
				k++;
			}
			text += src.slice(cursor - base, parsed[0].srcFrom! - base);
			let childPm = nodePm + 1;
			let emitted = 0;
			// the parsed child the last slot stood for, so a pair still the file's pair keeps its gap
			let prevRef: BlockOrigin | null = null;
			for (const slot of slots) {
				const group = node.content.content.slice(slot.k, slot.k + slot.size);
				let groupPm = 0;
				for (const g of group) groupPm += g.nodeSize;
				const ref = slot.ref;
				const childCtx: Ctx = {
					parent: node,
					index: slot.k,
					isLastChild: slot.k + slot.size === n,
					inTableCell: ctx.inTableCell || inCell(node)
				};
				// the gap before: the file's own between a pair still the file's, else the usual one
				const gap =
					emitted > 0 ? (ref && ref.index > 0 && prevRef === parsed[ref.index - 1] ? gapBefore(ref.index) : gapFor(group[0])) : '';
				prevRef = ref ? parsed[ref.index + slot.size - 1] : null;
				if (ref && slot.kept) {
					text += gap;
					const at = text.length;
					text += ref.text!;
					for (let t = 0; t < slot.size; t++) {
						const co = parsed[ref.index + t];
						let pmAt = childPm;
						for (let u = 0; u < t; u++) pmAt += group[u].nodeSize;
						for (const l of co.leaves) leaves.push(shiftSegment(l, pmAt - co.pmFrom, at - ref.srcFrom!));
					}
					inner.push({ pmFrom: childPm, pmTo: childPm + groupPm, srcFrom: at, srcTo: at + ref.text!.length, kind: 'sub' });
					for (const seg of nestedOf(group, ref.pmFrom)) inner.push(shiftSegment(seg, childPm - ref.pmFrom, at - ref.srcFrom!));
				} else {
					const k = slot.k;
					const child = group[0];
					if (options.spliceChild && !options.spliceChild(node, k, ref?.node ?? null)) return null;
					// what stood on the child's line before it: a marker, a quote prefix, indentation; for a
					// fresh child, what the nearest parsed child had
					// a fresh child continues its lines as the nearest parsed child did
					const guide = ref ?? parsed[Math.min(parsed.length - 1, Math.max(0, lastIndexBefore(slots, slot) + 1))];
					const head = headOf(guide.index);
					const prefix = options.continuation ? (options.continuation(node, guide.text!, head) ?? '') : '';
					const nested = ref
						? slot.size === 1
							? (frameSplice(child, ref, childCtx, head) ??
								leafSplice(child, ref, childCtx, prefix) ??
								segmentSplice(child, ref, childCtx, prefix))
							: spliceMembers(group, parsed.slice(ref.index, ref.index + slot.size), childCtx, head)
						: null;
					if (!nested && slot.size > 1) return null;
					const part = nested ? nested.text : serializeNode(child, childCtx);
					const lead = nested ? 0 : WS.exec(part)![0].length;
					let core = nested ? part : part.slice(lead, part.length - WS_END.exec(part)![0].length);
					// a child that writes nothing (an emptied paragraph) takes no gap of its own either,
					// unless the file's bytes around it are its frame (a caption's braces), which stays
					if (core.trim() === '') {
						const before = ref && ref.index > 0 ? gapBefore(ref.index) : '';
						const after = ref ? gapAfter(ref.index + slot.size - 1) : '';
						if (!ref || (/^\s*$/.test(before) && /^\s*$/.test(after))) continue;
					}
					text += gap;
					const at = text.length;
					const partLeaves = nested ? nested.leaves : (options.mapLeaves?.(child, childCtx, part) ?? []);
					const prefixing = !nested && prefix !== '' && core.includes('\n');
					if (prefixing) core = core.replace(/\n(?!\n|$)/g, '\n' + prefix);
					// the gap after the child is what separates it from the next; a paragraph ending rule
					// of the dialect (a \par before a blank line) applies as at the top level
					const after = ref ? gapAfter(ref.index + slot.size - 1) : usualGap;
					const last = slot === slots[slots.length - 1] && m === nodes.length - 1;
					if (options.beforeBreak && (last || BLANK.test(after))) {
						const at2 = slots.indexOf(slot) + 1;
						const nextSlot = at2 < slots.length ? slots[at2] : null;
						const next: Neighbour = nextSlot
							? { node: node.child(nextSlot.k), origin: nextSlot.kept ? nextSlot.ref : null, was: nextSlot.ref }
							: { node: group[slot.size - 1], origin: null, was: null };
						core = options.beforeBreak(core, { node: group[slot.size - 1], origin: null, was: ref }, next);
					}
					text += core;
					inner.push({ pmFrom: childPm, pmTo: childPm + groupPm, srcFrom: at, srcTo: at + core.length, kind: 'sub' });
					const leavesFrom = leaves.length;
					const prefixed = (off: number): number => {
						let moved = off;
						if (prefixing)
							for (let i = lead; i < off; i++) if (part[i] === '\n' && i + 1 < part.length && part[i + 1] !== '\n') moved += prefix.length;
						return moved;
					};
					for (const sg of partLeaves) {
						if (sg.srcFrom < lead || sg.srcTo > lead + core.length) continue;
						leaves.push({
							pmFrom: childPm + sg.pmFrom,
							pmTo: childPm + sg.pmTo,
							srcFrom: at + prefixed(sg.srcFrom) - lead,
							srcTo: at + prefixed(sg.srcTo) - lead,
							kind: sg.kind
						});
					}
					if (nested) for (const sg of nested.inner) inner.push(shiftSegment(sg, childPm, at));
					else for (const sg of derivedInner(child, childPm, leaves.slice(leavesFrom), at)) inner.push(sg);
				}
				childPm += groupPm;
				emitted++;
			}
			cursor = parsed[parsed.length - 1].srcTo!;
			nodePm += node.nodeSize;
		}
		text += src.slice(cursor - base);
		return { text, leaves, inner };
	}

	/** the parse index of the last kept or changed slot before `slot`, or -1 */
	function lastIndexBefore(slots: { ref: BlockOrigin | null }[], slot: { ref: BlockOrigin | null }): number {
		let last = -1;
		for (const s of slots) {
			if (s === slot) break;
			if (s.ref) last = s.ref.index;
		}
		return last;
	}

	/** the range of every block below the top level inside `nodes`, as the parse placed them, in the
	 *  parse's own coordinates; `pmStart` is where the first node stood */
	function nestedOf(nodes: Node[], pmStart: number): Segment[] {
		const out: Segment[] = [];
		let at = pmStart;
		for (const node of nodes) {
			const walk = (container: Node, pos: number) => {
				const rec = containerOriginsOf(container);
				if (rec) {
					for (let k = 0; k < rec.origins.length; k++) {
						const o = rec.origins[k];
						if (o.member !== 0 || o.srcFrom === undefined) continue;
						const end = rec.origins[Math.min(k + o.size, rec.origins.length) - 1];
						out.push({ pmFrom: o.pmFrom, pmTo: end.pmTo, srcFrom: o.srcFrom, srcTo: o.srcTo!, kind: 'sub' });
					}
				}
				let childPos = pos + 1;
				container.forEach((child) => {
					if (isContainer(child)) walk(child, childPos);
					childPos += child.nodeSize;
				});
			};
			if (isContainer(node)) walk(node, at);
			at += node.nodeSize;
		}
		return out;
	}

	/** the range of every block below the top level inside `node`, told by the runs that landed in
	 *  it: from its first run to its last; one with no runs stands where the block before it ended,
	 *  or at its container's start. `runs` are in the same coordinates as `pmStart` and `srcStart` */
	function derivedInner(node: Node, pmStart: number, runs: Segment[], srcStart: number): Segment[] {
		const out: Segment[] = [];
		const sorted = [...runs].sort((a, b) => a.pmFrom - b.pmFrom);
		const walk = (container: Node, contentPos: number, containerSrc: number) => {
			let pos = contentPos;
			let prevEnd = containerSrc;
			container.forEach((child) => {
				const from = pos;
				const to = pos + child.nodeSize;
				let lo = Infinity;
				let hi = -Infinity;
				for (const r of sorted) {
					if (r.pmFrom >= to) break;
					if (r.pmFrom >= from && r.pmTo <= to) {
						lo = Math.min(lo, r.srcFrom);
						hi = Math.max(hi, r.srcTo);
					}
				}
				const seg: Segment =
					lo <= hi
						? { pmFrom: from, pmTo: to, srcFrom: lo, srcTo: hi, kind: 'sub' }
						: { pmFrom: from, pmTo: to, srcFrom: prevEnd, srcTo: prevEnd, kind: 'sub' };
				out.push(seg);
				prevEnd = seg.srcTo;
				if (isContainer(child)) walk(child, from + 1, seg.srcFrom);
				pos = to;
			});
		};
		if (isContainer(node)) walk(node, pmStart + 1, srcStart);
		return out;
	}

	type LeafPair = { now: Node; then: Node; parent: Node; nowPm: number; thenPm: number };

	/** the text leaves of `now` beside those of `then`, when the two trees differ in leaf text alone */
	function pairLeaves(now: Node, then: Node, parent: Node, nowPm: number, thenPm: number, out: LeafPair[]): boolean {
		if (!now.sameMarkup(then)) return false;
		if (now.isText) {
			out.push({ now, then, parent, nowPm, thenPm });
			return true;
		}
		if (now.childCount !== then.childCount) return false;
		let a = nowPm + 1;
		let b = thenPm + 1;
		for (let k = 0; k < now.childCount; k++) {
			if (!pairLeaves(now.child(k), then.child(k), now, a, b, out)) return false;
			a += now.child(k).nodeSize;
			b += then.child(k).nodeSize;
		}
		return true;
	}

	/**
	 * A block whose shape the parse still knows, written out as the bytes it came from with only
	 * its changed text leaves written afresh in place: the wrapping, the markup between the
	 * leaves, and every untouched leaf stay the file's own. A changed leaf can be replaced only
	 * where its runs cover all its characters in file order; an accent or a ligature in it, or a
	 * leaf the parse could not place, leaves the block to the dialect's handler. Null when the
	 * trees differ in anything but leaf text. The runs are relative to the block node and its text.
	 */
	function leafSplice(node: Node, origin: BlockOrigin, ctx: Ctx, prefix = ''): Spliced | null {
		if (!options.leafBytes || !origin.parse.verbatim || origin.text === undefined || origin.size !== 1) return null;
		if (node === origin.node) return null;
		const pairs: LeafPair[] = [];
		if (!pairLeaves(node, origin.node, node, 0, 0, pairs)) return null;
		const base = origin.srcFrom!;
		const runsOf = (p: LeafPair): Segment[] => {
			const from = origin.pmFrom + p.thenPm;
			const to = from + p.then.nodeSize;
			const out: Segment[] = [];
			for (const s of origin.leaves) if (s.pmFrom >= from && s.pmTo <= to) out.push(s);
			return out;
		};
		type Change = {
			gone: string;
			srcFrom: number;
			srcTo: number;
			bytes: string;
			pair: LeafPair;
			exact: boolean;
			cut: number;
			cutEnd: number;
			runs: Segment[];
		};
		const changes: Change[] = [];
		for (const p of pairs) {
			if (p.now.text === p.then.text) continue;
			const runs = runsOf(p);
			if (runs.length === 0) return null;
			// every character placed, in file order, nothing of another leaf between
			let covered = 0;
			for (let k = 0; k < runs.length; k++) {
				const s = runs[k];
				if (s.pmFrom - (origin.pmFrom + p.thenPm) !== covered) return null;
				if (k > 0 && s.srcFrom < runs[k - 1].srcTo) return null;
				covered = s.pmTo - (origin.pmFrom + p.thenPm);
			}
			if (covered !== p.then.nodeSize) return null;
			// the characters unchanged at either end of the leaf keep their bytes (a hard wrap among
			// them); only what lies between is written afresh
			const x = p.then.text!;
			const y = p.now.text!;
			let cut = 0;
			while (cut < x.length && cut < y.length && x[cut] === y[cut]) cut++;
			let cutEnd = 0;
			while (cutEnd < Math.min(x.length, y.length) - cut && x[x.length - 1 - cutEnd] === y[y.length - 1 - cutEnd]) cutEnd++;
			const leafPm = origin.pmFrom + p.thenPm;
			const byteAt = (c: number): number | null => {
				for (const r of runs)
					if (r.kind === 'text' && leafPm + c >= r.pmFrom && leafPm + c <= r.pmTo) return r.srcFrom + (leafPm + c - r.pmFrom);
				return null;
			};
			// a cut inside a stand-in (an accent, a ligature) moves out to where the bytes are the characters
			while (cut > 0 && byteAt(cut) === null) cut--;
			while (cutEnd > 0 && byteAt(x.length - cutEnd) === null) cutEnd--;
			// the dialect's markup for a character (an escape) stands before it and no run covers it, so
			// a boundary at where the character's own bytes begin moves back over it, to where the
			// character before it ends
			const charEdge = (b: number): number => {
				let end = -1;
				for (const r of runs) {
					if (r.srcFrom < b && r.srcTo >= b) return b;
					if (r.srcTo <= b && r.srcTo > end) end = r.srcTo;
				}
				return end < 0 ? b : end;
			};
			// at the leaf's own start there is no character before it, and the markup of the block and
			// the escape of the first character cannot be told apart: the block is written afresh
			if (cut === 0 && x.length > 0) {
				const head = options.leafBytes(
					p.then.type.schema.text(x[0], p.then.marks),
					p.parent,
					p.parent === node && p.nowPm === 1,
					node,
					ctx
				);
				if (head === null || head !== x[0]) return null;
			}
			const from = cut > 0 ? charEdge(byteAt(cut)!) : runs[0].srcFrom;
			const to = cutEnd > 0 ? charEdge(byteAt(x.length - cutEnd)!) : runs[runs.length - 1].srcTo;
			const middle = y.slice(cut, y.length - cutEnd);
			let bytes =
				middle === ''
					? ''
					: options.leafBytes(
							p.now.type.schema.text(middle, p.now.marks),
							p.parent,
							p.parent === node && p.nowPm === 1 && cut === 0,
							node,
							ctx
						);
			if (bytes === null) return null;
			// fresh bytes that would fuse with the bytes kept beside them are kept apart
			const gone = origin.text.slice(from - base, to - base);
			if (options.keepApart) {
				const apart = options.keepApart(bytes, origin.text.slice(to - base), origin.text.slice(0, from - base), gone);
				if (apart === null) return null;
				bytes = apart;
			}
			if (prefix) bytes = bytes.replace(/\n/g, '\n' + prefix);
			changes.push({ srcFrom: from, srcTo: to, bytes, gone, pair: p, exact: bytes === middle, cut, cutEnd, runs });
		}
		if (changes.length === 0) return null;
		changes.sort((a, b) => a.srcFrom - b.srcFrom);
		for (let k = 1; k < changes.length; k++) if (changes[k].srcFrom < changes[k - 1].srcTo) return null;
		// the text: the file's bytes with each changed leaf's range replaced
		let text = '';
		let cursor = base;
		const shifted = (at: number): number => {
			let d = 0;
			for (const c of changes) {
				if (c.srcTo <= at) d += c.bytes.length - (c.srcTo - c.srcFrom);
				else break;
			}
			return at + d;
		};
		for (const c of changes) {
			text += origin.text.slice(cursor - base, c.srcFrom - base) + c.bytes;
			cursor = c.srcTo;
		}
		text += origin.text.slice(cursor - base);
		// each change was kept apart from the file's bytes beside it; where another change moved
		// those, the seam is read again against what is written now
		if (options.keepApart && changes.length > 1) {
			for (const c of changes) {
				const at = shifted(c.srcFrom) - base;
				if (options.keepApart(c.bytes, text.slice(at + c.bytes.length), text.slice(0, at), c.gone) !== c.bytes) return null;
			}
		}
		// the runs: an untouched leaf's, moved to where its bytes and its node now are; a changed
		// leaf's is its new bytes whole
		const leaves: Segment[] = [];
		const changed = new Set(changes.map((c) => c.pair));
		for (const p of pairs) {
			if (changed.has(p)) continue;
			for (const s of runsOf(p)) {
				const pmFrom = p.nowPm + (s.pmFrom - (origin.pmFrom + p.thenPm));
				leaves.push({
					pmFrom,
					pmTo: pmFrom + (s.pmTo - s.pmFrom),
					srcFrom: shifted(s.srcFrom) - base,
					srcTo: shifted(s.srcTo) - base,
					kind: s.kind
				});
			}
		}
		// a changed leaf's: its kept head as it was, the fresh bytes whole, its kept tail moved by
		// the change; `d` is what the changes before this one moved the bytes by
		let d = 0;
		for (const c of changes) {
			const thenPm = origin.pmFrom + c.pair.thenPm;
			const nowPm = c.pair.nowPm;
			const x = c.pair.then.text!;
			const y = c.pair.now.text!;
			const headEnd = thenPm + c.cut;
			const tailStart = thenPm + x.length - c.cutEnd;
			const delta = c.bytes.length - (c.srcTo - c.srcFrom);
			for (const r of c.runs) {
				if (r.pmTo <= headEnd)
					leaves.push({
						pmFrom: r.pmFrom - thenPm + nowPm,
						pmTo: r.pmTo - thenPm + nowPm,
						srcFrom: r.srcFrom + d - base,
						srcTo: r.srcTo + d - base,
						kind: r.kind
					});
				else if (r.pmFrom < headEnd)
					leaves.push({
						pmFrom: r.pmFrom - thenPm + nowPm,
						pmTo: c.cut + nowPm,
						srcFrom: r.srcFrom + d - base,
						srcTo: c.srcFrom + d - base,
						kind: r.kind
					});
			}
			if (c.bytes.length > 0 && y.length - c.cutEnd > c.cut) {
				leaves.push({
					pmFrom: nowPm + c.cut,
					pmTo: nowPm + y.length - c.cutEnd,
					srcFrom: c.srcFrom + d - base,
					srcTo: c.srcFrom + d + c.bytes.length - base,
					kind: c.exact ? 'text' : 'sub'
				});
			}
			const shift = y.length - x.length;
			for (const r of c.runs) {
				if (r.pmFrom >= tailStart)
					leaves.push({
						pmFrom: r.pmFrom - thenPm + nowPm + shift,
						pmTo: r.pmTo - thenPm + nowPm + shift,
						srcFrom: r.srcFrom + d + delta - base,
						srcTo: r.srcTo + d + delta - base,
						kind: r.kind
					});
				else if (r.pmTo > tailStart)
					leaves.push({
						pmFrom: x.length - c.cutEnd + nowPm + shift,
						pmTo: r.pmTo - thenPm + nowPm + shift,
						srcFrom: c.srcTo + d + delta - base,
						srcTo: r.srcTo + d + delta - base,
						kind: r.kind
					});
			}
			d += delta;
		}
		leaves.sort((a, b) => a.pmFrom - b.pmFrom);
		return { text, leaves, inner: [] };
	}

	/** the runs of the parsed leaf `then` at `thenPm` (relative to the parsed block), in order */
	function leafRuns(origin: BlockOrigin, then: Node, thenPm: number): Segment[] {
		const from = origin.pmFrom + thenPm;
		const to = from + then.nodeSize;
		const out: Segment[] = [];
		for (const s of origin.leaves) if (s.pmFrom >= from && s.pmTo <= to) out.push(s);
		return out;
	}

	/**
	 * A textblock whose inline content changed in more than leaf text (a mark toggled, a formula
	 * put in, a leaf split), written out as the bytes it came from with only the changed stretch
	 * written afresh: the unchanged inline nodes at either end keep their bytes, so do the
	 * unchanged characters at either end of a plain leaf the change reaches into, and the stretch
	 * between is rendered by the dialect and put in their place. The stretch is widened until it
	 * starts after and ends before plain text, so no mark's wrapper and no atom's delimiter is cut
	 * in half. Null when the block's bytes hold markup outside its leaves at an edge the stretch
	 * reaches, or the dialect cannot write the stretch on its own.
	 */
	function segmentSplice(node: Node, origin: BlockOrigin, ctx: Ctx, prefix = ''): Spliced | null {
		if (!options.inlineBytes || !origin.parse.verbatim || origin.text === undefined || origin.size !== 1) return null;
		const then = origin.node;
		if (!node.isTextblock || !then.isTextblock || !node.sameMarkup(then) || node === then) return null;
		const a: Node[] = [];
		const b: Node[] = [];
		then.forEach((c) => a.push(c));
		node.forEach((c) => b.push(c));
		// only a parsed leaf says where the inline content sits in the bytes: a block that had none
		// (a figure with no caption) may be nothing but frame
		if (a.length === 0) return null;
		const plain = (n: Node | undefined) => !!n && n.isText && n.marks.length === 0;
		let p = 0;
		while (p < a.length && p < b.length && a[p].eq(b[p])) p++;
		let s = 0;
		while (s < a.length - p && s < b.length - p && a[a.length - 1 - s].eq(b[b.length - 1 - s])) s++;
		// plain text bounds the stretch on either side; anything marked or delimited is taken in
		while (p > 0 && !plain(a[p - 1])) p--;
		while (s > 0 && !plain(a[a.length - s])) s--;
		// a plain leaf the change reaches into keeps its unchanged characters at the edge, back to
		// the word boundary before the change: a mark's delimiter or a line break written mid-word
		// reads differently, and a stretch of nothing but a break is not written at all. The
		// boundary may lie in the plain leaf before, which is then taken in up to it
		let cut = 0;
		if (p < a.length - s && p < b.length - s && plain(a[p]) && plain(b[p])) {
			const x = a[p].text!;
			const y = b[p].text!;
			while (cut < x.length && cut < y.length && x[cut] === y[cut]) cut++;
		}
		const ws = (ch: string) => /\s/.test(ch);
		// the cut moved back to the start of the word it is in; `words` more words back when the
		// stretch would otherwise begin with a node that is not text (a break written alone reads
		// as nothing)
		const backToWord = (words: number) => {
			for (;;) {
				if (cut > 0) {
					const x = a[p].text!;
					let w = cut;
					while (w > 0 && !ws(x[w - 1])) w--;
					while (words > 0 && w > 0) {
						while (w > 0 && ws(x[w - 1])) w--;
						while (w > 0 && !ws(x[w - 1])) w--;
						words--;
					}
					cut = w;
					if (cut > 0 || words === 0) break;
				}
				if (p === 0 || !plain(a[p - 1])) break;
				if (words === 0 && ws(a[p - 1].text!.slice(-1))) break;
				p--;
				cut = a[p].text!.length;
			}
		};
		backToWord(0);
		let ia = a.length - s - 1;
		let ib = b.length - s - 1;
		let cutEnd = 0;
		const endCut = () => {
			cutEnd = 0;
			if (ia >= p && ib >= p && plain(a[ia]) && plain(b[ib])) {
				const x = a[ia].text!;
				const y = b[ib].text!;
				const room = Math.min(x.length - (ia === p ? cut : 0), y.length - (ib === p ? cut : 0));
				while (cutEnd < room && x[x.length - 1 - cutEnd] === y[y.length - 1 - cutEnd]) cutEnd++;
			}
		};
		endCut();
		// the kept tail moved on to the start of the word it is in; `words` more words on when the
		// stretch would otherwise end with a node that is not text
		const onToWord = (words: number) => {
			for (;;) {
				if (cutEnd > 0) {
					const x = a[ia].text!;
					let w = x.length - cutEnd;
					while (w < x.length && !ws(x[w])) w++;
					while (words > 0 && w < x.length) {
						while (w < x.length && ws(x[w])) w++;
						while (w < x.length && !ws(x[w])) w++;
						words--;
					}
					cutEnd = x.length - w;
					if (cutEnd > 0 || words === 0) break;
				}
				const next = a[a.length - s];
				if (s === 0 || !plain(next)) break;
				if (words === 0 && ws(next.text![0])) break;
				s--;
				ia = a.length - s - 1;
				ib = b.length - s - 1;
				cutEnd = next.text!.length;
			}
		};
		onToWord(0);
		// a stretch beginning or ending in a node that is not text takes a word in on that side
		const firstNode = b[p] && b[p].isText && cut >= b[p].text!.length ? b[p + 1] : b[p];
		if (firstNode && !firstNode.isText && (cut > 0 || p > 0)) {
			backToWord(1);
			endCut();
			onToWord(0);
		}
		const lastNode = b[ib] && b[ib].isText && cutEnd >= b[ib].text!.length ? b[ib - 1] : b[ib];
		if (lastNode && !lastNode.isText && (cutEnd > 0 || s > 0)) onToWord(1);
		// the word moves can leave an edge of the stretch at a marked leaf, whose runs hold none of
		// its delimiters: cutting there would leave half a code span or an emphasis in the kept bytes
		while (cut === 0 && p > 0 && !plain(a[p - 1])) p--;
		while (cutEnd === 0 && s > 0 && !plain(a[a.length - s])) s--;
		ia = a.length - s - 1;
		ib = b.length - s - 1;
		const base = origin.srcFrom!;
		const pmOf = (nodes: Node[], k: number): number => {
			let at = 1;
			for (let i = 0; i < k; i++) at += nodes[i].nodeSize;
			return at;
		};
		/** the file offset of character `c` of the parsed leaf `a[k]`, when a run of its own bytes holds it */
		const byteAt = (k: number, c: number): number | null => {
			const leafPm = origin.pmFrom + pmOf(a, k);
			for (const r of leafRuns(origin, a[k], pmOf(a, k))) {
				if (r.kind === 'text' && leafPm + c >= r.pmFrom && leafPm + c <= r.pmTo) return r.srcFrom + (leafPm + c - r.pmFrom);
			}
			return null;
		};
		/** a boundary at where a character's own bytes begin moves back over the dialect's markup for
		 *  it (an escape), which no run covers and which belongs with the character */
		const charEdge = (k: number, b: number | null): number | null => {
			if (b === null) return null;
			let end = -1;
			for (const r of leafRuns(origin, a[k], pmOf(a, k))) {
				if (r.srcFrom < b && r.srcTo >= b) return b;
				if (r.srcTo <= b && r.srcTo > end) end = r.srcTo;
			}
			return end < 0 ? b : end;
		};
		// a leaf whose first character the dialect writes as more than itself carries that markup
		// before its own bytes, where no run reaches: the kept bytes cannot begin there
		const escapedHead = (k: number): boolean => {
			const leaf = a[k];
			if (!leaf || !leaf.isText || leaf.text!.length === 0 || !options.leafBytes) return false;
			const head = options.leafBytes(leaf.type.schema.text(leaf.text![0], leaf.marks), node, false, node);
			return head !== leaf.text![0];
		};
		// where the kept bytes end before the stretch and begin after it
		let start: number | null;
		if (cut > 0) start = charEdge(p, byteAt(p, cut));
		else if (p > 0) start = byteAt(p - 1, a[p - 1].nodeSize);
		else {
			const first = a.length > 0 ? leafRuns(origin, a[0], 1)[0] : undefined;
			start = a.length === 0 || (first && first.srcFrom === base) ? base : null;
		}
		let end: number | null;
		if (cutEnd > 0) end = charEdge(ia, byteAt(ia, a[ia].text!.length - cutEnd));
		else if (s > 0) end = escapedHead(a.length - s) ? null : byteAt(a.length - s, 0);
		else {
			const runs = a.length > 0 ? leafRuns(origin, a[a.length - 1], pmOf(a, a.length - 1)) : [];
			const last = runs[runs.length - 1];
			end = a.length === 0 || (last && last.srcTo === origin.srcTo) ? origin.srcTo! : null;
		}
		if (start === null || end === null || end < start) return null;
		// the stretch: the changed nodes, the remainders of the plain leaves at its edges first and last
		const stretch: Node[] = [];
		for (let k = p; k <= ib; k++) {
			let n = b[k];
			if (n.isText) {
				const from = k === p ? cut : 0;
				const to = n.text!.length - (k === ib ? cutEnd : 0);
				if (from >= to) continue;
				if (from > 0 || to < n.text!.length) n = n.type.schema.text(n.text!.slice(from, to), n.marks);
			}
			stretch.push(n);
		}
		const atStart = p === 0 && cut === 0;
		let bytes = stretch.length > 0 ? options.inlineBytes(node, stretch, atStart, ctx) : '';
		if (bytes === null) return null;
		// fresh bytes that would fuse with the bytes kept beside them are kept apart
		if (options.keepApart) {
			const apart = options.keepApart(
				bytes,
				origin.text.slice(end - base),
				origin.text.slice(0, start - base),
				origin.text.slice(start - base, end - base)
			);
			if (apart === null) return null;
			bytes = apart;
		}
		// the fresh bytes' line ends continue the block as its container has them; the runs the
		// shadow finds in the bytes as written move past the prefixes put in
		const raw = bytes;
		if (prefix) bytes = raw.replace(/\n/g, '\n' + prefix);
		const prefixed = (off: number): number => {
			let moved = off;
			if (prefix) for (let i = 0; i < off && i < raw.length; i++) if (raw[i] === '\n') moved += prefix.length;
			return moved;
		};
		const text = origin.text.slice(0, start - base) + bytes + origin.text.slice(end - base);
		const delta = bytes.length - (end - start);
		const leaves: Segment[] = [];
		const keep = (r: Segment, pmShift: number, srcShift: number) =>
			leaves.push({
				pmFrom: r.pmFrom - origin.pmFrom + pmShift,
				pmTo: r.pmTo - origin.pmFrom + pmShift,
				srcFrom: r.srcFrom - base + srcShift,
				srcTo: r.srcTo - base + srcShift,
				kind: r.kind
			});
		for (let k = 0; k < p; k++) for (const r of leafRuns(origin, a[k], pmOf(a, k))) keep(r, 0, 0);
		if (cut > 0) {
			const leafPm = origin.pmFrom + pmOf(a, p);
			for (const r of leafRuns(origin, a[p], pmOf(a, p))) {
				if (r.pmTo <= leafPm + cut) keep(r, 0, 0);
				else if (r.pmFrom < leafPm + cut && r.kind === 'text')
					keep({ ...r, pmTo: leafPm + cut, srcTo: r.srcFrom + (leafPm + cut - r.pmFrom) }, 0, 0);
			}
		}
		const stretchPm = pmOf(b, p) + cut;
		if (stretch.length > 0) {
			for (const r of options.mapInlineLeaves?.(node, stretch, raw, atStart, ctx) ?? []) {
				leaves.push({
					pmFrom: stretchPm - 1 + r.pmFrom,
					pmTo: stretchPm - 1 + r.pmTo,
					srcFrom: start - base + prefixed(r.srcFrom),
					srcTo: start - base + prefixed(r.srcTo),
					kind: r.kind
				});
			}
		}
		if (cutEnd > 0) {
			const leafPm = origin.pmFrom + pmOf(a, ia);
			const from = leafPm + a[ia].text!.length - cutEnd;
			const shift = pmOf(b, ib) + b[ib].text!.length - (pmOf(a, ia) + a[ia].text!.length);
			for (const r of leafRuns(origin, a[ia], pmOf(a, ia))) {
				if (r.pmFrom >= from) keep(r, shift, delta);
				else if (r.pmTo > from && r.kind === 'text') keep({ ...r, pmFrom: from, srcFrom: r.srcFrom + (from - r.pmFrom) }, shift, delta);
			}
		}
		for (let k = a.length - s; k < a.length; k++) {
			const shift = pmOf(b, b.length - (a.length - k)) - pmOf(a, k);
			for (const r of leafRuns(origin, a[k], pmOf(a, k))) keep(r, shift, delta);
		}
		leaves.sort((x, y) => x.pmFrom - y.pmFrom);
		return { text, leaves, inner: [] };
	}

	/** one container the parse still knows, against what it knew it as */
	function frameSplice(node: Node, origin: BlockOrigin, ctx: Ctx, lineHead = ''): Spliced | null {
		if (origin.size !== 1) return null;
		return spliceMembers([node], [origin], ctx, lineHead);
	}

	/**
	 * The whole construct a changed block at `i` belongs to, when the parse knew it as several
	 * blocks (an itemize is one list node per item), each standing for the member the parse had
	 * there: its bytes with only the changed items' blocks rendered afresh, or null
	 */
	function constructSplice(doc: Node, i: number, neighbours: Neighbour[]): (Spliced & { count: number }) | null {
		// the run starts at the construct's first slot, whichever member stands there now
		const m0 = neighbours[i].origin ?? neighbours[i].was;
		const w = m0 ? m0.parse.origins[m0.index - m0.member] : null;
		if (!w || w.size < 2 || i + w.size > neighbours.length) return null;
		const inConstruct = (o: BlockOrigin | null) => !!o && o.parse === w.parse && o.index >= w.index && o.index < w.index + w.size;
		if (i > 0 && inConstruct(neighbours[i - 1].origin ?? neighbours[i - 1].was)) return null;
		const nodes: Node[] = [];
		const slots: BlockOrigin[] = [];
		const owns: BlockOrigin[] = [];
		let permuted = false;
		for (let k = 0; k < w.size; k++) {
			const nb = neighbours[i + k];
			const m = nb.origin ?? nb.was;
			const slot = w.parse.origins[w.index + k];
			if (!m || !slot || slot.member !== k || !inConstruct(m) || m.member !== m.index - w.index) return null;
			nodes.push(nb.node);
			slots.push(slot);
			owns.push(m);
			if (m !== slot) permuted = true;
		}
		// every member once, in some order
		if (permuted && new Set(owns).size !== w.size) return null;
		const spliced = spliceMembers(nodes, slots, ctxFor(doc, i, doc.childCount), '', permuted ? owns : null);
		return spliced ? { ...spliced, count: w.size } : null;
	}

	// the leaf runs of a regenerated block, told once per cache entry
	function leavesOf(doc: Node, i: number, n: number, entry: Entry): Segment[] {
		if (entry.leaves === undefined)
			entry.leaves = options.mapLeaves ? options.mapLeaves(doc.child(i), ctxFor(doc, i, n), entry.text) : null;
		return entry.leaves ?? [];
	}

	/**
	 * How many children starting at `i` may be emitted verbatim: 1 for a plain block the parse
	 * still knows; the whole construct for a multi-block source unit (one itemize is N list
	 * nodes), but only when EVERY member is present, in pristine order and unchanged, so a
	 * deleted/edited item can never be resurrected. 0 means regenerate.
	 */
	function verbatimRun(origins: (BlockOrigin | null)[], i: number): number {
		const o = origins[i];
		if (!o || !o.parse.verbatim || o.text === undefined) return 0;
		if (o.size === 1) return 1;
		if (o.member !== 0 || i + o.size > origins.length) return 0;
		for (let k = 1; k < o.size; k++) {
			const m = origins[i + k];
			if (!m || m.parse !== o.parse || m.index !== o.index + k || m.member !== k) return 0;
		}
		return o.size;
	}

	/**
	 * A container's children as the dialect rendered them, with every child the parse still knows
	 * written out as its bytes instead: the part's own leading and trailing whitespace is kept
	 * around the bytes, so the dialect's separation between blocks stays what it was. Contiguous
	 * pristine children re-join on the bytes the file had between them.
	 */
	function verbatimParts(parent: Node, parts: string[], opts: PartsOptions = {}): string[] {
		const n = parent.childCount;
		if (n === 0 || parts.length !== n) return parts;
		const { origins, was } = originsOf(parent);
		if (!origins.some(Boolean) && !was.some(Boolean)) return parts;
		const out = parts.slice();
		const cellCtx = (i: number): Ctx => ({ parent, index: i, isLastChild: i === n - 1, inTableCell: inCell(parent) });
		// the part the last verbatim run went into, the trailing whitespace it ends on, and its origin
		let joinInto = -1;
		let joinTrail = '';
		let prev: BlockOrigin | null = null;
		let i = 0;
		while (i < n) {
			const run = opts.keep?.(i) ? 0 : verbatimRun(origins, i);
			if (run === 0) {
				// a changed container child keeps its frame the same way
				const spliced =
					!opts.keep?.(i) && was[i]
						? (frameSplice(parent.child(i), was[i]!, cellCtx(i)) ??
							leafSplice(parent.child(i), was[i]!, cellCtx(i)) ??
							segmentSplice(parent.child(i), was[i]!, cellCtx(i)))
						: null;
				if (spliced) {
					out[i] = /^[ \t\r\n]*/.exec(parts[i])![0] + spliced.text + /[ \t\r\n]*$/.exec(parts[i])![0];
				}
				if (parts[i] !== '') prev = null;
				i++;
				continue;
			}
			const origin = origins[i]!;
			const node = parent.child(i);
			const bytes = options.shadowChunk ? options.shadowChunk(node, origin.text!) : origin.text!;
			const lead = /^[ \t\r\n]*/.exec(parts[i])![0];
			const trail = /[ \t\r\n]*$/.exec(parts[i + run - 1])![0];
			if (opts.join !== false && prev && joinInto >= 0 && follows(prev, origin) && origin.pre != null) {
				out[joinInto] = out[joinInto].slice(0, out[joinInto].length - joinTrail.length) + origin.pre + bytes + trail;
				for (let k = 0; k < run; k++) out[i + k] = '';
			} else {
				out[i] = lead + bytes + trail;
				for (let k = 1; k < run; k++) out[i + k] = '';
				joinInto = i;
			}
			joinTrail = trail;
			prev = origins[i + run - 1];
			i += run;
		}
		return out;
	}

	function serializeDocChildrenDetailed(doc: Node, parse?: ParseOrigins | null): DocSerializeResult {
		const n = doc.childCount;
		// the parse the document answers to; one handed in by the caller only stands in for a
		// document that remembers none
		const { parse: known, origins, was } = originsOf(doc, parseOf(doc) ?? parse ?? null);
		const neighbours: Neighbour[] = [];
		for (let i = 0; i < n; i++) neighbours.push({ node: doc.child(i), origin: origins[i], was: was[i] });
		const pmStarts: number[] = [];
		let pm = 0;
		for (let i = 0; i < n; i++) {
			pmStarts.push(pm);
			pm += doc.child(i).nodeSize;
		}
		// a block is rendered only once something asks for its text: a block written as its bytes
		// never is, so a document the parse still knows costs no rendering at all
		const entries: (Entry | undefined)[] = new Array<Entry | undefined>(n);
		const entryAt = (i: number): Entry => (entries[i] ??= serializeTopBlock(doc, i, n, neighbours));
		const partAt = (i: number): string => entryAt(i).text;
		// where a block's runs landed is remembered on the block, rendered or not
		const placedEntry = (i: number): Entry => {
			if (entries[i]) return entries[i]!;
			const node = doc.child(i);
			let entry = blockCache.get(node);
			if (!entry) {
				entry = { key: '', text: '' };
				blockCache.set(node, entry);
			}
			return entry;
		};
		// the output as the pieces it was written in, joined once at the end: a block's bytes, a
		// gap. Slicing and re-joining one string that grows with the document, block after
		// block, is what made writing a large document afresh quadratic
		const pieces: string[] = [];
		let outLen = 0;
		function push(s: string) {
			if (s === '') return;
			pieces.push(s);
			outLen += s.length;
		}
		// where the last block's own bytes end: a separator never cuts back into them
		let ownEnd = 0;
		function truncate(len: number) {
			ownEnd = Math.min(ownEnd, len);
			while (outLen > len && pieces.length > 0) {
				const last = pieces[pieces.length - 1];
				const over = outLen - len;
				if (over >= last.length) {
					pieces.pop();
					outLen -= last.length;
				} else {
					pieces[pieces.length - 1] = last.slice(0, last.length - over);
					outLen -= over;
				}
			}
		}
		/** the last `k` characters written */
		function tailText(k: number): string {
			let s = '';
			for (let p = pieces.length - 1; p >= 0 && s.length < k; p--) s = pieces[p].slice(-(k - s.length)) + s;
			return s;
		}
		const leaves: Segment[] = [];
		const blocks: Segment[] = [];
		// leaves land block by block: leafFrom[b] is where block segment b's leaves begin
		const leafFrom: number[] = [];
		const inner: Segment[] = [];
		const innerFrom: number[] = [];
		function cut(s: Segment, len: number): Segment {
			if (s.srcTo <= len) return s;
			const pmTo = s.kind === 'text' ? s.pmFrom + Math.max(0, len - s.srcFrom) : s.pmTo;
			return { pmFrom: s.pmFrom, pmTo, srcFrom: Math.min(s.srcFrom, len), srcTo: len, kind: s.kind };
		}
		// `out` is cut back before a separator goes on: nothing recorded may point past the cut, and a
		// text run loses as many characters as bytes. Blocks land in output order, so only the last
		// ones can reach past a cut
		function cutTo(len: number) {
			if (len >= outLen) return;
			for (let b = blocks.length - 1; b >= 0 && blocks[b].srcTo > len; b--) {
				blocks[b] = cut(blocks[b], len);
				const end = b + 1 < blocks.length ? leafFrom[b + 1] : leaves.length;
				for (let k = leafFrom[b]; k < end; k++) leaves[k] = cut(leaves[k], len);
				const innerEnd = b + 1 < blocks.length ? innerFrom[b + 1] : inner.length;
				for (let k = innerFrom[b]; k < innerEnd; k++) inner[k] = cut(inner[k], len);
			}
		}
		// the last verbatim-emitted child's origin; null once anything regenerated lands in between.
		// blocks serializing to '' (empty paragraphs) don't break the chain, so pristine neighbours
		// separated by a since-emptied paragraph still re-join on their original whitespace.
		let prevOrigin: BlockOrigin | null = null;
		// the last child that emitted anything, verbatim or not; what the boundary hook sees
		let last: Neighbour | null = null;
		let lastRegenerated: Neighbour | null = null;
		let leadProtected = false;
		let i = 0;
		// a pair still the source pair even when one of them changed: what the changed one replaced
		// stands in for it, since the bytes between them are the file's
		function dialectBoundary(next: Neighbour): string | null {
			if (!options.boundary || !last) return null;
			return options.boundary(last, next, follows(last.origin ?? last.was, next.origin ?? next.was), tailText(64));
		}
		// the file's gap between a pair still the source pair, when it holds a blank line: a
		// guaranteed parbreak, so a regenerated paragraph cannot merge into its neighbour across it.
		// Without one the gap is the dialect's, a single line end being no boundary for regenerated
		// prose
		function fileGap(prev: BlockOrigin | null, next: BlockOrigin | null): string | null {
			return follows(prev, next) && next!.pre != null && BLANK.test(next!.pre) ? next!.pre : null;
		}
		function trailingBreaks(): number {
			let count = 0;
			for (let p = pieces.length - 1; p >= 0; p--) {
				const s = pieces[p];
				let end = s.length;
				while (end > 0 && s[end - 1] === '\n') {
					end--;
					count++;
				}
				if (end > 0) break;
			}
			return count;
		}
		// what was written ends here, before the separator goes on: its trailing line ends go, and the
		// last block, when regenerated, gets its end fixed for what follows. A line end inside a
		// block's own bytes is not cut (a comment's slice ends on one); it counts against the
		// separator instead, which is why what is left of the separator comes back
		function beforeSeparator(sep: string, next: Neighbour): string {
			const breaks = trailingBreaks();
			const kept = Math.max(0, breaks - Math.max(0, outLen - ownEnd));
			truncate(outLen - (breaks - kept));
			const rest = kept > 0 ? sep.replace(/^\n+/, (nl) => nl.slice(Math.min(kept, nl.length))) : sep;
			if (lastRegenerated && options.beforeBreak && /\n[ \t]*\n/.test('\n'.repeat(kept) + rest) && pieces.length > 0) {
				const text = pieces[pieces.length - 1];
				const fixed = options.beforeBreak(text, lastRegenerated, next);
				if (fixed !== text) {
					pieces[pieces.length - 1] = fixed;
					outLen += fixed.length - text.length;
				}
			}
			cutTo(outLen);
			return rest;
		}
		while (i < n) {
			const run = verbatimRun(origins, i);
			if (run > 0) {
				const next = neighbours[i];
				const origin = origins[i]!;
				const contiguous = follows(prevOrigin, origin);
				let sep = '';
				if (outLen === 0) {
					// if the doc's first emission truly starts at the parse's block 0, its `pre` IS the
					// body's original leading gap; reproduce it before the generic trim can strip it.
					if (origin.index === 0 && origin.pre != null) {
						sep = origin.pre;
						leadProtected = true;
					}
				} else if (contiguous && origin.pre != null) {
					sep = origin.pre;
				} else {
					// after regenerated output: the dialect's boundary; else the file's own gap, when the
					// regenerated block stood in for the one the file had before this; else exactly one
					// blank line
					sep = beforeSeparator(fileGap(last?.was ?? null, origin) ?? dialectBoundary(next) ?? '\n\n', next);
				}
				const at = outLen + sep.length;
				const text = origin.text!;
				push(sep);
				push(text);
				ownEnd = outLen;
				// the block's runs are where they were at parse time, moved to where the slice landed
				let pmEnd = pmStarts[i];
				for (let k = 0; k < run; k++) pmEnd += doc.child(i + k).nodeSize;
				const placed = placedRuns(placedEntry(i), `v:${pmStarts[i]}:${at}:${run}`, () => {
					const block: Segment = { pmFrom: pmStarts[i], pmTo: pmEnd, srcFrom: at, srcTo: at + text.length, kind: 'sub' };
					const carried = origin.srcTo! - origin.srcFrom! === text.length && origin.pmTo - origin.pmFrom === pmEnd - pmStarts[i];
					const runs = carried ? origin.leaves.map((s) => shiftSegment(s, pmStarts[i] - origin.pmFrom, at - origin.srcFrom!)) : [];
					const nodes: Node[] = [];
					for (let k = 0; k < run; k++) nodes.push(doc.child(i + k));
					const within = carried
						? nestedOf(nodes, origin.pmFrom).map((s) => shiftSegment(s, pmStarts[i] - origin.pmFrom, at - origin.srcFrom!))
						: [];
					return { block, leaves: runs, inner: within };
				});
				blocks.push(placed.block);
				leafFrom.push(leaves.length);
				for (const s of placed.leaves) leaves.push(s);
				innerFrom.push(inner.length);
				for (const s of placed.inner) inner.push(s);
				prevOrigin = origins[i + run - 1];
				last = neighbours[i + run - 1];
				lastRegenerated = null;
				i += run;
			} else {
				// a changed block that belongs to a construct the parse knew as several blocks is written
				// out with the whole construct, its frame and untouched items as the file's bytes
				const construct = constructSplice(doc, i, neighbours);
				const count = construct ? construct.count : 1;
				let part = partAt(i);
				let partLeaves: Segment[] | null = null;
				let lead = '';
				if (construct) {
					lead = /^[ \t\r\n]*/.exec(part)![0];
					const trail = /[ \t\r\n]*$/.exec(partAt(i + count - 1))![0];
					part = lead + construct.text + trail;
					partLeaves = construct.leaves.map((s) => ({ ...s, srcFrom: s.srcFrom + lead.length, srcTo: s.srcTo + lead.length }));
				}
				if (part !== '') {
					const next = neighbours[i];
					const stripped = part.replace(/^\n+/, '');
					const sep = outLen === 0 ? null : (fileGap(prevOrigin ?? last?.was ?? null, next.was) ?? dialectBoundary(next));
					const gap = '\n'.repeat(trailingBreaks()) + /^\n*/.exec(part)![0];
					let between = '';
					let body = stripped;
					if (sep != null) {
						between = beforeSeparator(sep, next);
					} else if (prevOrigin != null) {
						between = '\n\n';
					} else if (gap.length > 1) {
						between = beforeSeparator(gap, next);
					} else {
						body = part;
					}
					// the doc's first emission: its lead goes now, where the final trim would take it
					if (outLen === 0 && between === '' && !leadProtected) body = body.replace(/^[ \t\r\n]+/, '');
					const at = outLen + between.length;
					push(between);
					push(body);
					const dropped = part.length - body.length;
					let pmEnd = pmStarts[i];
					for (let k = 0; k < count; k++) pmEnd += doc.child(i + k).nodeSize;
					const placed = placedRuns(entryAt(i), `r:${pmStarts[i]}:${at}:${dropped}:${count}`, () => {
						const block: Segment = { pmFrom: pmStarts[i], pmTo: pmEnd, srcFrom: at, srcTo: at + body.length, kind: 'sub' };
						const runs: Segment[] = [];
						for (const s of partLeaves ?? leavesOf(doc, i, n, entryAt(i))) {
							const srcTo = s.srcTo - dropped;
							if (srcTo <= 0) continue;
							runs.push({
								pmFrom: pmStarts[i] + s.pmFrom,
								pmTo: pmStarts[i] + s.pmTo,
								srcFrom: at + Math.max(0, s.srcFrom - dropped),
								srcTo: at + srcTo,
								kind: s.kind
							});
						}
						// the blocks inside: where a splice put them, else where their runs landed
						let within: Segment[];
						if (construct || entryAt(i).inner) {
							const known = construct ? construct.inner : entryAt(i).inner!;
							within = known.map((s) => ({
								pmFrom: pmStarts[i] + s.pmFrom,
								pmTo: pmStarts[i] + s.pmTo,
								srcFrom: at + Math.max(0, s.srcFrom + (construct ? lead.length : 0) - dropped),
								srcTo: at + Math.max(0, s.srcTo + (construct ? lead.length : 0) - dropped),
								kind: 'sub'
							}));
						} else within = derivedInner(doc.child(i), pmStarts[i], runs, at);
						return { block, leaves: runs, inner: within };
					});
					blocks.push(placed.block);
					leafFrom.push(leaves.length);
					for (const s of placed.leaves) leaves.push(s);
					innerFrom.push(inner.length);
					for (const s of placed.inner) inner.push(s);
					prevOrigin = null;
					last = neighbours[i + count - 1];
					lastRegenerated = last;
				}
				i += count;
			}
		}

		// the trailing gap after the ORIGINAL last block belongs to no node; reproduce it iff the
		// doc's actual last emission is still, unbroken, that same pristine block.
		let tailProtected = false;
		if (prevOrigin && isLastOfParse(prevOrigin) && prevOrigin.parse.tail != null) {
			push(prevOrigin.parse.tail);
			tailProtected = true;
		}
		let out = pieces.join('');

		// trim ONLY unprotected edges (identical to a blanket .trim() when no parse is known:
		// editor-created docs, direct converter callers). ascii whitespace only: a leading BOM or a
		// no-break space is content, not a gap
		if (!leadProtected) {
			const trimmed = out.replace(/^[ \t\r\n]+/, '');
			const cut = out.length - trimmed.length;
			if (cut > 0) {
				const shift = (s: Segment): Segment => {
					if (s.srcFrom >= cut) return { ...s, srcFrom: s.srcFrom - cut, srcTo: s.srcTo - cut };
					// the run began inside the trimmed lead
					const pmFrom = s.kind === 'text' ? s.pmFrom + Math.min(cut, s.srcTo) - s.srcFrom : s.pmFrom;
					return { ...s, pmFrom, srcFrom: 0, srcTo: Math.max(0, s.srcTo - cut) };
				};
				for (let k = 0; k < leaves.length; k++) leaves[k] = shift(leaves[k]);
				for (let k = 0; k < blocks.length; k++) blocks[k] = shift(blocks[k]);
			}
			out = trimmed;
			outLen = out.length;
		}
		if (!tailProtected) {
			out = out.replace(/[ \t\r\n]+$/, '');
			cutTo(out.length);
		}
		// runs land block by block in position order, so no sort is needed
		const map: SourceMap = {
			leaves: leaves.filter((s) => s.srcTo > s.srcFrom && s.pmTo > s.pmFrom),
			blocks: blocks.filter((s) => s.srcTo > s.srcFrom),
			inner: inner.filter((s) => s.pmTo > s.pmFrom)
		};
		return {
			text: out,
			leadProtected,
			tailProtected,
			...edgeGaps(neighbours, known),
			trailingRegenerated: tailProtected ? null : lastRegenerated,
			map
		};
	}

	return { serializeDocChildrenDetailed, verbatimParts };
}
