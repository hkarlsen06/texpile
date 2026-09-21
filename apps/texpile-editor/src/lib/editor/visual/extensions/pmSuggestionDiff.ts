// what changed between two parses of the same stretch of a file, as prosemirror-changeset reads it
import { ChangeSet, simplifyChanges, type Change, type TokenEncoder } from 'prosemirror-changeset';
import type { Attrs, Mark, Node as PMNode } from 'prosemirror-model';
import { ReplaceStep } from 'prosemirror-transform';

// the verbatim stamp and the source gap say where a block came from, which is not what the reader
// sees change
function attrsKey(attrs: Attrs): string {
	const { orig: _orig, typGap: _gap, ...rest } = attrs;
	return Object.keys(rest).length ? JSON.stringify(rest) : '';
}

function markKey(mark: Mark): string {
	return `|${mark.type.name}${attrsKey(mark.attrs)}`;
}

// a character with its marks, so bolding a word is a change; a node with its attributes, so a
// heading's level or a formula's source is one
const encoder: TokenEncoder<string | number> = {
	encodeCharacter: (code, marks) => (marks.length ? `${code}${marks.map(markKey).join('')}` : code),
	encodeNodeStart: (node) => `<${node.type.name}${attrsKey(node.attrs)}`,
	encodeNodeEnd: (node) => `>${node.type.name}`,
	compareTokens: (a, b) => a === b
};

/** the changes from `before` to `after`, simplified to whole words where a word was partly replaced */
export function diffDocs(before: PMNode, after: PMNode): Change[] {
	const whole = new ReplaceStep(0, before.content.size, after.slice(0)).getMap();
	const set = ChangeSet.create(before, undefined, encoder).addSteps(after, [whole], 0);
	return simplifyChanges(set.changes, after);
}

/** the characters of a range, one placeholder per node that is not text */
export function textOf(doc: PMNode, from: number, to: number): string {
	return doc.textBetween(from, to, '', '￼');
}
