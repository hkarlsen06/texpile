// where a suggestion sits in the rendered document
import type { Node as PMNode } from 'prosemirror-model';
import {
	prepareLoose,
	resolveAnchorLooseIn,
	resolveFragment,
	type AnchorDialect,
	type CommentAnchor,
	type LooseHaystack,
	type ResolvedAnchor
} from '$lib/comments/anchor';
import { MIN_QUOTE, POINT_WEAK, WEAK_CONTEXT, searchContext, searchQuote, withoutEdgeSpace } from '$lib/comments/anchorSearch';
import type { SuggestionMark } from '$lib/comments/activeSuggestions.svelte';
import { renderSource, type WordRun } from '$lib/comments/renderedWords';
import { formatChange } from '$lib/comments/suggest';
import { flattenDoc } from './pmCommentsResolve';
import { chipAround, chipHolding } from './pmSuggestionChip';
import { placeWords, pmSpan } from './pmSuggestionWords';

export type PmSuggestionRange = {
	id: string;
	from: number;
	to: number;
	restore: string;
	old: WordRun[];
	mine: boolean;
	partial: boolean;
	/** the same words with other formatting: the tint says it all, the old words are not struck out */
	format?: boolean;
	/** a change inside a chip, which draws itself: the tint is on the whole chip */
	chip?: boolean;
};

function searchRendered(text: string, a: CommentAnchor, copy?: () => number): ResolvedAnchor | null {
	const point = a.quote.length < MIN_QUOTE;
	const hit = point ? searchContext(text, a.quote, a.prefix, a.suffix, 0, copy) : searchQuote(text, a.quote, a.prefix, a.suffix, 0, copy);
	if (!hit) return null;
	const weak = hit.context < (point ? Math.min(POINT_WEAK, a.prefix.length + a.suffix.length) : WEAK_CONTEXT);
	return { from: hit.from, to: hit.to, exact: false, weak };
}

// the top-level blocks around a span, widened by the paragraphs the quote has on either side of what was placed
function blocksAround(doc: PMNode, from: number, to: number, before: number, after: number): { from: number; to: number } | null {
	const $a = doc.resolve(from);
	const $b = doc.resolve(to);
	if (doc.childCount === 0) return null;
	// a span may start on the newline the flat text puts between blocks, which is a position between them
	const first = Math.max(0, $a.index(0) - before);
	const last = Math.min(doc.childCount - 1, Math.max(first, $b.depth === 0 ? $b.index(0) - 1 : $b.index(0)) + after);
	let pos = 0;
	let start = 0;
	for (let i = 0; i <= last; i++) {
		if (i === first) start = pos;
		pos += doc.child(i).nodeSize;
	}
	return { from: start, to: pos };
}

function paragraphBreaks(source: string): number {
	return (source.match(/\n[ \t]*\n|\\par(?![a-zA-Z])/g) ?? []).length;
}

export function placePmSuggestions(
	doc: PMNode,
	marks: SuggestionMark[],
	dialect: AnchorDialect
): { ranges: PmSuggestionRange[]; partial: Set<string>; hidden: Set<string> } {
	const ranges: PmSuggestionRange[] = [];
	const partial = new Set<string>();
	const hidden = new Set<string>();
	if (marks.length === 0) return { ranges, partial, hidden };
	const flat = flattenDoc(doc);
	const { text, index } = flat;
	let hay: LooseHaystack | null = null;
	for (const s of marks) {
		const anchor = withoutEdgeSpace(s.anchor);
		const { quote, prefix } = s.anchor;
		let hit = searchRendered(text, anchor, s.copy);
		if (!hit || hit.weak) {
			hay ??= prepareLoose(text, dialect);
			hit = resolveAnchorLooseIn(hay, anchor, s.copy);
			if (hit?.weak) hit = null;
		}
		// markup the rendered document shows as plain words, like a color wrapper around them
		if (!hit) {
			const drawn = renderSource(quote, dialect)
				?.words.map((p) => p.map((run) => run.text).join(''))
				.join('\n')
				.trim();
			if (drawn && drawn.length >= MIN_QUOTE) hit = searchRendered(text, { ...anchor, quote: drawn }, s.copy);
			if (hit?.weak) hit = null;
		}
		// a quote holding a formula only ever places by its own text fragments, and the words then fit
		// around that hit; a hit from the surrounding text says nothing about where the words are
		let covers = { from: 0, to: quote.length };
		let near = true;
		if (!hit) {
			hay ??= prepareLoose(text, dialect);
			hit = resolveFragment(hay, quote);
			if (hit) covers = hit.covers ?? covers;
			else {
				near = false;
				hit = resolveFragment(hay, prefix + quote + s.anchor.suffix);
				if (hit?.covers)
					covers = { from: Math.max(0, hit.covers.from - prefix.length), to: Math.min(quote.length, hit.covers.to - prefix.length) };
			}
		}
		const words = hit && near && placeWords(doc, flat, s, hit, dialect);
		if (words) {
			const format = !!formatChange(quote, s.restore, dialect);
			ranges.push({ id: s.id, ...words, restore: s.restore, mine: s.mine, partial: false, ...(format ? { format } : {}) });
			continue;
		}
		const span = hit ? pmSpan(doc, text, index, hit.from, hit.to) : null;
		const placed = span && near && covers.from === 0 && covers.to === quote.length;
		const chip = placed ? chipAround(doc, span.from, span.to) : chipHolding(doc, flat, s.anchor);
		if (chip) {
			ranges.push({ id: s.id, ...chip, restore: s.restore, old: [], mine: s.mine, partial: false, chip: true });
			continue;
		}
		const region = span
			? blocksAround(doc, span.from, span.to, paragraphBreaks(quote.slice(0, covers.from)), paragraphBreaks(quote.slice(covers.to)))
			: null;
		if (region) {
			ranges.push({ id: s.id, ...region, restore: s.restore, old: [], mine: s.mine, partial: true });
			partial.add(s.id);
		} else hidden.add(s.id);
	}
	return { ranges, partial, hidden };
}
