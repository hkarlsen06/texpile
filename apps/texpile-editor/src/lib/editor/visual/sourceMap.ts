// Caret positions across the boundary, as lookups in the document's source map: exact inside a
// run; at markup, the edge of the nearest run in the same block; in a block with no runs, the block
import { bySource, indexStartingBy, pmToSource, sourceToPm, type Segment, type SourceMap } from './sourceSpans';

type Side = -1 | 1;

/** the top-level block a document position is in */
export function blockAtPm(map: SourceMap, pos: number): Segment | null {
	const i = indexStartingBy(map.blocks, 'pmFrom', pos);
	const b = i >= 0 ? map.blocks[i] : null;
	return b && pos <= b.pmTo ? b : null;
}

/** the top-level block a file offset is in */
export function blockAtSource(map: SourceMap, offset: number): Segment | null {
	const i = indexStartingBy(map.blocks, 'srcFrom', offset);
	const b = i >= 0 ? map.blocks[i] : null;
	return b && offset <= b.srcTo ? b : null;
}

/** the last block starting at or before a file offset, for a viewport that has to land somewhere */
export function blockAtOrBefore(map: SourceMap, offset: number): Segment | null {
	const i = indexStartingBy(map.blocks, 'srcFrom', offset);
	return i >= 0 ? map.blocks[i] : (map.blocks[0] ?? null);
}

function around(list: Segment[], key: 'pmFrom' | 'srcFrom', at: number): { before: Segment | null; after: Segment | null } {
	const i = indexStartingBy(list, key, at);
	return { before: i >= 0 ? list[i] : null, after: i + 1 < list.length ? list[i + 1] : null };
}

/** the file offset of a document position, or null for a document with no map at all */
export function offsetAtPm(map: SourceMap, pos: number, assoc: Side = -1): number | null {
	const exact = pmToSource(map.leaves, pos, assoc);
	if (exact !== null) return exact;
	const block = blockAtPm(map, pos);
	const { before, after } = around(map.leaves, 'pmFrom', pos);
	const within = (s: Segment | null) => (s && (!block || (s.pmFrom >= block.pmFrom && s.pmTo <= block.pmTo)) ? s : null);
	const b = within(before);
	const a = within(after);
	const pick = assoc < 0 ? (b ?? a) : (a ?? b);
	if (pick) return pick === b ? pick.srcTo : pick.srcFrom;
	return block ? block.srcFrom : null;
}

/** the document position of a file offset, or null for a document with no map at all */
export function pmAtOffset(map: SourceMap, offset: number, assoc: Side = 1): number | null {
	const exact = sourceToPm(map.leaves, offset, assoc);
	if (exact !== null) return exact;
	const block = blockAtSource(map, offset);
	const { before, after } = around(bySource(map.leaves), 'srcFrom', offset);
	const within = (s: Segment | null) => (s && (!block || (s.srcFrom >= block.srcFrom && s.srcTo <= block.srcTo)) ? s : null);
	const b = within(before);
	const a = within(after);
	const pick = assoc < 0 ? (b ?? a) : (a ?? b);
	if (pick) return pick === b ? pick.pmTo : pick.pmFrom;
	return block ? Math.min(block.pmFrom + 1, block.pmTo) : null;
}
