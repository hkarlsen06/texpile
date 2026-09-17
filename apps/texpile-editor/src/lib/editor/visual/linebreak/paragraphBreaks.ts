// where one paragraph's lines end, or why it is left to the browser
import type { Node as PMNode } from 'prosemirror-model';
import type { EditorView } from 'prosemirror-view';
import { breakLines } from './knuthPlass';
import { paragraphItems, type BreakMark, type ParagraphItems, type ParagraphMeasures } from './paragraphItems';

export type ChosenBreaks = { marks: BreakMark[]; justified: boolean };
/** 'native': the browser wraps it, justified when the text is. 'untouched': aligned or directed some other way, nothing of ours applies */
export type ParagraphBreaks = ChosenBreaks | 'native' | 'untouched';

/** breaks the paragraph had before an edit, good as far as its text is unchanged (an offset like the marks') */
export type KeptBreaks = { marks: BreakMark[]; unchangedTo: number };

export function sameBreaks(a: ParagraphBreaks, b: ParagraphBreaks): boolean {
	if (typeof a === 'string' || typeof b === 'string') return a === b;
	if (a.justified !== b.justified || a.marks.length !== b.marks.length) return false;
	return a.marks.every((mark, i) => mark.from === b.marks[i].from && mark.to === b.marks[i].to && mark.hyphen === b.marks[i].hyphen);
}

export type BreakingContext = ParagraphMeasures & {
	justified: boolean;
	/** the width of a block's content box */
	widthOf(block: HTMLElement): number;
};

// layout rounds to 1/64 px; this keeps a line that measures exactly full from spilling
const SLACK = 0.25;
const BREAKABLE_ALIGNMENTS = new Set(['start', 'left', 'justify', '-webkit-auto']);

// TeX's own order: no hyphens at \pretolerance, hyphens at \tolerance, then whatever fits
const JUSTIFIED_PASSES = [
	{ tolerance: 100, hyphenate: false },
	{ tolerance: 200, hyphenate: true },
	{ tolerance: Infinity, hyphenate: true }
];
// a ragged edge hides uneven spaces, so nothing is gained by splitting words for it
const RAGGED_PASSES = [{ tolerance: Infinity, hyphenate: false }];

// the items the kept breaks sit on now, up to the first one the paragraph no longer offers (a word held whole, say)
function keptItems(built: ParagraphItems, kept: KeptBreaks): number[] {
	const offered = [...built.marks];
	const items: number[] = [];
	let next = 0;
	for (const mark of kept.marks) {
		if (mark.to > kept.unchangedTo) break;
		while (next < offered.length && offered[next][1].from < mark.from) next++;
		const [item, now] = offered[next] ?? [];
		if (item === undefined || now.from !== mark.from || now.to !== mark.to || now.hyphen !== mark.hyphen) break;
		items.push(item);
	}
	return items;
}

export function paragraphBreaks(
	view: EditorView,
	paragraph: PMNode,
	pos: number,
	block: HTMLElement,
	context: BreakingContext,
	kept?: KeptBreaks
): ParagraphBreaks {
	const style = getComputedStyle(block);
	if (style.direction !== 'ltr' || !BREAKABLE_ALIGNMENTS.has(style.textAlign)) return 'untouched';
	const width = context.widthOf(block) - SLACK;
	const indent = parseFloat(style.textIndent) || 0;
	const built = paragraphItems(view, paragraph, pos, block, context.justified ? context : { ...context, hyphenator: null });
	if (!built) return 'native';
	const fixed = kept ? keptItems(built, kept) : [];
	// with nothing that fits after the kept lines, the whole paragraph is tried
	for (const lines of fixed.length > 0 ? [fixed, []] : [[]]) {
		for (const pass of context.justified ? JUSTIFIED_PASSES : RAGGED_PASSES) {
			const breaks = breakLines(built.items, { ...pass, firstLineWidth: width - indent, lineWidth: width }, lines.at(-1) ?? -1);
			if (!breaks) continue;
			const marks = [...lines, ...breaks].flatMap((item) => built.marks.get(item) ?? []);
			return { marks, justified: context.justified };
		}
	}
	return 'native';
}
