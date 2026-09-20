// drawn chips as atoms: the keys select one whole, or step over and delete it like a letter when it stands in the text as
// one (a space, an accented letter); Enter opens a selected chip's panel. The schema cannot say so: the chips are
// atoms only while drawn, and comments and suggestions read the schema's atoms as having no text
import { NodeSelection, Plugin, TextSelection, type EditorState, type Transaction } from 'prosemirror-state';
import type { Node } from 'prosemirror-model';
import type { EditorView } from 'prosemirror-view';
import { drawnChipOf } from './DrawnChipView';
import { landBesideOldWords, oldWordsAhead } from '$lib/editor/visual/extensions/pmOldWordsCaret';

type Side = -1 | 1;

function select(view: EditorView, tr: Transaction): true {
	view.dispatch(tr.scrollIntoView());
	return true;
}

/** the drawn chip beside an empty caret, inline in its line or the block across its textblock's edge */
function chipBeside(state: EditorState, side: Side, acrossBlocks: boolean): { node: Node; pos: number } | null {
	const { selection } = state;
	if (!(selection instanceof TextSelection) || !selection.empty) return null;
	const $head = selection.$head;
	const inline = side < 0 ? $head.nodeBefore : $head.nodeAfter;
	if (inline && drawnChipOf(inline)) return { node: inline, pos: side < 0 ? $head.pos - inline.nodeSize : $head.pos };
	if (!acrossBlocks || $head.depth === 0) return null;
	const atEdge = side < 0 ? $head.parentOffset === 0 : $head.parentOffset === $head.parent.content.size;
	if (!atEdge) return null;
	const $edge = state.doc.resolve(side < 0 ? $head.before() : $head.after());
	const node = side < 0 ? $edge.nodeBefore : $edge.nodeAfter;
	return node && drawnChipOf(node) ? { node, pos: side < 0 ? $edge.pos - node.nodeSize : $edge.pos } : null;
}

// the browser moves the caret up and down itself, and passes over a chip it cannot put the caret in. The move is kept
// until ProseMirror reads where the caret went; one on a line of its own that the caret passed is selected instead
type VerticalMove = { from: number; side: Side; until: number };
const moving = new WeakMap<EditorView, VerticalMove>();

function passedLine(state: EditorState, move: VerticalMove): number | undefined {
	const { selection, doc } = state;
	if (!(selection instanceof TextSelection) || !selection.empty || (selection.head - move.from) * move.side <= 0) return undefined;
	const low = Math.min(move.from, selection.head);
	const high = Math.max(move.from, selection.head);
	const passed: number[] = [];
	doc.nodesBetween(low, high, (node, pos) => {
		const chip = drawnChipOf(node);
		if (chip?.ownLine && pos >= low && pos + node.nodeSize <= high) passed.push(pos);
		return !chip;
	});
	return move.side > 0 ? passed[0] : passed[passed.length - 1];
}

function stopOnPassedLine(view: EditorView, previous: EditorState): void {
	const move = moving.get(view);
	if (!move || view.state.selection.eq(previous.selection)) return;
	moving.delete(view);
	if (Date.now() > move.until) return;
	const pos = passedLine(view.state, move);
	if (pos === undefined) return;
	queueMicrotask(() => view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, pos)).scrollIntoView()));
}

function selectedChip(state: EditorState) {
	const { selection } = state;
	return selection instanceof NodeSelection ? drawnChipOf(selection.node) : null;
}

function onKey(view: EditorView, event: KeyboardEvent): boolean {
	if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return false;
	const { state } = view;
	const side: Side = event.key === 'ArrowLeft' || event.key === 'ArrowUp' || event.key === 'Backspace' ? -1 : 1;
	switch (event.key) {
		case 'Enter': {
			const chip = selectedChip(state);
			if (!chip || event.shiftKey) return false;
			chip.openPanel();
			return true;
		}
		case 'ArrowLeft':
		case 'ArrowRight': {
			if (event.shiftKey || oldWordsAhead(state, side > 0)) return false;
			const beside = chipBeside(state, side, false);
			if (!beside || !drawnChipOf(beside.node)?.character) return false;
			const past = side < 0 ? beside.pos : beside.pos + beside.node.nodeSize;
			return select(view, landBesideOldWords(state, state.tr.setSelection(TextSelection.create(state.doc, past)), past, side > 0));
		}
		case 'ArrowUp':
		case 'ArrowDown': {
			// from the far edge of a selected chip, which is not one the caret passes
			const from = side > 0 ? state.selection.to : state.selection.from;
			if (!event.shiftKey) moving.set(view, { from, side, until: Date.now() + 500 });
			return false;
		}
		case 'Backspace':
		case 'Delete': {
			if (event.shiftKey) return false;
			const beside = chipBeside(state, side, true);
			if (!beside) return false;
			// a letter goes at once; anything bigger is selected first, so one key never takes a footnote's whole text
			if (drawnChipOf(beside.node)?.character) return select(view, state.tr.delete(beside.pos, beside.pos + beside.node.nodeSize));
			return select(view, state.tr.setSelection(NodeSelection.create(state.doc, beside.pos)));
		}
	}
	return false;
}

export function drawnChipAtomsPlugin(): Plugin {
	return new Plugin({
		props: { handleKeyDown: onKey },
		view: () => ({ update: stopOnPassedLine }),
		// a caret placed inside a drawn chip's text (a search match, a caret moved near it) takes the chip whole
		appendTransaction(transactions, _old, state) {
			if (!transactions.some((tr) => tr.selectionSet || tr.docChanged)) return null;
			const { $from } = state.selection;
			if (!(state.selection instanceof TextSelection) || $from.depth === 0) return null;
			if (!drawnChipOf($from.parent)) return null;
			return state.tr.setSelection(NodeSelection.create(state.doc, $from.before()));
		}
	});
}
