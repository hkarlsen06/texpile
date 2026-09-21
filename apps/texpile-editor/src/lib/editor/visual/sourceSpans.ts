// where each run of the rendered document came from in the file, so a place in one editor is a
// lookup in the other. Leaves are recorded while a document is built (by node, the only handle
// there is before positions exist) and collected into position-keyed segments once it stands
import type { Node as PMNode } from 'prosemirror-model';

/** text: the characters are the bytes. sub: the characters stand for the bytes without being them
 *  (an accent, a ligature, a collapsed line wrap, a construct drawn as one node) */
export type SpanKind = 'text' | 'sub';

/** one run of a leaf: `from`/`to` count characters into a text node (a whole atom is 0 to 1),
 *  `srcFrom`/`srcTo` index the text the leaf was parsed from */
export type LeafSpan = { from: number; to: number; srcFrom: number; srcTo: number; kind: SpanKind };

/** one run of the finished document, ProseMirror positions against file offsets */
export type Segment = { pmFrom: number; pmTo: number; srcFrom: number; srcTo: number; kind: SpanKind };

const leafSpans = new WeakMap<PMNode, LeafSpan[]>();

/** record where a leaf came from; hands the node back so a builder can pass it straight on */
export function noteSpans<T extends PMNode>(node: T, spans: LeafSpan[] | null | undefined): T {
	if (spans && spans.length > 0) leafSpans.set(node, spans);
	return node;
}

export function spansOf(node: PMNode): LeafSpan[] | undefined {
	return leafSpans.get(node);
}

/** the same node with other attributes, still knowing where it came from */
export function withAttrs<T extends PMNode>(node: T, attrs: Record<string, unknown>): T {
	const out = noteSpans(node.type.create(attrs, node.content, node.marks) as T, leafSpans.get(node));
	const span = blockSpans.get(node);
	if (span) blockSpans.set(out, span);
	return out;
}

/** a text that is its bytes, one for one */
export function bytesSpan(len: number, srcFrom: number): LeafSpan[] {
	return len > 0 ? [{ from: 0, to: len, srcFrom, srcTo: srcFrom + len, kind: 'text' }] : [];
}

/** a text standing for a byte range, whatever its characters */
export function standsFor(len: number, srcFrom: number, srcTo: number): LeafSpan[] {
	return len > 0 && srcTo > srcFrom ? [{ from: 0, to: len, srcFrom, srcTo, kind: 'sub' }] : [];
}

/** `text` against the bytes it was read from, character by character: equal stretches are text,
 *  the rest stand in. Texts of another length stand for the whole slice */
export function alignedSpans(text: string, srcFrom: number, slice: string): LeafSpan[] {
	if (text.length !== slice.length) return standsFor(text.length, srcFrom, srcFrom + slice.length);
	const out: LeafSpan[] = [];
	let i = 0;
	while (i < text.length) {
		const same = text[i] === slice[i];
		let j = i + 1;
		while (j < text.length && (text[j] === slice[j]) === same) j++;
		out.push({ from: i, to: j, srcFrom: srcFrom + i, srcTo: srcFrom + j, kind: same ? 'text' : 'sub' });
		i = j;
	}
	return out;
}

export type CharSource = { srcFrom: number; srcTo: number; kind: SpanKind } | null;

/** one record per character, for edits that change the text */
export function charsOf(len: number, spans: LeafSpan[] | undefined): CharSource[] {
	const chars: CharSource[] = new Array(len).fill(null);
	for (const s of spans ?? []) {
		for (let i = s.from; i < s.to && i < len; i++) {
			chars[i] =
				s.kind === 'text'
					? { srcFrom: s.srcFrom + (i - s.from), srcTo: s.srcFrom + (i - s.from) + 1, kind: 'text' }
					: { srcFrom: s.srcFrom, srcTo: s.srcTo, kind: 'sub' };
		}
	}
	return chars;
}

/** runs back out of a per-character record */
export function spansOfChars(chars: CharSource[]): LeafSpan[] {
	const out: LeafSpan[] = [];
	for (let i = 0; i < chars.length; i++) {
		const c = chars[i];
		if (!c) continue;
		const last = out[out.length - 1];
		const joins =
			last &&
			last.to === i &&
			last.kind === c.kind &&
			(c.kind === 'text' ? last.srcTo === c.srcFrom : last.srcFrom === c.srcFrom && last.srcTo === c.srcTo);
		if (joins) {
			last.to = i + 1;
			if (c.kind === 'text') last.srcTo = c.srcTo;
			continue;
		}
		out.push({ from: i, to: i + 1, srcFrom: c.srcFrom, srcTo: c.srcTo, kind: c.kind });
	}
	return out;
}

