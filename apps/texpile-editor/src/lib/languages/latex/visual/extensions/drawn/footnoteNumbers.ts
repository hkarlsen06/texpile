// the number LaTeX gives each footnote, counted over the raw chips in document order and handed to each chip
// on a node decoration (`footnotes`, the chip's numbers joined by commas)
import type { Node } from 'prosemirror-model';
import { Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';

export const footnoteNumbersKey = new PluginKey<DecorationSet>('texpile-footnote-numbers');

// \footnote and \footnotemark step the counter; given a number in brackets, they print it and leave the counter alone
const MARK = /\\footnote(?:mark)?(?![a-zA-Z@])\s*(?:\[\s*(\d+)\s*\])?/g;
const COMMENT = /(^|[^\\])%.*$/gm;

function numbered(doc: Node): DecorationSet {
	let counter = 0;
	const decorations: Decoration[] = [];
	doc.descendants((node, pos) => {
		if (node.type.name !== 'inline_latex' && node.type.name !== 'raw_latex') return true;
		const text = node.textContent;
		if (!text.includes('\\footnote')) return false;
		const numbers: number[] = [];
		for (const m of text.replace(COMMENT, '$1').matchAll(MARK)) numbers.push(m[1] ? Number(m[1]) : ++counter);
		if (numbers.length) decorations.push(Decoration.node(pos, pos + node.nodeSize, {}, { footnotes: numbers.join(',') }));
		return false;
	});
	return DecorationSet.create(doc, decorations);
}

/** the numbers a chip's footnotes print, in the order they stand in it */
export function footnoteNumbersOf(decorations: readonly Decoration[]): number[] {
	const spec = decorations.find((d) => typeof d.spec.footnotes === 'string')?.spec.footnotes as string | undefined;
	return spec ? spec.split(',').map(Number) : [];
}

export function footnoteNumbersPlugin(): Plugin<DecorationSet> {
	return new Plugin<DecorationSet>({
		key: footnoteNumbersKey,
		state: {
			init: (_, state) => numbered(state.doc),
			apply: (tr, numbers) => (tr.docChanged ? numbered(tr.doc) : numbers)
		},
		props: {
			decorations: (state) => footnoteNumbersKey.getState(state)
		}
	});
}
