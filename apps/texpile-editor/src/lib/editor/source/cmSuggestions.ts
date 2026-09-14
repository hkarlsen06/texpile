// suggestions drawn in the source editor
import { Decoration, EditorView, WidgetType, keymap, type DecorationSet } from '@codemirror/view';
import {
	EditorSelection,
	Prec,
	StateEffect,
	StateField,
	RangeSet,
	type EditorState,
	type Extension,
	type Range,
	type Transaction
} from '@codemirror/state';
import { editMode, mapSuggestionEdges, noteTypedSide, typingSide, type SuggestionMark } from '$lib/comments/activeSuggestions.svelte';
import { clickedSide, sideAtOldWords, type CaretSide } from '$lib/comments/oldWordsCaret';
import type { EditMode, TypingSide } from '$lib/comments/suggestCompare';

export type SuggestionRange = { id: string; from: number; to: number; restore: string; mine: boolean };

export const setSuggestionRanges = StateEffect.define<SuggestionRange[]>();
export const focusSuggestion = StateEffect.define<string | null>();
export const setCaretSide = StateEffect.define<CaretSide | null>();

const caretSide = StateField.define<CaretSide | null>({
	create: () => null,
	update(caret, tr) {
		for (const e of tr.effects) if (e.is(setCaretSide)) return e.value;
		if (!caret) return caret;
		const at = tr.changes.mapPos(caret.at, caret.side === 'before' ? 1 : -1);
		const sel = tr.newSelection;
		if (sel.ranges.length > 1 || !sel.main.empty || sel.main.head !== at) return null;
		return at === caret.at ? caret : { ...caret, at };
	}
});

function typedAtCaret(tr: Transaction): CaretSide | null {
	const caret = tr.startState.field(caretSide, false);
	return caret && tr.changes.mapPos(caret.at, -1) !== tr.changes.mapPos(caret.at, 1) ? caret : null;
}

const focused = StateField.define<string | null>({
	create: () => null,
	update(id, tr) {
		for (const e of tr.effects) if (e.is(focusSuggestion)) return e.value;
		return id;
	}
});

const ranges = StateField.define<SuggestionRange[]>({
	create: () => [],
	update(value, tr) {
		for (const e of tr.effects)
			if (e.is(setSuggestionRanges)) return e.value.filter((r) => r.from >= 0 && r.to >= r.from && r.to <= tr.newDoc.length);
		if (!tr.docChanged) return value;
		const typed = typedAtCaret(tr);
		return value.flatMap((r) => {
			const side = typed && r.restore && r.from === typed.at ? typed.side : undefined;
			if (side) noteTypedSide(r.id, side);
			return mapSuggestionEdges(r, (pos, assoc) => tr.changes.mapPos(pos, assoc), side);
		});
	}
});

class OldWords extends WidgetType {
	constructor(
		private readonly text: string,
		private readonly id: string,
		private readonly focus: boolean
	) {
		super();
	}
	override eq(other: OldWords): boolean {
		return other.text === this.text && other.id === this.id && other.focus === this.focus;
	}
	toDOM(): HTMLElement {
		const span = document.createElement('span');
		span.className = `cm-suggest-old${this.focus ? ' cm-suggest-focused' : ''}`;
		span.dataset.comment = this.id;
		span.append(document.createElement('wbr'), this.text, document.createElement('wbr'));
		return span;
	}
	override ignoreEvent(): boolean {
		return false;
	}
}

type DrawnSuggestions = { set: DecorationSet; mode: EditMode };

const decorations = StateField.define<DrawnSuggestions>({
	create: (state) => build(state),
	update(drawn, tr) {
		const changed =
			tr.docChanged ||
			tr.effects.some((e) => e.is(setSuggestionRanges) || e.is(focusSuggestion)) ||
			tr.startState.field(caretSide, false) !== tr.state.field(caretSide, false);
		return changed || drawn.mode !== editMode.current ? build(tr.state) : drawn;
	},
	provide: (f) => EditorView.decorations.from(f, (drawn) => drawn.set)
});

function build(state: EditorState): DrawnSuggestions {
	const focus = state.field(focused, false) ?? null;
	const caret = state.field(caretSide, false) ?? null;
	const out = [];
	for (const r of state.field(ranges, false) ?? []) {
		const on = r.id === focus;
		const side = caret?.at === r.from ? caret.side : typingSide(r);
		if (r.restore)
			out.push(Decoration.widget({ widget: new OldWords(r.restore, r.id, on), side: side === 'after' ? -1 : 1 }).range(r.from));
		if (r.to > r.from) {
			out.push(
				Decoration.mark({ class: `cm-suggest-new${on ? ' cm-suggest-focused' : ''}`, attributes: { 'data-comment': r.id } }).range(
					r.from,
					r.to
				)
			);
		}
	}
	return { set: RangeSet.of(out, true), mode: editMode.current };
}