/** the spans of `text.slice(from, to)`, counted from its own start */
export function sliceSpans(text: string, spans: LeafSpan[] | undefined, from: number, to: number): LeafSpan[] {
	return spansOfChars(charsOf(text.length, spans).slice(from, to));
}

/** the spans of several texts laid end to end */
export function concatSpans(parts: { len: number; spans: LeafSpan[] | undefined }[]): LeafSpan[] {
	const out: LeafSpan[] = [];
	let at = 0;
	for (const p of parts) {
		for (const s of p.spans ?? []) {
			const last = out[out.length - 1];
			if (last && last.kind === 'text' && s.kind === 'text' && last.to === s.from + at && last.srcTo === s.srcFrom) {
				last.to = s.to + at;
				last.srcTo = s.srcTo;
			} else out.push({ ...s, from: s.from + at, to: s.to + at });
		}
		at += p.len;
	}
	return out;
}

/** `text` with every `pattern` replaced, the record kept in step: the new characters stand for the
 *  bytes the old ones did */
export function replaceKeepingSpans(
	text: string,
	chars: CharSource[],
	pattern: string,
	replacement: string
): { text: string; chars: CharSource[] } {
	let out = '';
	const outChars: CharSource[] = [];
	let i = 0;
	while (i < text.length) {
		if (!text.startsWith(pattern, i)) {
			out += text[i];
			outChars.push(chars[i]);
			i++;
			continue;
		}
		const taken = chars.slice(i, i + pattern.length).filter((c): c is NonNullable<CharSource> => c !== null);
		const src: CharSource = taken.length
			? { srcFrom: Math.min(...taken.map((c) => c.srcFrom)), srcTo: Math.max(...taken.map((c) => c.srcTo)), kind: 'sub' }
			: null;
		out += replacement;
		for (let k = 0; k < replacement.length; k++) outChars.push(src);
		i += pattern.length;
	}
	return { text: out, chars: outChars };
}

/** the document's runs in position order; `srcOffset` moves records made against a body onto the file */
export function collectSpans(doc: PMNode, srcOffset = 0): Segment[] {
	const out: Segment[] = [];
	doc.descendants((node, pos) => {
		const spans = leafSpans.get(node);
		if (!spans) return true;
		if (node.isText) {
			for (const s of spans)
				out.push({ pmFrom: pos + s.from, pmTo: pos + s.to, srcFrom: s.srcFrom + srcOffset, srcTo: s.srcTo + srcOffset, kind: s.kind });
			return true;
		}
		// a whole node standing for its construct, its children with it
		const s = spans[0];
		out.push({ pmFrom: pos, pmTo: pos + node.nodeSize, srcFrom: s.srcFrom + srcOffset, srcTo: s.srcTo + srcOffset, kind: 'sub' });
		return false;
	});
	return out;
}

/** the whole map of a document: every leaf run, and the source range of each top-level block */
export type SourceMap = {
	leaves: Segment[];
	blocks: Segment[];
	/** the source range of every block below the top level the parse could place, in position
	 *  order; absent from a map a serializer made, since only a parse places blocks */
	inner?: Segment[];
};

/** a stretch of a file parsed on its own: the document it makes and where its runs sit in the stretch */
export type RegionParse = { doc: PMNode; map: SourceMap };
export type RegionParser = (source: string) => RegionParse;

export function emptyMap(): SourceMap {
	return { leaves: [], blocks: [], inner: [] };
}

/** where a top-level block's construct sits in the text it was parsed from, noted by the parser on
 *  the node like a leaf's spans; `size` is how many blocks the construct became, noted on the first
 *  of them (an itemize is one list node per item). Not noted: the parse could not place the block */
export type BlockSpan = { srcFrom: number; srcTo: number; size: number };

const blockSpans = new WeakMap<PMNode, BlockSpan>();

export function noteBlockSpan<T extends PMNode>(node: T, span: BlockSpan | null | undefined): T {
	if (span) blockSpans.set(node, span);
	return node;
}

