// Landing a re-parsed remote document in the live view: replace only the block range that
// changed, carry a caret inside it through the file, and hold the topmost visible line still so
// the patch never reads as a scroll jump.
import { TextSelection } from 'prosemirror-state';
import type { EditorView as PMEditorView } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import { adoptParse, type ParseOrigins, type SourceMap } from '$lib/editor/visual/sourceSpans';
import { offsetAtPm, pmAtOffset } from '$lib/editor/visual/sourceMap';
import { computeBlockPatch, protectCaretBlock, syncParseAttrs } from '$lib/editor/visual/blockPatch';
import { spliceDiff } from './materialize';

// same walk as EditorView's doc-swap helper: the pane that actually scrolls the editor
function scrollParent(el: HTMLElement | null): HTMLElement | null {
	let cur = el?.parentElement ?? null;
	while (cur) {
		const oy = getComputedStyle(cur).overflowY;
		if ((oy === 'auto' || oy === 'scroll') && cur.scrollHeight > cur.clientHeight) return cur;
		cur = cur.parentElement;
	}
	return null;
}

/** `oldMap` is the live doc's map of `oldSource`, `newMap` the parse's map of `newSource` and
 *  `origins` what that parse knew about its blocks */
export function applyRemotePatch(
	v: PMEditorView,
	parsedDoc: PMNode,
	oldMap: SourceMap,
	newMap: SourceMap,
	origins: ParseOrigins,
	oldSource: string,
	newSource: string
): void {
	// the block being typed in must not lose its in-progress tail to the re-parse: trailing
	// whitespace and still-empty paragraphs don't survive serialize->parse in any dialect
	const newDoc = protectCaretBlock(v.state.doc, parsedDoc, v.state.selection.head);
	const patch = computeBlockPatch(v.state.doc, newDoc);
	// caret inside the replaced range: carry it through the file (outside it, PM maps it)
	let srcOffset: number | null = null;
	const head = v.state.selection.head;
	if (patch && head > patch.from && head < patch.to) {
		srcOffset = offsetAtPm(oldMap, head);
		const d = srcOffset != null ? spliceDiff(oldSource, newSource) : null;
		if (d && srcOffset != null && srcOffset > d.index) {
			// across the remote edit itself, so the offset means the same place in the new text
			srcOffset = srcOffset >= d.index + d.remove ? srcOffset + d.insert.length - d.remove : d.index + d.insert.length;
		}
	}
	const tr = v.state.tr;
	if (patch) tr.replaceWith(patch.from, patch.to, patch.nodes);
	syncParseAttrs(tr, newDoc);
	if (!tr.steps.length) {
		// the same content, perhaps from other bytes: the document is the parse's all the same
		adoptParse(v.state.doc, origins);
		return;
	}
	tr.setMeta('addToHistory', false).setMeta('collabRemotePatch', true);
	if (srcOffset != null) {
		const pos = pmAtOffset(newMap, srcOffset);
		if (pos != null) tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(pos, tr.doc.content.size))));
	}
	// Hold the view still across the patch: replacing blocks changes heights, and everything
	// below a resized block shifts on screen - the "jump". Anchor the topmost visible position
	// before the dispatch and give the shift back to the scroller after, so the line the user
	// is looking at stays put whether the patch landed above, below, or at the caret. Covers
	// remote edits too: a collaborator editing above your viewport no longer moves your view.
	const scroller = scrollParent(v.dom);
	let anchor: { pos: number; top: number } | null = null;
	if (scroller) {
		try {
			const rect = scroller.getBoundingClientRect();
			const probe = v.posAtCoords({ left: rect.left + rect.width / 2, top: rect.top + 1 });
			if (probe) anchor = { pos: probe.pos, top: v.coordsAtPos(probe.pos).top };
		} catch {
			anchor = null; // no coords for the probe; the patch applies without compensation
		}
	}
	v.dispatch(tr);
	// the patched document is the parse's from here on: its kept blocks equal the parse's, its new
	// ones are the parse's own, and a grafted caret block is the one that regenerates
	adoptParse(v.state.doc, origins);
	if (scroller && anchor) {
		try {
			const mapped = Math.min(tr.mapping.map(anchor.pos), v.state.doc.content.size);
			const dy = v.coordsAtPos(mapped).top - anchor.top;
			if (dy !== 0) scroller.scrollTop += dy;
		} catch {
			/* the anchor vanished in the restructure; leave the scroll where the browser put it */
		}
	}
}
