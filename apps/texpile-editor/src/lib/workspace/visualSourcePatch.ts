// a source edit applied to the mounted visual editor as one undoable step
import type { EditorView as PMEditorView } from 'prosemirror-view';
import { computeBlockPatch, syncOrigAttrs } from '$lib/editor/visual/blockPatch';
import type { DocumentBuffer } from '$lib/workspace/documentBuffer.svelte';
import type { ParsedLatexFile } from '$lib/workspace/latexRoundtrip';

export async function patchVisualFromSource(
	view: PMEditorView,
	doc: DocumentBuffer,
	parse: (text: string) => Promise<ParsedLatexFile | null>,
	before: string,
	next: string
): Promise<boolean> {
	const parsed = await parse(next);
	if (!parsed || view.isDestroyed || doc.texSource !== before) return false;
	if (parsed.preamble !== doc.docMeta?.preamble || parsed.postamble !== doc.docMeta?.postamble) {
		doc.replaceSource(next, { dirty: true });
		return true;
	}
	const patch = computeBlockPatch(view.state.doc, parsed.doc);
	const tr = view.state.tr;
	if (patch) tr.replaceWith(patch.from, patch.to, patch.nodes);
	syncOrigAttrs(tr, parsed.doc);
	if (!tr.steps.length) return false;
	view.dispatch(tr);
	return true;
}