export function blockSpanOf(node: PMNode): BlockSpan | undefined {
	return blockSpans.get(node);
}

/** a block holding blocks: an environment, a list item, a quote, a table cell */
export function isContainer(node: PMNode): boolean {
	return node.isBlock && !node.isTextblock && node.childCount > 0 && node.firstChild!.isBlock;
}

/** the ranges of `parent`'s children that carry a span, `at` being the position its content starts */
function childRanges(parent: PMNode, at: number, srcOffset: number, into: Segment[]): void {
	let pos = at;
	let i = 0;
	while (i < parent.childCount) {
		const start = pos;
		const span = blockSpans.get(parent.child(i));
		if (!span) {
			pos += parent.child(i).nodeSize;
			i++;
			continue;
		}
		// one source construct that became several blocks (an itemize is one list node per item) is one range
		let size = 0;
		for (let k = 0; k < span.size && i + k < parent.childCount; k++) {
			pos += parent.child(i + k).nodeSize;
			size++;
		}
		into.push({ pmFrom: start, pmTo: pos, srcFrom: srcOffset + span.srcFrom, srcTo: srcOffset + span.srcTo, kind: 'sub' });
		i += size;
	}
}

/** the map of a freshly parsed document: leaves from the registry, blocks from the spans the parse
 *  noted on them, at the top level and inside every container */
export function collectMap(doc: PMNode, srcOffset = 0): SourceMap {
	const leaves = collectSpans(doc, srcOffset);
	const blocks: Segment[] = [];
	childRanges(doc, 0, srcOffset, blocks);
	const inner: Segment[] = [];
	doc.descendants((node, pos) => {
		if (!node.isBlock) return false;
		if (isContainer(node)) childRanges(node, pos + 1, srcOffset, inner);
		return true;
	});
	return { leaves, blocks, inner };
}

/** the text a document was parsed from, and the stretch of it the document stands for (the body of a
 *  file whose preamble and postamble the parse never saw) */
export type ParseBody = { text: string; from: number; to: number };

/** what a parse knew about one of its top-level blocks, kept by node: a block still the one the parse
 *  made can be written out as the bytes it came from, with its leaf runs carried along */
export type BlockOrigin = {
	parse: ParseOrigins;
	/** the block's place among the parse's top-level blocks */
	index: number;
	/** the parsed block itself, which a block standing in for it must equal */
	node: PMNode;
	/** the construct's place in the parsed document and its leaf runs, in the parse's coordinates */
	pmFrom: number;
	pmTo: number;
	leaves: Segment[];
	/** the construct's bytes, in the file; absent when the parse could not place the block */
	srcFrom?: number;
	srcTo?: number;
	text?: string;
	/** the bytes between the construct before and this one; null when either could not be placed,
	 *  '' on every block of a construct but its first */
	pre: string | null;
	/** how many blocks the construct became, and which of them this is */
	size: number;
	member: number;
};

/** one parse's top-level blocks in order, and the bytes after the last of them (null when it could
 *  not be placed). `verbatim` says a block still the parse's own may be written out as its bytes; a
 *  parse that only tells gaps and neighbours apart (a converter's own output, a document made to
 *  forget its source) has every block regenerate */
export type ParseOrigins = {
	origins: BlockOrigin[];
	tail: string | null;
	verbatim: boolean;
	/** where the body the leaves were recorded against begins in the file the origins slice */
	from: number;
};

const blockOrigins = new WeakMap<PMNode, BlockOrigin>();
const docParses = new WeakMap<PMNode, ParseOrigins>();

/**
 * Record what the parse knew about every top-level block of `doc`, the document it made from `body`
 * with `map` saying where. The blocks and the document itself are keyed by node, so a serializer
 * handed a later document can still tell which blocks the parse made. A converter registers its
 * own output without `verbatim`: the gaps and constructs are known, the bytes are not written back
 * until the roundtrip glue registers the document against the file the body came from.
 */
