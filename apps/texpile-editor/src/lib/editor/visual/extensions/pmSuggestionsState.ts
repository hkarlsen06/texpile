// the suggestions plugin's key and what its state holds
import { PluginKey, type EditorState } from 'prosemirror-state';
import type { DecorationSet } from 'prosemirror-view';
import type { PmSuggestionRange } from './pmSuggestionsPlace';
import type { CaretSide } from '$lib/comments/oldWordsCaret';
import type { EditMode } from '$lib/comments/suggestCompare';
import { typingSide } from '$lib/comments/activeSuggestions.svelte';

export type PmSuggestionsState = {
	ranges: PmSuggestionRange[];
	focused: string | null;
	caret: CaretSide | null;
	deco: DecorationSet;
	mode: EditMode;
};
export type PmSuggestionsMeta =
	{ type: 'set'; ranges: PmSuggestionRange[] } | { type: 'focus'; id: string | null } | { type: 'caret'; caret: CaretSide | null };

export const pmSuggestionsKey = new PluginKey<PmSuggestionsState>('texpile-suggestions');

export function hasOldWords(r: PmSuggestionRange): boolean {
	return !!r.restore && !r.partial && !r.format && r.old.length > 0;
}

export function struckAt(state: EditorState, at: number): PmSuggestionRange[] {
	return (pmSuggestionsKey.getState(state)?.ranges ?? []).filter((r) => hasOldWords(r) && r.from === at);
}

/** ids of the old words a range selection runs across */
export function oldWordsInSelection(state: EditorState): Set<string> {
	const { from, to, empty } = state.selection;
	const ids = new Set<string>();
	if (empty) return ids;
	for (const r of pmSuggestionsKey.getState(state)?.ranges ?? []) {
		if (!hasOldWords(r)) continue;
		// at an end of the range the old words are inside it only when drawn on its side of the caret
		if ((r.from > from && r.from < to) || r.from === (typingSide(r) === 'before' ? from : to)) ids.add(r.id);
	}
	return ids;
}
