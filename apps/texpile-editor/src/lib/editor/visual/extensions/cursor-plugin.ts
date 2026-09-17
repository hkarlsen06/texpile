// selection-driven UI: shades what a range selection crosses and the browser won't paint (CM-backed
// leaves, a suggestion's old words), and syncs the cursorInCm store the menu bar uses to disable
// commands that would eat raw blocks.
import { NodeSelection, Plugin, PluginKey } from 'prosemirror-state';
import type { EditorState } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';
import { cursorInCm } from '$lib/stores/editorStore';
import { oldWordsInSelection } from './pmSuggestionsState';
import { selectionBandPainter } from './selectionBands';

const CM_NODE_TYPES = new Set(['raw_latex', 'code_block', 'block_math']);

// inline forms and the widget blocks get the range highlight but don't participate in store
// sync. Membership = "the browser paints no native selection over it": includedoc and the
// figure container are contenteditable=false, an <hr> has no text to paint. Chips (citation,
// ref, typ_ref) are plain inline spans the browser paints on its own, so they stay out.
const HIGHLIGHT_NODE_TYPES = new Set([...CM_NODE_TYPES, 'inline_math', 'inline_latex', 'includedoc', 'horizontal_rule', 'image']);

/** a range selection fully inside one of these is editing its content, not crossing it
 *  (the CM islands, and a figure whose caption is being selected through the contentDOM hole) */
const EDITABLE_CM_TYPES = new Set(['code_block', 'raw_latex', 'inline_latex', 'image']);

function isCursorInCm(state: EditorState): boolean {
	const $from = state.selection.$from;
	for (let d = $from.depth; d >= 0; d--) {
		if (CM_NODE_TYPES.has($from.node(d).type.name)) return true;
	}
	return false;
}

function buildDecorations(state: EditorState, bands: string): DecorationSet {
	if (state.selection.empty) return DecorationSet.empty;

	const decorations: Decoration[] = [];
	const { from, to } = state.selection;
	const isNodeSelection = state.selection instanceof NodeSelection;
	state.doc.nodesBetween(from, to, (node, pos) => {
		const start = pos;
		const end = pos + node.nodeSize;
		if (start === end || node.isText) return;
		if (!HIGHLIGHT_NODE_TYPES.has(node.type.name)) return;
		// already visually selected by the NodeSelection
		if (isNodeSelection && from === start && to === end) return;
		// fully inside an editable CM: editing, not crossing
		if (EDITABLE_CM_TYPES.has(node.type.name) && from >= start && to <= end) return;
		// pm-selected-node wears the SAME --editor-selection colour as native ::selection (app.css):
		// this shade exists to look like the selection continuing across the node, and the old
		// opaque Tailwind blue read as patchwork against the translucent native highlight
		// data-band names an inline one for selectionBands.ts, which stretches its shade to the line box
		const band = node.isInline ? { 'data-band': `${bands}-${start}` } : {};
		decorations.push(Decoration.node(start, end, { class: 'pm-selected-node', ...band }));
	});

	return decorations.length ? DecorationSet.create(state.doc, decorations) : DecorationSet.empty;
}

// a suggestion's old words are a widget, which no decoration reaches: the class goes on the element
function shadeOldWords(view: EditorView, bands: string, shadedBefore: boolean): boolean {
	const crossed = oldWordsInSelection(view.state);
	if (crossed.size === 0 && !shadedBefore) return false;
	for (const el of view.dom.querySelectorAll<HTMLElement>('.pm-suggest-old')) {
		const id = el.dataset.comment ?? '';
		el.classList.toggle('pm-selected-node', crossed.has(id));
		if (crossed.has(id)) el.dataset.band = `${bands}-old-${id}`;
		else delete el.dataset.band;
	}
	return crossed.size > 0;
}

export const cursorPluginKey = new PluginKey('cursor');

let cursorPlugins = 0;

export function createCursorPlugin() {
	// band names stay apart when two editors are open side by side
	const bands = `band${++cursorPlugins}`;
	return new Plugin({
		key: cursorPluginKey,
		props: {
			decorations(state) {
				try {
					return buildDecorations(state, bands);
				} catch {
					return DecorationSet.empty;
				}
			}
		},
		// cursorInCm sync: cheaper as a view() diff than a decorations() rebuild
		view(view) {
			let last = isCursorInCm(view.state);
			cursorInCm.current = last;
			let oldWordsShaded = false;
			const painter = selectionBandPainter(view);
			return {
				update(v) {
					oldWordsShaded = shadeOldWords(v, bands, oldWordsShaded);
					painter.repaint();
					const cur = isCursorInCm(v.state);
					if (cur !== last) {
						last = cur;
						cursorInCm.current = cur;
					}
				},
				destroy() {
					painter.destroy();
					// reset so a stale true doesn't keep the menus disabled
					cursorInCm.current = false;
				}
			};
		}
	});
}