export function rememberParseMap(doc: PMNode, map: SourceMap, body: ParseBody | null, verbatim = true): ParseOrigins {
	const parse: ParseOrigins = { origins: [], tail: null, verbatim, from: body ? body.from : 0 };
	const n = doc.childCount;
	let b = 0;
	let l = 0;
	let pos = 0;
	// where the construct before ended in the file; null once one could not be placed
	let prevEnd: number | null = body ? body.from : 0;
	let i = 0;
	while (i < n) {
		const start = pos;
		while (b < map.blocks.length && map.blocks[b].pmFrom < start) b++;
		const block = b < map.blocks.length && map.blocks[b].pmFrom === start ? map.blocks[b] : null;
		if (!block) {
			const child = doc.child(i);
			pos += child.nodeSize;
			parse.origins.push({ parse, index: i, node: child, pmFrom: start, pmTo: pos, leaves: [], pre: null, size: 1, member: 0 });
			prevEnd = null;
			i++;
			continue;
		}
		while (l < map.leaves.length && map.leaves[l].pmFrom < block.pmFrom) l++;
		const leaves: Segment[] = [];
		for (let k = l; k < map.leaves.length && map.leaves[k].pmFrom < block.pmTo; k++) leaves.push(map.leaves[k]);
		let size = 0;
		let end = start;
		while (i + size < n && end < block.pmTo) {
			end += doc.child(i + size).nodeSize;
			size++;
		}
		const text = body ? body.text.slice(block.srcFrom, block.srcTo) : undefined;
		const pre = body && prevEnd != null && prevEnd <= block.srcFrom ? body.text.slice(prevEnd, block.srcFrom) : null;
		for (let k = 0; k < size; k++) {
			parse.origins.push({
				parse,
				index: i + k,
				node: doc.child(i + k),
				pmFrom: block.pmFrom,
				pmTo: block.pmTo,
				leaves,
				...(body ? { srcFrom: block.srcFrom, srcTo: block.srcTo, text } : {}),
				pre: k === 0 ? pre : '',
				size,
				member: k
			});
		}
		prevEnd = block.srcTo;
		pos = end;
		i += size;
	}
	parse.tail = body && prevEnd != null && prevEnd <= body.to ? body.text.slice(prevEnd, body.to) : null;
	for (const o of parse.origins) blockOrigins.set(o.node, o);
	docParses.set(doc, parse);
	rememberContainers(doc, map, body, verbatim);
	return parse;
}

/**
 * The same record for every container in the document: its children against the ranges the parse
 * placed them at, so a container written out afresh still writes its untouched children as their
 * bytes. A child's range is believed only inside its container's own and after its sibling's.
 */
function rememberContainers(doc: PMNode, map: SourceMap, body: ParseBody | null, verbatim: boolean): void {
	const inner = map.inner ?? [];
	if (inner.length === 0) return;
	const byStart = new Map<number, Segment>();
	for (const s of inner) byStart.set(s.pmFrom, s);
	doc.descendants((node, pos) => {
		if (!node.isBlock) return false;
		if (!isContainer(node)) return true;
		const own = blockOrigins.get(node);
		const bounds = own && own.srcFrom !== undefined ? { from: own.srcFrom, to: own.srcTo! } : null;
		const parse: ParseOrigins = { origins: [], tail: null, verbatim, from: body ? body.from : 0 };
		let at = pos + 1;
		let prevEnd: number | null = null;
		let i = 0;
		while (i < node.childCount) {
			const start = at;
			const seg = byStart.get(start);
			const placed =
				!!seg && (!bounds || (seg.srcFrom >= bounds.from && seg.srcTo <= bounds.to)) && (prevEnd == null || seg.srcFrom >= prevEnd);
			if (!seg || !placed) {
				const child = node.child(i);
				at += child.nodeSize;
				parse.origins.push({ parse, index: i, node: child, pmFrom: start, pmTo: at, leaves: [], pre: null, size: 1, member: 0 });
				prevEnd = null;
				i++;
				continue;
			}
			let size = 0;
			while (i + size < node.childCount && at < seg.pmTo) {
				at += node.child(i + size).nodeSize;
				size++;
			}
			const leaves: Segment[] = [];
			for (
				let l = Math.max(0, indexStartingBy(map.leaves, 'pmFrom', seg.pmFrom));
				l < map.leaves.length && map.leaves[l].pmFrom < seg.pmTo;
				l++
			) {
				if (map.leaves[l].pmFrom >= seg.pmFrom) leaves.push(map.leaves[l]);
			}
			const text = body ? body.text.slice(seg.srcFrom, seg.srcTo) : undefined;
			const pre = body && prevEnd != null ? body.text.slice(prevEnd, seg.srcFrom) : null;
			for (let k = 0; k < size; k++) {
				parse.origins.push({
					parse,
					index: i + k,
					node: node.child(i + k),
					pmFrom: seg.pmFrom,
					pmTo: seg.pmTo,
					leaves,
					...(body ? { srcFrom: seg.srcFrom, srcTo: seg.srcTo, text } : {}),
					pre: k === 0 ? pre : '',
					size,
					member: k
				});
			}
			prevEnd = seg.srcTo;
			i += size;
		}
		for (const o of parse.origins) blockOrigins.set(o.node, o);
		docParses.set(node, parse);
		return true;
	});
}

