// where a markdown block's bytes are in its file
import type { Token } from 'markdown-it';
import { trimBlankTail } from './sourceSlices';
import { locateLines, type SourceLines } from '../positions';
import { standsFor, type BlockSpan, type LeafSpan } from '$lib/editor/visual/sourceSpans';

/** a block whose bytes are its source lines whole, for a node that draws itself: the run ends
 *  where the block's own span does, before the line break and the blank lines after it */
export function blockSpan(src: SourceLines, tok: Token): LeafSpan[] | null {
	if (!tok.map) return null;
	const from = tok.map[0] < src.lineStarts.length ? src.lineStarts[tok.map[0]] : src.source.length;
	const end = tok.map[1] < src.lineStarts.length ? src.lineStarts[tok.map[1]] : src.source.length;
	const to = trimBlankTail(src.source, from, end);
	return from < to ? standsFor(1, from, to) : null;
}

/** where an empty list item's content would begin: after the marker on its first line */
export function emptyItemAt(item: Token, src: SourceLines): BlockSpan | null {
	if (!item.map || item.map[0] >= src.lineStarts.length) return null;
	const start = src.lineStarts[item.map[0]];
	const line = src.source.slice(start, item.map[0] + 1 < src.lineStarts.length ? src.lineStarts[item.map[0] + 1] : src.source.length);
	const at = start + /^[ \t]*(?:>[ \t]*)*(?:(?:[-*+]|\d+[.)])[ \t]*)?/.exec(line)![0].length;
	return { srcFrom: at, srcTo: at, size: 1 };
}

/** the bytes of a construct below the top level: a paragraph's from where its content starts,
 *  any other's from past the line's prefix (indentation, a quote's `>`) to the end of its last
 *  line, blank lines trimmed. Null when the lines cannot be placed */
export function nestedSpan(tokens: Token[], i: number, src: SourceLines): BlockSpan | null {
	const tok = tokens[i];
	if (!tok.map) return null;
	const [first, last] = tok.map;
	if (first >= src.lineStarts.length) return null;
	const inline = tok.type === 'paragraph_open' && tokens[i + 1]?.type === 'inline' ? tokens[i + 1] : null;
	if (inline && inline.content === '') {
		// an empty paragraph (an item with nothing typed yet) has no bytes of its own: it stands
		// after the marker on its line, so a caret in it lands there and not in a neighbour
		const line = src.source.slice(src.lineStarts[first], last < src.lineStarts.length ? src.lineStarts[last] : src.source.length);
		const at = src.lineStarts[first] + /^[ \t]*(?:>[ \t]*)*(?:(?:[-*+]|\d+[.)])[ \t]*(?:\[[ xX]\][ \t]*)?)?/.exec(line)![0].length;
		return { srcFrom: at, srcTo: at, size: 1 };
	}
	if (inline) {
		const lines = inline.content.split('\n');
		const starts = locateLines(src, first, last, lines);
		const a = starts[0];
		const z = starts[starts.length - 1];
		if (a == null || z == null) return null;
		const to = z + lines[lines.length - 1].length;
		return to > a ? { srcFrom: a, srcTo: to, size: 1 } : null;
	}
	const line = src.source.slice(src.lineStarts[first], last < src.lineStarts.length ? src.lineStarts[last] : src.source.length);
	let prefix = /^[ \t]*(?:>[ \t]*)*/.exec(line)![0];
	// a quote's own marker is its first byte, not its container's frame: back off to the last >
	if (tok.type === 'blockquote_open' && prefix.includes('>')) prefix = prefix.slice(0, prefix.lastIndexOf('>'));
	const from = src.lineStarts[first] + prefix.length;
	const end = last < src.lineStarts.length ? src.lineStarts[last] : src.source.length;
	const to = trimBlankTail(src.source, from, end);
	return to > from ? { srcFrom: from, srcTo: to, size: 1 } : null;
}
