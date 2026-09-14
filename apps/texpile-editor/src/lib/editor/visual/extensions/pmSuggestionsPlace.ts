// where a suggestion sits in the rendered document
import type { Node as PMNode } from 'prosemirror-model';
import { TextSelection } from 'prosemirror-state';
import {
	prepareLoose,
	resolveAnchorLooseIn,
	resolveFragment,
	type AnchorDialect,
	type CommentAnchor,
	type LooseHaystack,
	type ResolvedAnchor
} from '$lib/comments/anchor';
import { MIN_QUOTE, POINT_WEAK, WEAK_CONTEXT, searchContext, searchQuote } from '$lib/comments/anchorSearch';
import type { SuggestionMark } from '$lib/comments/activeSuggestions.svelte';
import { isSelfRendered } from '$lib/editor/visual/diff/selfRendered';
import { flattenDoc } from './pmCommentsResolve';

export type PmSuggestionRange = {
	id: string;
	from: number;
	to: number;
	restore: string;
	mine: boolean;
	partial: boolean;
};

const MARKUP: Record<AnchorDialect, RegExp> = {
	tex: /[\\{}$%&~^_#]/,
	md: /[\\*_`#[\]<>|]/,
	typ: /[\\#*_`$<>@=]/
};

function pmSpan(doc: PMNode, text: string, index: number[], from: number, to: number): { from: number; to: number } | null {
	if (to === from) {
		const after = from > 0 && text[from - 1] !== '\n' && text[from - 1] !== '￼';
		const raw = after ? index[from - 1] + 1 : from < index.length ? index[from] : index.length ? index[index.length - 1] + 1 : null;
		if (raw === null) return null;
		try {
			const at = TextSelection.near(doc.resolve(raw), 1).from;
			return { from: at, to: at };
		} catch {
			return null;
		}
	}
	const a = index[from];
	const b = index[to - 1];
	return a === undefined || b === undefined ? null : { from: a, to: b + 1 };
}

function searchRendered(text: string, a: CommentAnchor): ResolvedAnchor | null {
	const point = a.quote.length < MIN_QUOTE;
	const hit = point ? searchContext(text, a.quote, a.prefix, a.suffix, 0) : searchQuote(text, a.quote, a.prefix, a.suffix, 0);
	if (!hit) return null;
	const weak = hit.context < (point ? Math.min(POINT_WEAK, a.prefix.length + a.suffix.length) : WEAK_CONTEXT);
	return { from: hit.from, to: hit.to, exact: false, weak };
}

function inOneTextblock(doc: PMNode, from: number, to: number): boolean {
	const $a = doc.resolve(from);
	if (!$a.parent.isTextblock || !$a.sameParent(doc.resolve(to))) return false;
	let drawn = true;
	doc.nodesBetween(from, to, (node) => {
		if (isSelfRendered(node)) drawn = false;
	});
	return drawn;
}

function blocksAround(doc: PMNode, from: number, to: number): { from: number; to: number } | null {
	const $a = doc.resolve(from);
	const $b = doc.resolve(to);
	if ($a.depth === 0 || $b.depth === 0) return null;
	return { from: $a.before(1), to: $b.after(1) };
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
	const { text, index } = flattenDoc(doc);
	let hay: LooseHaystack | null = null;
	for (const s of marks) {
		let hit = searchRendered(text, s.anchor);
		if (!hit || hit.weak) {
			hay ??= prepareLoose(text, dialect);
			hit = resolveAnchorLooseIn(hay, s.anchor);
			if (hit?.weak) hit = null;
		}
		let span = hit ? pmSpan(doc, text, index, hit.from, hit.to) : null;
		const words = s.anchor.quote + s.restore;
		if (span && !MARKUP[dialect].test(words) && !/\n\s*\n/.test(words) && inOneTextblock(doc, span.from, span.to)) {
			ranges.push({ id: s.id, ...span, restore: s.restore, mine: s.mine, partial: false });
			continue;
		}
		if (!span) {
			hay ??= prepareLoose(text, dialect);
			const frag = resolveFragment(hay, s.anchor.quote) ?? resolveFragment(hay, s.anchor.prefix + s.anchor.quote + s.anchor.suffix);
			span = frag ? pmSpan(doc, text, index, frag.from, frag.to) : null;
		}
		const region = span ? blocksAround(doc, span.from, span.to) : null;
		if (region) {
			ranges.push({ id: s.id, ...region, restore: s.restore, mine: s.mine, partial: true });
			partial.add(s.id);
		} else hidden.add(s.id);
	}
	return { ranges, partial, hidden };
}
