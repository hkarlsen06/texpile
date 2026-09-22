// Refine wiring: the reader's selection as a span of the open file, and the suggestion path it lands through
import { SelectionRefiner, refiner } from '$lib/ai/selectionRefiner';
import { collabHost } from '$lib/collab/hostStore.svelte';
import { fileMode } from '$lib/workspace/fileMode.svelte';
import { editorViewStore, sourceCmView } from '$lib/stores/editorStore';
import { sourceAnchorFor } from '$lib/editor/visual/extensions/pmComments';
import { hasVisualMode, type DocumentBuffer, type FileKind } from '$lib/workspace/documentBuffer.svelte';
import type { ViewModeSwitch } from '$lib/workspace/viewModeSwitch.svelte';
import type { WorkspaceComments } from './workspaceComments.svelte';

type RefinerWiring = {
	comments: WorkspaceComments;
	doc: DocumentBuffer;
	modes: ViewModeSwitch;
	kind: () => FileKind;
	guest: () => boolean;
};

function selectionSpan(d: RefinerWiring): { from: number; to: number } | null {
	const text = d.comments.activeText();
	if (d.modes.mode === 'visual' && hasVisualMode(d.kind())) {
		const view = editorViewStore.current;
		const s = view?.state.selection;
		if (!view || !s || s.empty || text !== d.doc.texSource) return null;
		// exact at both ends or nothing: a span guessed wider would rewrite more than the reader chose
		const anchor = sourceAnchorFor(view.state.doc, d.doc.sourceMap, text, s.from, s.to);
		return anchor && anchor.end > anchor.start ? { from: anchor.start, to: anchor.end } : null;
	}
	const cm = sourceCmView.current;
	if (!cm || cm.state.doc.length !== text.length) return null;
	const { from, to } = cm.state.selection.main;
	return to > from ? { from, to } : null;
}

export function wireRefiner(d: RefinerWiring): void {
	const ctl = d.comments.ctl;
	const r = new SelectionRefiner({
		selection: () => selectionSpan(d),
		activeText: () => d.comments.activeText(),
		path: () => d.doc.path,
		// the same windows WorkspaceComments lets suggest
		canSuggest: () => !d.guest() && !collabHost.active && !fileMode.current && ctl.store.writable,
		suggestAs: (by, edit, note) => ctl.suggestions.suggestAs(by, edit, note),
		reveal: (id) => {
			const thread = ctl.threads.find((t) => t.id === id);
			if (thread) ctl.open(thread);
		}
	});
	$effect(() => {
		refiner.current = r;
		return () => {
			if (refiner.current === r) refiner.current = null;
		};
	});
}