const NONE: SuggestionRange[] = [];

export function liveSuggestionRanges(state: EditorState): SuggestionRange[] {
	return state.field(ranges, false) ?? NONE;
}

export function fitsSuggestion(state: EditorState, s: SuggestionMark): boolean {
	const { prefix, quote, suffix } = s.anchor;
	return (
		s.from >= prefix.length &&
		s.to + suffix.length <= state.doc.length &&
		state.sliceDoc(s.from - prefix.length, s.to + suffix.length) === prefix + quote + suffix
	);
}

export function clearOfOldWords(set: DecorationSet, state: EditorState): DecorationSet {
	const cuts = liveSuggestionRanges(state)
		.filter((r) => r.restore)
		.map((r) => r.from);
	if (cuts.length === 0 || set.size === 0) return set;
	const out: Range<Decoration>[] = [];
	for (let it = set.iter(); it.value; it.next()) {
		let from = it.from;
		for (const cut of cuts.filter((c) => c > it.from && c < it.to).sort((a, b) => a - b)) {
			out.push(it.value.range(from, cut));
			from = cut;
		}
		out.push(it.value.range(from, it.to));
	}
	return Decoration.set(out, true);
}

export function suggestionAt(state: EditorState, pos: number): SuggestionRange | null {
	return liveSuggestionRanges(state).find((r) => pos >= r.from && pos <= r.to) ?? null;
}

function struckAt(state: EditorState, at: number): SuggestionRange[] {
	return liveSuggestionRanges(state).filter((r) => r.restore && r.from === at);
}

function stepAtOldWords(forward: boolean) {
	return (view: EditorView): boolean => {
		const { state } = view;
		const sel = state.selection;
		if (sel.ranges.length > 1 || !sel.main.empty) return false;
		const here = sel.main.head;
		const want: TypingSide = forward ? 'after' : 'before';
		const struck = struckAt(state, here);
		if (struck.length && sideAtOldWords(state.field(caretSide, false) ?? null, here, struck.map(typingSide)) !== want) {
			view.dispatch({ effects: setCaretSide.of({ at: here, side: want }) });
			return true;
		}
		const next = view.moveByChar(sel.main, forward).head;
		if (next === here || struckAt(state, next).length === 0) return false;
		view.dispatch({
			selection: EditorSelection.cursor(next),
			effects: setCaretSide.of({ at: next, side: forward ? 'before' : 'after' }),
			scrollIntoView: true,
			userEvent: 'select'
		});
		return true;
	};
}

const caretControls = [
	Prec.high(
		keymap.of([
			{ key: 'ArrowLeft', run: stepAtOldWords(false) },
			{ key: 'ArrowRight', run: stepAtOldWords(true) }
		])
	),
	EditorView.domEventHandlers({
		click(e, view) {
			const sel = view.state.selection.main;
			const ids = new Set(sel.empty ? struckAt(view.state, sel.head).map((r) => r.id) : []);
			if (ids.size === 0) return false;
			const words = [...view.contentDOM.querySelectorAll<HTMLElement>('.cm-suggest-old')].filter((el) => ids.has(el.dataset.comment ?? ''));
			const side = clickedSide(words, e.clientX, e.clientY);
			if (side) view.dispatch({ effects: setCaretSide.of({ at: sel.head, side }) });
			return false;
		}
	})
];

export function cmSuggestions(): Extension {
	return [focused, caretSide, ranges, decorations, caretControls, theme];
}

const theme = EditorView.baseTheme({
	'.cm-suggest-new': {
		backgroundColor: 'color-mix(in srgb, var(--diff-insert-tint) 18%, transparent)'
	},
	'.cm-suggest-old': {
		backgroundColor: 'color-mix(in srgb, var(--diff-delete-tint) 16%, transparent)',
		textDecoration: 'line-through',
		color: 'color-mix(in srgb, currentColor 70%, transparent)'
	},
	'.cm-suggest-new.cm-suggest-focused': {
		backgroundColor: 'color-mix(in srgb, var(--diff-insert-tint) 34%, transparent)'
	},
	'.cm-suggest-old.cm-suggest-focused': {
		backgroundColor: 'color-mix(in srgb, var(--diff-delete-tint) 30%, transparent)'
	}
});
