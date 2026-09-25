// Ctrl+Home / Ctrl+End, bound rather than left to the browser.
import { Selection, type EditorState, type Transaction } from 'prosemirror-state';

/**
 * Nothing claimed these, so contenteditable answered them, and it needs a TEXT position to land
 * on: in a paper ending on `\bibliography{refs}` (a raw block) Ctrl+End did nothing at all, while
 * Ctrl+Home worked. Selection.atStart/atEnd fall back to a gap cursor, so both always move.
 */
export function selectDocStart(state: EditorState, dispatch?: (tr: Transaction) => void): boolean {
	dispatch?.(state.tr.setSelection(Selection.atStart(state.doc)).scrollIntoView());
	return true;
}

export function selectDocEnd(state: EditorState, dispatch?: (tr: Transaction) => void): boolean {
	dispatch?.(state.tr.setSelection(Selection.atEnd(state.doc)).scrollIntoView());
	return true;
}
