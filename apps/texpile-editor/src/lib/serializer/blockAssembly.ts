// Format-neutral doc assembly: verbatim `orig` substitution over top-level blocks, shared by the
// LaTeX, Markdown and Typst serializers. Knows nothing about any syntax — it deals in opaque
// source slices (orig.latex), parse-time normal forms (orig.norm), seq chains and inter-block gaps.
import { Fragment } from 'prosemirror-model';
import type { Node } from 'prosemirror-model';
import type { Ctx } from './types';
import { blockOriginOf, shiftSegment, withAttrs, type Segment, type SourceMap } from '$lib/editor/visual/sourceSpans';

/**
 * Fills orig.norm on top-level blocks: the block's deterministic serialization at parse time.
 * The serializer re-emits the original orig.latex slice only while the block still serializes
 * to exactly norm, so any edit falls back to regeneration. A block that fails to serialize
 * keeps norm null and always regenerates.
 */
export function fillOrigNorms(doc: Node, serializeNode: (node: Node, ctx: Ctx) => string): Node {
	let changed = false;
	const kids: Node[] = [];
	for (let i = 0; i < doc.childCount; i++) {
		const child = doc.child(i);
		const orig = (child.attrs as { orig?: { latex?: unknown; norm?: unknown } | null }).orig;
		if (orig && typeof orig.latex === 'string' && orig.norm == null) {
			try {
				const norm = serializeNode(child, {
					parent: doc,
					index: i,
					isLastChild: i === doc.childCount - 1,
					inTableCell: false
				});
				kids.push(withAttrs(child, { ...child.attrs, orig: { ...orig, norm } }));
				changed = true;
				continue;
			} catch {
				// leave norm unset, the safe direction: this block always regenerates
			}
		}
		kids.push(child);
	}
	return changed ? doc.copy(Fragment.fromArray(kids)) : doc;
}

// verbatim source preservation: the `orig` attr the importer stamps on top-level blocks
// (see ORIG_BLOCKS in schema.ts). `latex` is historically named; it holds the original source
// slice in whichever dialect the file is.
type OrigAttr = {
	latex?: string | null;
	norm?: string | null;
	pre?: string | null;
	seq?: number | null;
	group?: number | null;
	groupIndex?: number | null;
	groupSize?: number | null;
	/** Body-relative source offset of the block's slice. not read here; positional consumers only. */
	start?: number | null;
};

function origOf(node: Node): OrigAttr | null {
	const o = (node.attrs as { orig?: unknown }).orig;
	return o && typeof o === 'object' ? (o as OrigAttr) : null;
}

/**
 * How many children starting at `i` may be emitted verbatim: 1 for a plain block whose current
 * serialization still equals its parse-time `norm`; the whole group for a multi-block source
 * unit (one itemize is N list nodes), but only when EVERY member is present, in pristine order
 * and unchanged, so a deleted/edited item can never be resurrected. 0 means regenerate.
 */
function verbatimRun(doc: Node, parts: string[], i: number): number {
	const orig = origOf(doc.child(i));
	if (!orig || typeof orig.latex !== 'string' || typeof orig.norm !== 'string') return 0;
	if (orig.group == null) return parts[i] === orig.norm ? 1 : 0;
	const size = orig.groupSize;
	if (orig.groupIndex !== 0 || typeof size !== 'number' || size < 1 || i + size > doc.childCount) return 0;
	for (let k = 0; k < size; k++) {
		const o = origOf(doc.child(i + k));
		if (!o || o.group !== orig.group || o.groupIndex !== k || typeof o.norm !== 'string' || parts[i + k] !== o.norm) return 0;
	}
	return size;
}

type DocTail = {
	text?: string | null;
	afterSeq?: number | null;
};

function docTailOf(doc: Node): DocTail | null {
	const t = (doc.attrs as { docTail?: unknown }).docTail;
	return t && typeof t === 'object' ? (t as DocTail) : null;
}

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
	trailingRegenerated: Node | null;
	/** where every run and block of the doc landed in `text` */
	map: SourceMap;
};