/** a parse that knows nothing: for a document with no source behind it */
export function noParse(): ParseOrigins {
	return { origins: [], tail: null, verbatim: false, from: 0 };
}

/** what the parse knew about the children of one of its containers, by the container node it made */
export function containerOriginsOf(parsed: PMNode): ParseOrigins | undefined {
	return docParses.get(parsed);
}

/** a later document is the parse's own: its blocks answer to the parse from here on */
export function adoptParse(doc: PMNode, parse: ParseOrigins): void {
	docParses.set(doc, parse);
}

/** the parse a document came from: recorded on it, else the one any of its blocks remembers */
export function parseOf(doc: PMNode): ParseOrigins | undefined {
	const known = docParses.get(doc);
	if (known) return known;
	for (let i = 0; i < doc.childCount; i++) {
		const o = blockOrigins.get(doc.child(i));
		if (o) return o.parse;
	}
	return undefined;
}

/** the same document with its bytes forgotten: every block is written out afresh by the
 *  deterministic rules, the path an edited block takes, while the gaps between blocks and the
 *  constructs they came from stay known */
export function withoutOrigins(doc: PMNode): PMNode {
	// type.create, not copy: copy hands the same node back for the same content. Every block at
	// every depth is made afresh, so no container finds a child it still knows
	function fresh(node: PMNode): PMNode {
		if (!isContainer(node)) return node.type.create(node.attrs, node.content, node.marks);
		const kids: PMNode[] = [];
		node.forEach((child) => kids.push(fresh(child)));
		return node.type.create(node.attrs, kids, node.marks);
	}
	const kids: PMNode[] = [];
	doc.forEach((child) => kids.push(fresh(child)));
	const out = doc.type.create(doc.attrs, kids, doc.marks);
	const parse = parseOf(doc);
	if (parse) {
		const forgotten: ParseOrigins = { origins: [], tail: parse.tail, verbatim: false, from: parse.from };
		for (const o of parse.origins) forgotten.origins.push({ ...o, parse: forgotten });
		docParses.set(out, forgotten);
	}
	return out;
}

/** what the parse knew about this very block, when it made it or a block equal to it */
export function blockOriginOf(node: PMNode): BlockOrigin | undefined {
	return blockOrigins.get(node);
}

/** every top-level block of `doc` against its parse: `origins[i]` is the parse's block that child i
 *  still is (the same node, or one equal to it standing in the parse's order); `was[i]` is the block
 *  child i most likely replaced, for a block that changed */
export type DocOrigins = { parse: ParseOrigins | null; origins: (BlockOrigin | null)[]; was: (BlockOrigin | null)[] };

