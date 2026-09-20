// the chip a suggestion changed inside: a chip draws itself, so the tint goes on the whole chip
import type { Node as PMNode } from 'prosemirror-model';
import type { CommentAnchor } from '$lib/comments/anchor';
import type { FlatDoc } from './pmCommentsResolve';

type ChipSpan = { from: number; to: number };

const CHIPS = new Set(['inline_latex', 'raw_latex']);

/** the chip a placed span sits in; a point at a chip's edge is a change beside it */
export function chipAround(doc: PMNode, from: number, to: number): ChipSpan | null {
	const $from = doc.resolve(from);
	for (let depth = $from.depth; depth > 0; depth--) {
		if (!CHIPS.has($from.node(depth).type.name)) continue;
		const inside = to > from ? to <= $from.end(depth) : from > $from.start(depth) && from < $from.end(depth);
		return inside ? { from: $from.before(depth), to: $from.after(depth) } : null;
	}
	return null;
}

// where the words sit in a chip's source with what the file has on either side of them, or -1
function quoteInChip(source: string, a: CommentAnchor): number {
	const [first, last] = a.quote ? [0, source.length - a.quote.length] : [1, source.length - 1];
	for (let at = first; at <= last; at++) {
		if (!source.startsWith(a.quote, at)) continue;
		const before = source.slice(0, at);
		const after = source.slice(at + a.quote.length);
		if ((a.prefix.endsWith(before) || before.endsWith(a.prefix)) && (a.suffix.startsWith(after) || after.startsWith(a.suffix))) return at;
	}
	return -1;
}

function squash(text: string): string {
	return text.replace(/\s+/g, ' ');
}

// the rendered document puts one line between blocks where the file has a blank line
function contextAround(flat: FlatDoc, from: number, to: number, a: CommentAnchor): number {
	const before = squash(flat.text.slice(Math.max(0, from - 2 * a.prefix.length), from));
	const prefix = squash(a.prefix);
	let score = 0;
	while (score < Math.min(before.length, prefix.length) && before[before.length - 1 - score] === prefix[prefix.length - 1 - score]) score++;
	const after = squash(flat.text.slice(to, to + 2 * a.suffix.length));
	const suffix = squash(a.suffix);
	for (let i = 0; i < Math.min(after.length, suffix.length) && after[i] === suffix[i]; i++) score++;
	return score;
}

/**
 * a change at the head of a chip has too little text around it to be found by (a page break's name, alone on its line):
 * the chip whose own source holds the words, the text around it deciding between copies
 */
export function chipHolding(doc: PMNode, flat: FlatDoc, a: CommentAnchor): ChipSpan | null {
	const found: { chip: ChipSpan; score: number }[] = [];
	doc.descendants((node, pos) => {
		if (!CHIPS.has(node.type.name)) return true;
		const at = quoteInChip(node.textContent, a);
		if (at >= 0) {
			const from = flat.index.indexOf(pos + 1) + at;
			found.push({ chip: { from: pos, to: pos + node.nodeSize }, score: contextAround(flat, from, from + a.quote.length, a) });
		}
		return false;
	});
	found.sort((x, y) => y.score - x.score);
	return found.length === 1 || (found.length > 1 && found[0].score > found[1].score) ? found[0].chip : null;
}
