// uneven table rows padded at parse, as the view pads them on mount
import { EditorState } from 'prosemirror-state';
import { fixTables } from 'prosemirror-tables';
import type { Node as PMNode } from 'prosemirror-model';

export function padTables(doc: PMNode): PMNode {
	const state = EditorState.create({ schema: doc.type.schema, doc });
	const fix = fixTables(state);
	return fix ? state.apply(fix).doc : doc;
}
