// The document in an editor changes node with every transaction, while the parse it came from
// stays the same until a re-parse lands. This plugin hands the parse on to each new document, so
// the serializer can always ask a document which parse's blocks it still holds
import { Plugin, PluginKey } from 'prosemirror-state';
import { adoptParse, parseOf } from './sourceSpans';

export const parseCarryKey = new PluginKey<null>('parseCarry');

export const parseCarryPlugin = new Plugin<null>({
	key: parseCarryKey,
	state: {
		init: () => null,
		apply(_tr, _value, oldState, newState) {
			if (newState.doc !== oldState.doc) {
				const parse = parseOf(oldState.doc);
				if (parse) adoptParse(newState.doc, parse);
			}
			return null;
		}
	}
});