function edgeGaps(doc: Node): { leadGap: string | null; tailGap: string | null } {
	if (doc.childCount === 0) return { leadGap: null, tailGap: null };
	const first = origOf(doc.child(0));
	const last = origOf(doc.child(doc.childCount - 1));
	const docTail = docTailOf(doc);
	return {
		leadGap: first?.seq === 0 && typeof first.pre === 'string' ? first.pre : null,
		tailGap: docTail && typeof docTail.text === 'string' && last?.seq === docTail.afterSeq ? docTail.text : null
	};
}

function neighborKey(sib: Node | null): string {
	if (!sib) return '';
	if (sib.type.name !== 'list') return sib.type.name;
	// the LaTeX list handler coalesces only within one source group (see sameSourceList)
	const group = (sib.attrs.orig as { group?: number | null } | null)?.group;
	return `list:${String(sib.attrs.kind ?? '')}:${group == null ? '' : String(group)}`;
}

export type BlockAssemblyOptions = {
	/**
	 * The separator between two adjacent emissions when at least one of them regenerated, or
	 * they are pristine but no longer source-adjacent. `contiguous` says whether `next` still
	 * directly followed `prev` in the source (consecutive seq). null keeps the default: a hard
	 * blank line.
	 */
	boundary?: (prev: Node, next: Node, contiguous: boolean, before: string) => string | null;
	beforeBreak?: (text: string, last: Node, next: Node) => string;
	/** the leaf runs of a block the dialect regenerated, against that block's own text, positions
	 *  relative to the block node; null when they could not be told apart */
	mapLeaves?: (node: Node, ctx: Ctx, text: string) => Segment[] | null;
};

/**
 * Builds the doc-children serializer for one dialect. Each dialect gets its OWN memo cache: the
 * cache is keyed by node identity, and the same node object must never resolve to another
 * dialect's cached text.
 *
 * Assembly semantics: a block still serializing to its parse-time norm re-emits its source
 * slice; pristine neighbours (consecutive seq) re-join on their original inter-block source
 * (`pre`); every verbatim/regenerated boundary gets a hard blank line so paragraphs can't merge
 * on re-parse, unless the dialect's `boundary` hook decides otherwise. with no orig attrs this
 * equals plain concatenation. also reproduces the body's leading/trailing gaps (they belong to
 * no node) and does the final trim, ONLY at edges that aren't verbatim-protected.
 */
