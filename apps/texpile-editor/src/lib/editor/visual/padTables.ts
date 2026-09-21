// uneven table rows padded at parse, as the view pads them on mount
import { EditorState } from 'prosemirror-state';
import { fixTables } from 'prosemirror-tables';
import type { Node as PMNode } from 'prosemirror-model';
import { blockSpanOf, noteBlockSpan } from './sourceSpans';

export function padTables(doc: PMNode): PMNode {
	const state = EditorState.create({ schema: doc.type.schema, doc });
	const fix = fixTables(state);
	if (!fix) return doc;
	const padded = state.apply(fix).doc;
	// the padding rebuilds a table's block, which is still the block the parser placed: its span
	// goes with it (padding adds cells, never blocks, so the children still line up)
	if (padded.childCount === doc.childCount) {
		for (let i = 0; i < doc.childCount; i++) {
			const before = doc.child(i);
			const after = padded.child(i);
			if (after !== before && !blockSpanOf(after)) noteBlockSpan(after, blockSpanOf(before));
		}
	}
	return padded;
}
