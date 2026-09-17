// suggestions drawn in the visual editor
import { Plugin, type EditorState } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import type { PmSuggestionRange } from './pmSuggestionsPlace';
import type { WordRun } from '$lib/comments/renderedWords';
import { editMode, mapSuggestionEdges, noteTypedSide, typingSide } from '$lib/comments/activeSuggestions.svelte';
import type { CaretSide } from '$lib/comments/oldWordsCaret';
import { caretSideWhereItLanded, oldWordsClick, oldWordsKeyDown } from './pmOldWordsCaret';
import { hasOldWords, pmSuggestionsKey, type PmSuggestionsMeta, type PmSuggestionsState } from './pmSuggestionsState';

export { pmSuggestionsKey };

export function setPmSuggestions(view: EditorView, ranges: PmSuggestionRange[]): void {
	view.dispatch(
		view.state.tr.setMeta(pmSuggestionsKey, { type: 'set', ranges } satisfies PmSuggestionsMeta).setMeta('addToHistory', false)
	);
}

export function focusPmSuggestionMeta(id: string | null): PmSuggestionsMeta {
	return { type: 'focus', id };
}

function oldWords(runs: WordRun[], id: string, focused: boolean): HTMLElement {
	const span = document.createElement('span');
	span.className = `pm-suggest-old${focused ? ' pm-suggest-focused' : ''}`;
	span.dataset.comment = id;
	for (const run of runs) {
		const node = run.tags.reduceRight<Node>((inner, tag) => {
			const outer = document.createElement(tag);
			// dressed like the link mark, without its target: these words are gone from the document
			if (tag === 'a') outer.className = 'anchor';
			outer.appendChild(inner);
			return outer;
		}, document.createTextNode(run.text));
		span.appendChild(node);
	}
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
		if (hasOldWords(r)) {
			const { old, id } = r;
			const side = caret?.at === r.from ? caret.side : typingSide(r);
			decos.push(
				Decoration.widget(r.from, () => oldWords(old, id, on), {
					side: side === 'after' ? -1 : 1,
					ignoreSelection: true,
					key: `old-${id}-${on}-${side}-${JSON.stringify(old)}`
				})
			);
		}
		if (r.to > r.from) {
			decos.push(Decoration.inline(r.from, r.to, { class: `pm-suggest-new${focus}`, 'data-comment': r.id }));
			// an inline formula keeps its source as content, so an inline decoration lands on text nobody draws
			doc.nodesBetween(r.from, r.to, (node, pos) => {
				if (node.isInline && node.isAtom && !node.isLeaf)
					decos.push(Decoration.node(pos, pos + node.nodeSize, { class: `pm-suggest-new${focus}` }));
				return !node.isAtom;
			});
		}
	}
	return DecorationSet.create(doc, decos);
}

export function pmSuggestionAt(state: EditorState, pos: number): PmSuggestionRange | null {
	return (pmSuggestionsKey.getState(state)?.ranges ?? []).find((r) => pos >= r.from && pos <= r.to) ?? null;
}

export function pmSuggestions(): Plugin<PmSuggestionsState> {
	let mounted: EditorView | null = null;
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
					const side = typed && hasOldWords(r) && r.from === typed.at ? typed.side : undefined;
					if (side) noteTypedSide(r.id, side);
					return mapSuggestionEdges(r, (pos, assoc) => tr.mapping.map(pos, assoc), side);
				});
				return { ...value, ranges, caret, deco: build(tr.doc, ranges, value.focused, caret), mode };
			}
		},
		appendTransaction: (trs, _before, state) => (mounted ? caretSideWhereItLanded(mounted, trs, state) : null),
		view(view) {
			mounted = view;
			return { destroy: () => (mounted = null) };
		},
		props: {
			decorations: (state) => pmSuggestionsKey.getState(state)?.deco ?? DecorationSet.empty,
			handleKeyDown: oldWordsKeyDown,
			handleClick: oldWordsClick
		}
	});
}