export function createBlockAssembly(serializeNode: (node: Node, ctx: Ctx) => string, options: BlockAssemblyOptions = {}) {
	// per-block memo. PM nodes are immutable and structurally shared across transactions, so an
	// untouched top-level block keeps its object identity keystroke to keystroke: serializing the
	// whole doc becomes O(edited blocks), not O(doc). a block's output depends only on itself plus
	// the neighbour facts handlers read via prevSibling/nextSibling (heading adjacency for
	// paragraph, type+kind for list coalescing) — captured in `key`. if a handler ever reads more
	// of Ctx at the top level, widen the key.
	type Placed = { key: string; block: Segment; leaves: Segment[] };
	type Entry = { key: string; text: string; leaves?: Segment[] | null; placed?: Placed };
	const blockCache = new WeakMap<Node, Entry>();

	// a block's placed runs are the same objects call after call while it lands at the same place;
	// nothing changes them in place, so sharing them is safe
	function placedRuns(entry: Entry, key: string, make: () => { block: Segment; leaves: Segment[] }): Placed {
		if (!entry.placed || entry.placed.key !== key) entry.placed = { key, ...make() };
		return entry.placed;
	}

	function ctxFor(doc: Node, i: number, n: number): Ctx {
		return { parent: doc, index: i, isLastChild: i === n - 1, inTableCell: false };
	}

	function serializeTopBlock(doc: Node, i: number, n: number): Entry {
		const node = doc.child(i);
		const key = neighborKey(i > 0 ? doc.child(i - 1) : null) + '>' + neighborKey(i < n - 1 ? doc.child(i + 1) : null);
		const hit = blockCache.get(node);
		if (hit && hit.key === key) return hit;
		const entry: Entry = { key, text: serializeNode(node, ctxFor(doc, i, n)) };
		blockCache.set(node, entry);
		return entry;
	}

	// the leaf runs of a regenerated block, told once per cache entry
	function leavesOf(doc: Node, i: number, n: number, entry: Entry): Segment[] {
		if (entry.leaves === undefined)
			entry.leaves = options.mapLeaves ? options.mapLeaves(doc.child(i), ctxFor(doc, i, n), entry.text) : null;
		return entry.leaves ?? [];
	}

	function serializeDocChildrenDetailed(doc: Node): DocSerializeResult {
		const n = doc.childCount;
		const entries: Entry[] = [];
		const parts: string[] = [];
		const pmStarts: number[] = [];
		let pm = 0;
		for (let i = 0; i < n; i++) {
			pmStarts.push(pm);
			pm += doc.child(i).nodeSize;
			const entry = serializeTopBlock(doc, i, n);
			entries.push(entry);
			parts.push(entry.text);
		}
		let out = '';
		const leaves: Segment[] = [];
		const blocks: Segment[] = [];
		// leaves land block by block: leafFrom[b] is where block segment b's leaves begin
		const leafFrom: number[] = [];
		function cut(s: Segment, len: number): Segment {
			if (s.srcTo <= len) return s;
			const pmTo = s.kind === 'text' ? s.pmFrom + Math.max(0, len - s.srcFrom) : s.pmTo;
			return { pmFrom: s.pmFrom, pmTo, srcFrom: Math.min(s.srcFrom, len), srcTo: len, kind: s.kind };
		}
		// `out` is cut back before a separator goes on: nothing recorded may point past the cut, and a
		// text run loses as many characters as bytes. Blocks land in output order, so only the last
		// ones can reach past a cut
		function cutTo(len: number) {
			if (len >= out.length) return;
			for (let b = blocks.length - 1; b >= 0 && blocks[b].srcTo > len; b--) {
				blocks[b] = cut(blocks[b], len);
				const end = b + 1 < blocks.length ? leafFrom[b + 1] : leaves.length;
				for (let k = leafFrom[b]; k < end; k++) leaves[k] = cut(leaves[k], len);
			}
		}
		// seq of the last verbatim-emitted child; null once anything regenerated lands in between.
		// blocks serializing to '' (empty paragraphs) don't break the chain, so pristine neighbours
		// separated by a since-emptied paragraph still re-join on their original whitespace.
		let prevSeq: number | null = null;
		// the last child that emitted anything, verbatim or not; what the boundary hook sees
		let lastNode: Node | null = null;
		let lastRegenerated: Node | null = null;
		let leadProtected = false;
		let i = 0;
		function dialectBoundary(next: Node): string | null {
			if (!options.boundary || !lastNode) return null;
			const a = origOf(lastNode)?.seq;
			const b = origOf(next)?.seq;
			return options.boundary(lastNode, next, typeof a === 'number' && b === a + 1, out);
		}
		function trailingBreaks(): number {
			let end = out.length;
			while (end > 0 && out[end - 1] === '\n') end--;
			return out.length - end;
		}
		function trimmedEnd(): string {
			return out.slice(0, out.length - trailingBreaks());
		}
		function beforeSeparator(sep: string, next: Node): string {
			const text = trimmedEnd();
			return lastRegenerated && options.beforeBreak && /\n[ \t]*\n/.test(sep) ? options.beforeBreak(text, lastRegenerated, next) : text;
		}
		while (i < n) {
			const run = verbatimRun(doc, parts, i);
			if (run > 0) {
				const node = doc.child(i);
				const orig = origOf(node)!;
				const contiguous = prevSeq != null && orig.seq === prevSeq + 1;
				let head = out;
				let sep = '';
				if (out === '') {
					// if the doc's first emission truly starts at pristine block 0, its `pre` IS the
					// body's original leading gap; reproduce it before the generic trim can strip it.
					if (orig.seq === 0 && typeof orig.pre === 'string') {
						sep = orig.pre;
						leadProtected = true;
					}
				} else if (contiguous && typeof orig.pre === 'string') {
					sep = orig.pre;
				} else {
					// hard boundary after regenerated output: exactly one blank line (a guaranteed
					// parbreak; without it a verbatim paragraph could merge into its neighbour).
					sep = dialectBoundary(node) ?? '\n\n';
					head = beforeSeparator(sep, node);
				}
				cutTo(head.length);
				const at = head.length + sep.length;
				const latex = orig.latex!;
				out = head + sep + latex;
				// the block's runs are where they were at parse time, moved to where the slice landed
				let pmEnd = pmStarts[i];
				for (let k = 0; k < run; k++) pmEnd += doc.child(i + k).nodeSize;
				const placed = placedRuns(entries[i], `v:${pmStarts[i]}:${at}:${run}`, () => {
					const block: Segment = { pmFrom: pmStarts[i], pmTo: pmEnd, srcFrom: at, srcTo: at + latex.length, kind: 'sub' };
					const origin = blockOriginOf(node);
					const carried = !!origin && origin.srcTo - origin.srcFrom === latex.length && origin.pmTo - origin.pmFrom === pmEnd - pmStarts[i];
					const runs = carried ? origin.leaves.map((s) => shiftSegment(s, pmStarts[i] - origin.pmFrom, at - origin.srcFrom)) : [];
					return { block, leaves: runs };
				});
				blocks.push(placed.block);
				leafFrom.push(leaves.length);
				for (const s of placed.leaves) leaves.push(s);
				const lastSeq = origOf(doc.child(i + run - 1))?.seq;
				prevSeq = typeof lastSeq === 'number' ? lastSeq : null;
				lastNode = doc.child(i + run - 1);
				lastRegenerated = null;
				i += run;
			} else {
				if (parts[i] !== '') {
					const node = doc.child(i);
					const stripped = parts[i].replace(/^\n+/, '');
					const sep = out === '' ? null : dialectBoundary(node);
					const gap = '\n'.repeat(trailingBreaks()) + /^\n*/.exec(parts[i])![0];
					let head = out;
					let between = '';
					let body = stripped;
					if (sep != null) {
						head = beforeSeparator(sep, node);
						between = sep;
					} else if (prevSeq != null) {
						between = '\n\n';
					} else if (gap.length > 1) {
						head = beforeSeparator(gap, node);
						between = gap;
					} else {
						body = parts[i];
					}
					cutTo(head.length);
					// the doc's first emission: its lead goes now, where the final trim would take it
					if (head === '' && between === '' && !leadProtected) body = body.replace(/^[ \t\r\n]+/, '');
					const at = head.length + between.length;
					out = head + between + body;
					const dropped = parts[i].length - body.length;
					const placed = placedRuns(entries[i], `r:${pmStarts[i]}:${at}:${dropped}`, () => {
						const block: Segment = {
							pmFrom: pmStarts[i],
							pmTo: pmStarts[i] + node.nodeSize,
							srcFrom: at,
							srcTo: at + body.length,
							kind: 'sub'
						};
						const runs: Segment[] = [];
						for (const s of leavesOf(doc, i, n, entries[i])) {
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
						return { block, leaves: runs };
					});
					blocks.push(placed.block);
					leafFrom.push(leaves.length);
					for (const s of placed.leaves) leaves.push(s);
					prevSeq = null;
					lastNode = node;
					lastRegenerated = node;
				}
				i++;
			}
		}

		// the trailing gap after the ORIGINAL last block belongs to no node; reproduce it iff the
		// doc's actual last emission is still, unbroken, that same pristine block (seq match).
		let tailProtected = false;
		const docTail = docTailOf(doc);
		if (docTail && typeof docTail.text === 'string' && typeof docTail.afterSeq === 'number' && prevSeq === docTail.afterSeq) {
			out += docTail.text;
			tailProtected = true;
		}

		// trim ONLY unprotected edges (identical to a blanket .trim() when no orig/docTail data
		// exists: editor-created docs, direct converter callers). ascii whitespace only: a
		// leading BOM or a no-break space is content, not a gap
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
		}
		if (!tailProtected) {
			out = out.replace(/[ \t\r\n]+$/, '');
			cutTo(out.length);
		}
		// runs land block by block in position order, so no sort is needed
		const map: SourceMap = {
			leaves: leaves.filter((s) => s.srcTo > s.srcFrom && s.pmTo > s.pmFrom),
			blocks: blocks.filter((s) => s.srcTo > s.srcFrom)
		};
		return { text: out, leadProtected, tailProtected, ...edgeGaps(doc), trailingRegenerated: tailProtected ? null : lastRegenerated, map };
	}

	return { serializeDocChildrenDetailed };
}
