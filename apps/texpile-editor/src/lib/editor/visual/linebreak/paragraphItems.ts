// a paragraph of the visual editor as boxes, glue and penalties for the line breaker
import type { Node as PMNode } from 'prosemirror-model';
import type { EditorView } from 'prosemirror-view';
import type { LineItem } from './knuthPlass';
import type { Hyphenator } from './liangHyphenation';
import type { RunStyleReader, TextRunStyle } from './textRunStyles';
import { isUnmodeledText } from './unmodeledText';
import type { TypedWord } from './wordBeingTyped';
import { textWidth } from './wordWidths';

/** the characters a break at some item is drawn on, as offsets from the paragraph's own position */
export type BreakMark = { from: number; to: number; hyphen: boolean };
export type ParagraphItems = { items: LineItem[]; marks: Map<number, BreakMark> };

export type ParagraphMeasures = {
	styleOf: RunStyleReader;
	/** null leaves words whole */
	hyphenator: Hyphenator | null;
	/** the room an inline node view takes on a line */
	inlineWidthOf(dom: HTMLElement): number;
	/** document positions of a word the patterns must leave alone */
	wholeWord: TypedWord | null;
};

// plain TeX's \hyphenpenalty and \exhyphenpenalty
const HYPHEN_PENALTY = 50;
const EXPLICIT_HYPHEN_PENALTY = 50;
// stands in for infinite stretch, which sums cannot hold
const FILL = 1e6;
// the hyphen the stylesheet names for these breaks (hyphenate-character)
const HYPHEN = '-';
const LETTER = /\p{L}/u;
const ONE_WORD = /^(\P{L}*)(\p{L}{5,})(\P{L}*)$/u;
const DASHES = /[-\u2010\u2013\u2014]/g;

type WordCut = { at: number; fromPatterns: boolean };

function explicitCuts(token: string): WordCut[] {
	const cuts: WordCut[] = [];
	for (const dash of token.matchAll(DASHES)) {
		const at = dash.index + 1;
		if (dash.index > 0 && at < token.length && LETTER.test(token[dash.index - 1]) && LETTER.test(token[at]))
			cuts.push({ at, fromPatterns: false });
	}
	return cuts;
}

function patternCuts(token: string, hyphenator: Hyphenator): WordCut[] {
	const parts = ONE_WORD.exec(token);
	if (!parts) return [];
	const word = parts[2].toLowerCase();
	// a letter whose lowercase form is longer would shift every offset after it
	if (word.length !== parts[2].length) return [];
	return hyphenator(word).map((point) => ({ at: parts[1].length + point, fromPatterns: true }));
}

function endsInSpace(node: PMNode | null | undefined): boolean {
	return !node || node.type.name === 'hard_break' || (node.isText && node.text!.endsWith(' '));
}

function startsWithSpace(node: PMNode | null | undefined): boolean {
	return !node || node.type.name === 'hard_break' || (node.isText && node.text!.startsWith(' '));
}

const NO_BREAK: LineItem = { kind: 'penalty', width: 0, cost: Infinity, flagged: false, fromPatterns: false };
const END_OF_LINE: LineItem[] = [
	NO_BREAK,
	{ kind: 'glue', width: 0, stretch: FILL, shrink: 0 },
	{ kind: 'penalty', width: 0, cost: -Infinity, flagged: false, fromPatterns: false }
];

/** null when some part of the paragraph has a width this cannot know */
export function paragraphItems(
	view: EditorView,
	paragraph: PMNode,
	pos: number,
	block: HTMLElement,
	measures: ParagraphMeasures
): ParagraphItems | null {
	const { styleOf, hyphenator, inlineWidthOf, wholeWord } = measures;
	const items: LineItem[] = [];
	const marks = new Map<number, BreakMark>();
	let modeled = true;

	function addWord(token: string, at: number, style: TextRunStyle, whole: boolean): void {
		let cuts = explicitCuts(token);
		if (cuts.length === 0 && hyphenator && !whole) cuts = patternCuts(token, hyphenator);
		let measured = 0;
		for (const cut of cuts) {
			const upTo = textWidth(style, token.slice(0, cut.at));
			items.push({ kind: 'box', width: upTo - measured });
			measured = upTo;
			marks.set(items.length, { from: at + cut.at - 1, to: at + cut.at, hyphen: cut.fromPatterns });
			items.push({
				kind: 'penalty',
				width: cut.fromPatterns ? textWidth(style, HYPHEN) : 0,
				cost: cut.fromPatterns ? HYPHEN_PENALTY : EXPLICIT_HYPHEN_PENALTY,
				flagged: true,
				fromPatterns: cut.fromPatterns
			});
		}
		items.push({ kind: 'box', width: textWidth(style, token) - measured });
	}

	paragraph.forEach((child, offset, index) => {
		if (!modeled) return;
		const at = offset + 1;
		if (child.type.name === 'hard_break') {
			items.push(...END_OF_LINE);
			return;
		}
		if (!child.isText) {
			const dom = view.nodeDOM(pos + at);
			if (dom instanceof HTMLElement) items.push({ kind: 'box', width: inlineWidthOf(dom) });
			else modeled = false;
			return;
		}
		const text = child.text!;
		const style = styleOf(view, block, child, pos + at);
		if (!style?.measurable || isUnmodeledText(text)) {
			modeled = false;
			return;
		}
		const space = textWidth(style, ' ');
		const joinsBefore = !endsInSpace(index > 0 ? paragraph.child(index - 1) : null);
		const joinsAfter = !startsWithSpace(index + 1 < paragraph.childCount ? paragraph.child(index + 1) : null);
		for (const piece of text.matchAll(/ +|[^ ]+/g)) {
			const from = at + piece.index;
			const to = from + piece[0].length;
			if (piece[0][0] === ' ') {
				const width = space * piece[0].length;
				const before = items[items.length - 1];
				const beforeMark = marks.get(items.length - 1);
				if (before?.kind === 'glue' && beforeMark) {
					// spaces on both sides of a change of marks end a line together
					before.width += width;
					before.stretch += width / 2;
					beforeMark.to = to;
				} else {
					marks.set(items.length, { from, to, hyphen: false });
					items.push({ kind: 'glue', width, stretch: width / 2, shrink: 0 });
				}
			} else {
				const partOfLongerWord = (joinsBefore && piece.index === 0) || (joinsAfter && to === at + text.length);
				const beingTyped = wholeWord !== null && pos + from < wholeWord.to && wholeWord.from < pos + to;
				addWord(piece[0], from, style, partOfLongerWord || beingTyped);
			}
		}
	});
	if (!modeled) return null;
	items.push(...END_OF_LINE);
	return { items, marks };
}