export function originsOf(doc: PMNode, parse: ParseOrigins | null = parseOf(doc) ?? null): DocOrigins {
	const n = doc.childCount;
	const origins: (BlockOrigin | null)[] = new Array(n).fill(null);
	const was: (BlockOrigin | null)[] = new Array(n).fill(null);
	if (!parse) return { parse: null, origins, was };
	if (!docParses.has(doc)) docParses.set(doc, parse);
	for (let i = 0; i < n; i++) {
		const o = blockOrigins.get(doc.child(i));
		if (o && o.parse === parse) origins[i] = o;
	}
	// a block the parse does not know by node: the parse's next unclaimed block, when equal to it. An
	// edit leaves a new node with the old content (a letter typed and deleted, an undo), and equal
	// content came from the same bytes as far as writing them out is concerned
	let next = 0;
	for (let i = 0; i < n; i++) {
		const o = origins[i];
		if (o) {
			next = Math.max(next, o.index + 1);
			continue;
		}
		let limit = parse.origins.length;
		for (let j = i + 1; j < n; j++) {
			const a = origins[j];
			if (a) {
				limit = a.index;
				break;
			}
		}
		const child = doc.child(i);
		for (let k = next; k < limit; k++) {
			const c = parse.origins[k];
			if (!c.node.eq(child)) continue;
			blockOrigins.set(child, c);
			origins[i] = c;
			next = k + 1;
			break;
		}
	}
	// blocks that changed, run by run between two known blocks: a leaf the edit left as it was still
	// says which bytes it came from, and the parse's block holding them is what the block replaced,
	// provided it lies between the known neighbours; failing that, when the counts agree, the run
	// stood for the parse's blocks between those
	let i = 0;
	while (i < n) {
		if (origins[i]) {
			i++;
			continue;
		}
		let j = i;
		while (j < n && !origins[j]) j++;
		const lo = i > 0 ? origins[i - 1]!.index : -1;
		const hi = j < n ? origins[j]!.index : parse.origins.length;
		let last = lo;
		for (let k = i; k < j; k++) {
			const at = firstLeafOffset(doc.child(k));
			const o = at === null ? null : originHolding(parse, at + parse.from, last + 1, hi);
			if (!o) continue;
			was[k] = o;
			last = o.index;
		}
		// between two blocks now placed, the ones still unplaced stood for the parse's blocks between
		// those when the counts agree
		let k = i;
		while (k < j) {
			if (was[k]) {
				k++;
				continue;
			}
			let m = k;
			while (m < j && !was[m]) m++;
			const a = k > i ? was[k - 1]!.index : lo;
			const b = m < j ? was[m]!.index : hi;
			// the same count, and the same kind of block at every place: a paragraph never stood for a heading
			let alike = b - a - 1 === m - k;
			for (let q = k; alike && q < m; q++) alike = parse.origins[a + 1 + (q - k)].node.type === doc.child(q).type;
			if (alike) for (let q = k; q < m; q++) was[q] = parse.origins[a + 1 + (q - k)];
			k = m;
		}
		i = j;
	}
	return { parse, origins, was };
}

/** the body offset the first recorded leaf of `node` came from, or null when no leaf remembers one */
function firstLeafOffset(node: PMNode): number | null {
	let found: number | null = null;
	node.descendants((n) => {
		if (found !== null) return false;
		const spans = leafSpans.get(n);
		if (spans && spans.length > 0) found = spans[0].srcFrom;
		return found === null;
	});
	return found;
}

/** the parse's block whose bytes hold the file offset `at`, among those with index in [from, to) */
function originHolding(parse: ParseOrigins, at: number, from: number, to: number): BlockOrigin | null {
	for (let k = Math.max(0, from); k < Math.min(to, parse.origins.length); k++) {
		const o = parse.origins[k];
		if (o.srcFrom !== undefined && o.srcTo !== undefined && at >= o.srcFrom && at < o.srcTo) return o;
	}
	return null;
}

/** the map of a text after every bare line feed became a carriage return and line feed */
export function mapToCrlf(map: SourceMap, text: string): SourceMap {
	const before = new Array<number>(text.length + 1);
	let n = 0;
	for (let i = 0; i <= text.length; i++) {
		before[i] = n;
		if (text[i] === '\n' && text[i - 1] !== '\r') n++;
	}
	const shift = (s: Segment): Segment => ({ ...s, srcFrom: s.srcFrom + before[s.srcFrom], srcTo: s.srcTo + before[s.srcTo] });
	return { leaves: map.leaves.map(shift), blocks: map.blocks.map(shift), inner: (map.inner ?? []).map(shift) };
}

export function shiftSegment(s: Segment, dpm: number, dsrc: number): Segment {
	return { pmFrom: s.pmFrom + dpm, pmTo: s.pmTo + dpm, srcFrom: s.srcFrom + dsrc, srcTo: s.srcTo + dsrc, kind: s.kind };
}

