// suggestions drawn in the visual editor
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import type { PmSuggestionRange } from './pmSuggestionsPlace';
import { editMode, mapSuggestionEdges, noteTypedSide, typingSide } from '$lib/comments/activeSuggestions.svelte';
import { clickedSide, sideAtOldWords, type CaretSide } from '$lib/comments/oldWordsCaret';
import type { EditMode, TypingSide } from '$lib/comments/suggestCompare';

type PmSuggestionsState = {
	ranges: PmSuggestionRange[];
	focused: string | null;
	caret: CaretSide | null;
	deco: DecorationSet;
	mode: EditMode;
};
type PmSuggestionsMeta =
	{ type: 'set'; ranges: PmSuggestionRange[] } | { type: 'focus'; id: string | null } | { type: 'caret'; caret: CaretSide | null };

export const pmSuggestionsKey = new PluginKey<PmSuggestionsState>('texpile-suggestions');

export function setPmSuggestions(view: EditorView, ranges: PmSuggestionRange[]): void {
	view.dispatch(
		view.state.tr.setMeta(pmSuggestionsKey, { type: 'set', ranges } satisfies PmSuggestionsMeta).setMeta('addToHistory', false)
	);
}

export function focusPmSuggestionMeta(id: string | null): PmSuggestionsMeta {
	return { type: 'focus', id };
}

function oldWords(text: string, id: string, focused: boolean): HTMLElement {
	const span = document.createElement('span');
	span.className = `pm-suggest-old${focused ? ' pm-suggest-focused' : ''}`;
	span.dataset.comment = id;
	span.textContent = text;
	return span;
}

function build(doc: PMNode, ranges: PmSuggestionRange[], focused: string | null, caret: CaretSide | null): DecorationSet {
	const size = doc.content.size;
	const decos: Decoration[] = [];
	for (const r of ranges) {
		if (r.from < 0 || r.to > size || r.to < r.from) continue;
		const on = r.id === focused;
		const focus = on ? ' pm-suggest-focused' : '';
		if (r.partial) {
			doc.nodesBetween(r.from, r.to, (node, pos) => {
				decos.push(Decoration.node(pos, pos + node.nodeSize, { class: `pm-suggest-partial${focus}`, 'data-comment': r.id }));
				return false;
			});
			continue;
		}
		if (r.restore) {
			const { restore, id } = r;
			const side = caret?.at === r.from ? caret.side : typingSide(r);
			decos.push(
				Decoration.widget(r.from, () => oldWords(restore, id, on), {
					side: side === 'after' ? -1 : 1,
					ignoreSelection: true,
					key: `old-${id}-${on}-${side}-${restore}`
				})
			);
		}
		if (r.to > r.from) decos.push(Decoration.inline(r.from, r.to, { class: `pm-suggest-new${focus}`, 'data-comment': r.id }));
	}
	return DecorationSet.create(doc, decos);
}

export function pmSuggestionAt(state: EditorState, pos: number): PmSuggestionRange | null {
	return (pmSuggestionsKey.getState(state)?.ranges ?? []).find((r) => pos >= r.from && pos <= r.to) ?? null;
}

function struckAt(state: EditorState, at: number): PmSuggestionRange[] {
	return (pmSuggestionsKey.getState(state)?.ranges ?? []).filter((r) => r.restore && !r.partial && r.from === at);
}

function setCaret(view: EditorView, caret: CaretSide, tr: Transaction = view.state.tr): void {
	view.dispatch(tr.setMeta(pmSuggestionsKey, { type: 'caret', caret } satisfies PmSuggestionsMeta));
}

function stepAtOldWords(view: EditorView, forward: boolean): boolean {
	const { state } = view;
	const sel = state.selection;
	if (!(sel instanceof TextSelection) || !sel.empty) return false;
	const here = sel.head;
	const want: TypingSide = forward ? 'after' : 'before';
	const struck = struckAt(state, here);
	if (struck.length && sideAtOldWords(pmSuggestionsKey.getState(state)?.caret ?? null, here, struck.map(typingSide)) !== want) {
		setCaret(view, { at: here, side: want });
		return true;
	}
	const next = here + (forward ? 1 : -1);
	const $here = sel.$head;
	if (next < $here.start() || next > $here.end() || struckAt(state, next).length === 0) return false;
	const between = state.doc.textBetween(Math.min(here, next), Math.max(here, next), '', '￼');
	if (/[\uD800-\uDFFF]/.test(between)) return false;
	setCaret(
		view,
		{ at: next, side: forward ? 'before' : 'after' },
		state.tr.setSelection(TextSelection.create(state.doc, next)).scrollIntoView()
	);
	return true;
}

export function pmSuggestions(): Plugin<PmSuggestionsState> {
	return new Plugin<PmSuggestionsState>({
		key: pmSuggestionsKey,
		state: {
			init: () => ({ ranges: [], focused: null, caret: null, deco: DecorationSet.empty, mode: editMode.current }),
			apply(tr, value) {
				const meta = tr.getMeta(pmSuggestionsKey) as PmSuggestionsMeta | undefined;
				const mode = editMode.current;
				if (meta?.type === 'set')
					return { ...value, ranges: meta.ranges, deco: build(tr.doc, meta.ranges, value.focused, value.caret), mode };
				if (meta?.type === 'focus') return { ...value, focused: meta.id, deco: build(tr.doc, value.ranges, meta.id, value.caret), mode };
				if (meta?.type === 'caret')
					return { ...value, caret: meta.caret, deco: build(tr.doc, value.ranges, value.focused, meta.caret), mode };
				const was = value.caret;
				const typed = was && tr.docChanged && tr.mapping.map(was.at, -1) !== tr.mapping.map(was.at, 1) ? was : null;
				let caret = was;
				if (caret) {
					const at = tr.mapping.map(caret.at, caret.side === 'before' ? 1 : -1);
					caret = tr.selection.empty && tr.selection.head === at ? (at === caret.at ? caret : { ...caret, at }) : null;
				}
				if (!tr.docChanged) {
					if (value.mode === mode && caret === was) return value;
					return { ...value, caret, deco: build(tr.doc, value.ranges, value.focused, caret), mode };
				}
				const ranges = value.ranges.flatMap((r) => {
					const side = typed && r.restore && !r.partial && r.from === typed.at ? typed.side : undefined;
					if (side) noteTypedSide(r.id, side);
					return mapSuggestionEdges(r, (pos, assoc) => tr.mapping.map(pos, assoc), side);
				});
				return { ...value, ranges, caret, deco: build(tr.doc, ranges, value.focused, caret), mode };
			}
		},
		props: {
			decorations: (state) => pmSuggestionsKey.getState(state)?.deco ?? DecorationSet.empty,
			handleKeyDown(view, event) {
				if (event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return false;
				if (event.key === 'ArrowLeft') return stepAtOldWords(view, false);
				if (event.key === 'ArrowRight') return stepAtOldWords(view, true);
				return false;
			},
			handleClick(view, pos, event) {
				const ids = new Set(struckAt(view.state, pos).map((r) => r.id));
				if (ids.size === 0) return false;
				const words = [...view.dom.querySelectorAll<HTMLElement>('.pm-suggest-old')].filter((el) => ids.has(el.dataset.comment ?? ''));
				const side = clickedSide(words, event.clientX, event.clientY);
				if (side) setCaret(view, { at: pos, side }, view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)));
				return false;
			}
		}
	});
}
