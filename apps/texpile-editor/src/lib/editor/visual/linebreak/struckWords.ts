// a suggestion's struck out words, drawn by a widget at one position of a paragraph, as the line breaker's items need them
import type { Node as PMNode } from 'prosemirror-model';
import type { EditorState } from 'prosemirror-state';
import { hasOldWords, pmSuggestionsKey } from '../extensions/pmSuggestionsState';

export type StruckWords = {
	id: string;
	/** the paragraph offset the words sit at, between two characters */
	at: number;
	text: string;
	/** the runs of one formatting each, as offsets into `text` */
	runs: { from: number; to: number }[];
	element: HTMLElement;
};

/** in text order; null while a widget has no element yet */
export function struckWordsIn(state: EditorState, paragraph: PMNode, pos: number, block: HTMLElement): StruckWords[] | null {
	const found: StruckWords[] = [];
	for (const range of pmSuggestionsKey.getState(state)?.ranges ?? []) {
		if (!hasOldWords(range) || range.from <= pos || range.from >= pos + paragraph.nodeSize) continue;
		const element = block.querySelector<HTMLElement>(`.pm-suggest-old[data-comment="${CSS.escape(range.id)}"]`);
		if (!element) return null;
		let text = '';
		const runs = range.old.map((run) => {
			const from = text.length;
			text += run.text;
			return { from, to: text.length };
		});
		found.push({ id: range.id, at: range.from - pos, text, runs, element });
	}
	// two at one position follow their order on the page
	return found.sort((a, b) => a.at - b.at || (a.element.compareDocumentPosition(b.element) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
}
