// how a Typst raw chip is drawn (a comment folded to a line), edited and read again once edited
import type { DrawnChipKind } from '$lib/editor/visual/extensions/drawnChips/DrawnChipView';
import { chipReplacement } from '$lib/editor/visual/extensions/drawnChips/chipReparse';
import { readComment } from '$lib/editor/visual/extensions/drawnChips/commentLines';
import CommentSettings from '$lib/editor/visual/extensions/drawnChips/CommentSettings.svelte';
import { InlineLatexView } from '$lib/editor/visual/extensions/raw-latex/inlineLatexView';
import { RawLatexView } from '$lib/editor/visual/extensions/raw-latex/rawLatexView';
import { typstToProseMirror } from '../converter';
import { typstCommentFace } from './typstCommentFace';

function parsed(source: string) {
	try {
		return typstToProseMirror(source).doc;
	} catch {
		return null;
	}
}

export function typstChipKind(block: boolean): DrawnChipKind {
	return {
		block,
		language: 'typst',
		makeFace: typstCommentFace,
		makeSource: (node, view, getPos) => (block ? new RawLatexView(node, view, getPos) : new InlineLatexView(node, view, getPos)),
		reparse: (source, chip) => chipReplacement(parsed(source), chip, block),
		settingsFor: (source) => (readComment(source)?.marker === '//' ? CommentSettings : null),
		jump: () => {},
		jumpToDefinition: () => {}
	};
}
