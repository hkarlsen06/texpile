// what changed between two parses of the same stretch of a file, as prosemirror-changeset reads it
import { ChangeSet, type Change, type TokenEncoder } from 'prosemirror-changeset';
import type { Attrs, Mark, Node as PMNode } from 'prosemirror-model';
import { ReplaceStep } from 'prosemirror-transform';

/** a range of the document before and the range of the document after it became */
export type DocChange = { fromA: number; toA: number; fromB: number; toB: number };

// the source gap says where a block came from, and the label gap where its label stood: neither
// is what the reader sees change
function attrsKey(attrs: Attrs): string {
	const { typGap: _gap, labelGap: _labelGap, ...rest } = attrs;
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

let segmenter: Intl.Segmenter | undefined;

// prosemirror-changeset's simplifyChanges takes every letter up to a space as one word, and Chinese or
// Japanese has no spaces: a character replaced in a sentence struck the whole sentence. Words here are
// the segmenter's, which the comparison uses too
function wordsAround(doc: PMNode, pos: number): { from: number; to: number }[] {
	const $pos = doc.resolve(pos);
	if (!$pos.parent.isTextblock) return [];
	const start = $pos.start();
	let text = '';
	// a node that is not text is as many characters as it has positions, none of them a letter
	$pos.parent.forEach((node) => (text += node.isText ? node.text : '￼'.repeat(node.nodeSize)));
	segmenter ??= new Intl.Segmenter(undefined, { granularity: 'word' });
	const words: { from: number; to: number }[] = [];
	for (const s of segmenter.segment(text)) if (s.isWordLike) words.push({ from: start + s.index, to: start + s.index + s.segment.length });
	return words;
}

/** the word of `doc` holding every character from `from` to `to`, if there is one */
function wordOver(doc: PMNode, from: number, to: number): { from: number; to: number } | null {
	return wordsAround(doc, from).find((w) => w.from <= from && to <= w.to) ?? null;
}

// changes with no word boundary between them are one, and one that both takes out and puts in more than
// a single character is widened to the words it touches: half a word struck beside the other half is
// hard to read. Both sides widen alike, since the text around a change is the same in both
function wholeWords(changes: readonly Change[], doc: PMNode): DocChange[] {
	const out: DocChange[] = [];
	for (let i = 0; i < changes.length; i++) {
		const start = i;
		let deleted = changes[i].toA - changes[i].fromA;
		let inserted = changes[i].toB - changes[i].fromB;
		while (i + 1 < changes.length) {
			const gapFrom = changes[i].toB;
			const gapTo = changes[i + 1].fromB;
			if (gapFrom < gapTo && !wordOver(doc, gapFrom - 1, gapTo)) break;
			i++;
			deleted += changes[i].toA - changes[i].fromA;
			inserted += changes[i].toB - changes[i].fromB;
		}
		const first = changes[start];
		const last = changes[i];
		if (deleted === 0 || inserted === 0 || (deleted === 1 && inserted === 1)) {
			for (const c of changes.slice(start, i + 1)) out.push({ fromA: c.fromA, toA: c.toA, fromB: c.fromB, toB: c.toB });
			continue;
		}
		const fromB = Math.min(first.fromB, wordOver(doc, first.fromB, first.fromB + 1)?.from ?? first.fromB);
		const toB = Math.max(last.toB, last.toB > 0 ? (wordOver(doc, last.toB - 1, last.toB)?.to ?? last.toB) : last.toB);
		const joined = { fromA: first.fromA - (first.fromB - fromB), toA: last.toA + (toB - last.toB), fromB, toB };
		const prev = out[out.length - 1];
		if (prev && prev.toA >= joined.fromA) {
			prev.fromA = Math.min(prev.fromA, joined.fromA);
			prev.fromB = Math.min(prev.fromB, joined.fromB);
			prev.toA = Math.max(prev.toA, joined.toA);
			prev.toB = Math.max(prev.toB, joined.toB);
		} else out.push(joined);
	}
	return out;
}

/** the changes from `before` to `after`, widened to whole words where a word was partly replaced */
export function diffDocs(before: PMNode, after: PMNode): DocChange[] {
	const whole = new ReplaceStep(0, before.content.size, after.slice(0)).getMap();
	const set = ChangeSet.create(before, undefined, encoder).addSteps(after, [whole], 0);
	return wholeWords(set.changes, after);
}

/** the characters of a range, one placeholder per node that is not text */
export function textOf(doc: PMNode, from: number, to: number): string {
	return doc.textBetween(from, to, '', '￼');
}
