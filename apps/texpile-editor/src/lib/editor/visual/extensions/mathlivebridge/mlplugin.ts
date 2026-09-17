import { Plugin, PluginKey, type PluginSpec } from 'prosemirror-state';
import { EditorView, type NodeViewConstructor } from 'prosemirror-view';
import type { Node } from 'prosemirror-model';
import { MathLiveView } from './mlview.svelte';

export type MathLivePluginState = {
	/** cursor pos before entering a math node, decides front vs back placement on expand. */
	prevCursorPos: number;
};
const MATHLIVE_PLUGIN_KEY = new PluginKey<MathLivePluginState>('prosemirror-mathlive');

const mathPluginSpec: PluginSpec<MathLivePluginState> = {
	key: MATHLIVE_PLUGIN_KEY,
	state: {
		init() {
			return {
				prevCursorPos: 0
			};
		},
		apply(tr, value, oldState) {
			return {
				prevCursorPos: oldState.selection.from
			};
		}
	},
	props: {
		nodeViews: {
			inline_math: createMathView(false),
			block_math: createMathView(true)
		},
		handleClickOn(view, _pos, node, nodePos, event, direct) {
			const me = event as MouseEvent;
			if (!direct || me.button !== 0 || me.shiftKey || me.metaKey || me.ctrlKey || me.altKey) return false;
			if (node.isTextblock && node.type.name === 'paragraph') {
				const onlyMathfieldOrEmpty = node.childCount == 1 && node.child(0).type.name === 'inline_math';

				if (onlyMathfieldOrEmpty) {
					console.log('Placed Cursor at end of paragraph with only math fields');
					const endPos = nodePos + node.nodeSize - 1; // last valid text position inside the paragraph
					const tr = view.state.tr.setSelection(TextSelection.create(view.state.doc, endPos));
					view.dispatch(tr);
					view.focus();
					return true;
				}
			}
			return false;
		}
	}
};

export const mathlivePlugin = new Plugin(mathPluginSpec);

export function createMathView(displayMode: boolean): NodeViewConstructor {
	return (node: Node, view: EditorView, getPos: boolean | (() => number | undefined)): MathLiveView => {
		const nodeView = new MathLiveView(node, view, getPos as () => number, MATHLIVE_PLUGIN_KEY, displayMode);

		return nodeView;
	};
}

import { keydownHandler } from 'prosemirror-keymap';
import { NodeSelection, TextSelection, EditorState, Transaction } from 'prosemirror-state';
import { verticalArrowKeyDown, verticalArrowsAfterUpdate, verticalArrowsMouseDown } from './mlVerticalArrows';

// selects an adjacent mathfield on left/right when there is no text node between it and the cursor.
function mlHorizontalArrowHandler(dir: 'left' | 'right') {
	return (state: EditorState, dispatch?: (tr: Transaction) => void): boolean => {
		const { $from, empty } = state.selection;
		if (!empty) return false;

		const parent = $from.parent;
		if (parent.type.name !== 'paragraph') return false;

		const indexInParent = $from.index();

		if (dir === 'right') {
			if (indexInParent < parent.childCount) {
				const nextChild = parent.child(indexInParent);
				if (nextChild.type.name === 'inline_math') {
					const offsetInParent = $from.parentOffset;
					let posBeforeNext = 0;
					for (let i = 0; i < indexInParent; i++) {
						posBeforeNext += parent.child(i).nodeSize;
					}
					if (offsetInParent === posBeforeNext) {
						const mathPos = $from.before() + 1 + posBeforeNext;
						const tr = state.tr.setSelection(NodeSelection.create(state.doc, mathPos));
						dispatch?.(tr);
						return true;
					}
				}
			}
		} else {
			if (indexInParent > 0) {
				const prevChild = parent.child(indexInParent - 1);
				if (prevChild.type.name === 'inline_math') {
					const offsetInParent = $from.parentOffset;
					let posAfterPrev = 0;
					for (let i = 0; i < indexInParent; i++) {
						posAfterPrev += parent.child(i).nodeSize;
					}
					if (offsetInParent === posAfterPrev) {
						const mathPos = $from.before() + 1 + posAfterPrev - prevChild.nodeSize;
						const tr = state.tr.setSelection(NodeSelection.create(state.doc, mathPos));
						dispatch?.(tr);
						return true;
					}
				}
			}
		}

		return false;
	};
}

const horizontalArrowKeyDown = keydownHandler({
	ArrowRight: mlHorizontalArrowHandler('right'),
	ArrowLeft: mlHorizontalArrowHandler('left')
});

/** must come before the regular keymap in plugin order. */
export const mlarrowHandlers = new Plugin({
	props: {
		handleKeyDown: (view, event) => verticalArrowKeyDown(view, event) || horizontalArrowKeyDown(view, event),
		handleDOMEvents: { mousedown: verticalArrowsMouseDown }
	},
	view: () => ({
		update: (view, before) => verticalArrowsAfterUpdate(view, !view.state.selection.eq(before.selection))
	})
});
