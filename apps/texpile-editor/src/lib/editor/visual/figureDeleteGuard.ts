// Backspace at the start of the block after a figure, and Delete at the end of the block before
// one, select the figure instead of acting on it. ProseMirror's joinBackward would otherwise pull
// the paragraph into the figure's caption (LaTeX, Typst) or, where the figure holds no caption,
// delete it outright (Markdown): one keystroke, no selection shown, the file loses its
// \includegraphics. A selected figure is deleted by the next Backspace, which is visible and
// undoable in the ordinary way.
import { NodeSelection, type EditorState, type Transaction } from 'prosemirror-state';
import type { ResolvedPos } from 'prosemirror-model';

const GUARDED = new Set(['image']);

/** the position of the boundary between the cursor's textblock and the block before it, when the
 *  cursor sits at the very start of its textblock (mirrors prosemirror-commands' findCutBefore) */
function cutBefore($pos: ResolvedPos): ResolvedPos | null {
	if (!$pos.parent.type.spec.isolating)
		for (let i = $pos.depth - 1; i >= 0; i--) {
			if ($pos.index(i) > 0) return $pos.doc.resolve($pos.before(i + 1));
			if ($pos.node(i).type.spec.isolating) break;
		}
	return null;
}

function cutAfter($pos: ResolvedPos): ResolvedPos | null {
	if (!$pos.parent.type.spec.isolating)
		for (let i = $pos.depth - 1; i >= 0; i--) {
			const parent = $pos.node(i);
			if ($pos.index(i) + 1 < parent.childCount) return $pos.doc.resolve($pos.after(i + 1));
			if (parent.type.spec.isolating) break;
		}
	return null;
}

export function selectFigureBackward(state: EditorState, dispatch?: (tr: Transaction) => void): boolean {
	const { $cursor } = state.selection as { $cursor?: ResolvedPos | null };
	if (!$cursor || $cursor.parentOffset > 0) return false;
	const $cut = cutBefore($cursor);
	const before = $cut?.nodeBefore;
	if (!$cut || !before || !GUARDED.has(before.type.name)) return false;
	if (dispatch) dispatch(state.tr.setSelection(NodeSelection.create(state.doc, $cut.pos - before.nodeSize)).scrollIntoView());
	return true;
}

export function selectFigureForward(state: EditorState, dispatch?: (tr: Transaction) => void): boolean {
	const { $cursor } = state.selection as { $cursor?: ResolvedPos | null };
	if (!$cursor || $cursor.parentOffset < $cursor.parent.content.size) return false;
	const $cut = cutAfter($cursor);
	const after = $cut?.nodeAfter;
	if (!$cut || !after || !GUARDED.has(after.type.name)) return false;
	if (dispatch) dispatch(state.tr.setSelection(NodeSelection.create(state.doc, $cut.pos)).scrollIntoView());
	return true;
}