/** the map with its source side moved by `dsrc` and cut to `[0, srcLength)`; runs left empty by the cut go */
export function shiftMap(map: SourceMap, dsrc: number, srcLength: number): SourceMap {
	function move(list: Segment[]): Segment[] {
		const out: Segment[] = [];
		for (const s of list) {
			const srcFrom = Math.min(srcLength, Math.max(0, s.srcFrom + dsrc));
			const srcTo = Math.min(srcLength, Math.max(0, s.srcTo + dsrc));
			if (srcTo > srcFrom) out.push({ pmFrom: s.pmFrom, pmTo: s.pmTo, srcFrom, srcTo, kind: s.kind });
		}
		return out;
	}
	return { leaves: move(map.leaves), blocks: move(map.blocks), inner: move(map.inner ?? []) };
}

const srcOrder = new WeakMap<Segment[], Segment[]>();

export function bySource(spans: Segment[]): Segment[] {
	let sorted = srcOrder.get(spans);
	if (!sorted) {
		sorted = [...spans].sort((a, b) => a.srcFrom - b.srcFrom || a.srcTo - b.srcTo);
		srcOrder.set(spans, sorted);
	}
	return sorted;
}

/** index of the last segment starting at or before `at` along `key`, or -1 */
export function indexStartingBy(spans: Segment[], key: 'pmFrom' | 'srcFrom', at: number): number {
	let lo = 0;
	let hi = spans.length - 1;
	let found = -1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (spans[mid][key] <= at) {
			found = mid;
			lo = mid + 1;
		} else hi = mid - 1;
	}
	return found;
}

type Side = -1 | 1;

function within(spans: Segment[], from: 'pmFrom' | 'srcFrom', to: 'pmTo' | 'srcTo', at: number, assoc: Side): Segment | null {
	const i = indexStartingBy(spans, from, at);
	if (i < 0) return null;
	let s = spans[i];
	// at a boundary two segments share, the caller says whether the one ending there or the one starting there is meant
	if (assoc < 0 && s[from] === at && i > 0 && spans[i - 1][to] === at) s = spans[i - 1];
	return at >= s[from] && at <= s[to] ? s : null;
}

/** the file offset of a document position, or null where the document has no bytes of its own */
export function pmToSource(spans: Segment[], pos: number, assoc: Side = -1): number | null {
	const s = within(spans, 'pmFrom', 'pmTo', pos, assoc);
	if (!s) return null;
	if (s.kind === 'text') return s.srcFrom + (pos - s.pmFrom);
	// characters that stand for bytes: the one on the side named belongs to the whole of them
	if (pos === s.pmFrom) return s.srcFrom;
	if (pos === s.pmTo) return s.srcTo;
	return assoc < 0 ? s.srcTo : s.srcFrom;
}

/** the document position of a file offset, or null for bytes no leaf came from */
export function sourceToPm(spans: Segment[], offset: number, assoc: Side = -1): number | null {
	const s = within(bySource(spans), 'srcFrom', 'srcTo', offset, assoc);
	if (!s) return null;
	if (s.kind === 'text') return s.pmFrom + (offset - s.srcFrom);
	if (offset === s.srcFrom) return s.pmFrom;
	if (offset === s.srcTo) return s.pmTo;
	return assoc < 0 ? s.pmTo : s.pmFrom;
}

/** pmToSource, else the edge of the nearest run on the side `assoc` names; null only for a document with no runs */
export function nearestSource(spans: Segment[], pos: number, assoc: Side = -1): number | null {
	const exact = pmToSource(spans, pos, assoc);
	if (exact !== null) return exact;
	const i = indexStartingBy(spans, 'pmFrom', pos);
	const before = i >= 0 ? spans[i] : null;
	const after = i + 1 < spans.length ? spans[i + 1] : null;
	const pick = assoc < 0 ? (before ?? after) : (after ?? before);
	if (!pick) return null;
	return pick === before ? pick.srcTo : pick.srcFrom;
}

/** sourceToPm, else the edge of the nearest run on the side `assoc` names; null only for a document with no runs */
export function nearestPm(spans: Segment[], offset: number, assoc: Side = 1): number | null {
	const exact = sourceToPm(spans, offset, assoc);
	if (exact !== null) return exact;
	const sorted = bySource(spans);
	const i = indexStartingBy(sorted, 'srcFrom', offset);
	const before = i >= 0 ? sorted[i] : null;
	const after = i + 1 < sorted.length ? sorted[i + 1] : null;
	const pick = assoc < 0 ? (before ?? after) : (after ?? before);
	if (!pick) return null;
	return pick === before ? pick.pmTo : pick.pmFrom;
}
