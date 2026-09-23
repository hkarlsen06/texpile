// what changed between two parses of the same stretch of a file, as prosemirror-changeset reads it
import { ChangeSet, type TokenEncoder } from 'prosemirror-changeset';
import type { Attrs, Fragment, Mark, Node as PMNode } from 'prosemirror-model';
import { StepMap } from 'prosemirror-transform';
import { isSelfRendered } from '../diff/selfRendered';

/** a range of the document before and the range of the document after it became */
export type DocChange = { fromA: number; toA: number; fromB: number; toB: number };

// the source gap says where a block came from, the label gap where its label stood, and a display's
// paragraph flags whether a blank line sat around it: none is what the reader sees change
const UNSEEN_ATTRS = new Set(['typGap', 'labelGap', 'inParagraph', 'continuesAfter']);

function attrsKey(attrs: Attrs): string {
	const rest = Object.entries(attrs).filter(([name]) => !UNSEEN_ATTRS.has(name));
	return rest.length ? JSON.stringify(Object.fromEntries(rest)) : '';
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
function wholeWords(changes: readonly DocChange[], doc: PMNode): DocChange[] {
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

// the tokens prosemirror-changeset compares, one per position
function tokensOf(content: Fragment, from: number, to: number, out: (string | number)[] = []): (string | number)[] {
	let off = 0;
	content.forEach((child) => {
		const end = off + child.nodeSize;
		const lo = Math.max(off, from);
		const hi = Math.min(end, to);
		if (lo < hi) {
			if (child.isText) for (let i = lo; i < hi; i++) out.push(encoder.encodeCharacter(child.text!.charCodeAt(i - off), child.marks));
			else if (child.isLeaf) out.push(encoder.encodeNodeStart(child));
			else {
				if (lo === off) out.push(encoder.encodeNodeStart(child));
				tokensOf(child.content, Math.max(off + 1, lo) - off - 1, Math.min(end - 1, hi) - off - 1, out);
				if (hi === end) out.push(encoder.encodeNodeEnd(child));
			}
		}
		off = end;
	});
	return out;
}

type Token = string | number;

function atWordEdge(doc: PMNode, pos: number): boolean {
	return !wordOver(doc, pos - 1, pos + 1);
}

function isCharacter(t: Token): boolean {
	return typeof t === 'number' || /^\d/.test(t);
}

function isLetter(t: Token): boolean {
	return isCharacter(t) && /\S/.test(String.fromCharCode(typeof t === 'number' ? t : parseInt(t, 10)));
}

function touchesSelfRendered(doc: PMNode, from: number, to: number): boolean {
	for (const $pos of [doc.resolve(from), doc.resolve(to)])
		for (let d = $pos.depth; d > 0; d--) if (isSelfRendered($pos.node(d))) return true;
	let hit = false;
	doc.nodesBetween(from, to, (node) => {
		hit ||= !node.isText && isSelfRendered(node);
		return !hit;
	});
	return hit;
}

// a change this small is someone's edit, where a word left standing reads as left standing
const SMALL = 60;

// a run both sides hold, with a letter in it and cut at word edges wherever it meets the rest of the change
function keptRun(c: DocChange, a: Token[], b: Token[], before: PMNode, after: PMNode): { i: number; j: number; len: number } | null {
	function fits(i: number, j: number, len: number): boolean {
		return (
			a.slice(i, i + len).some(isLetter) &&
			(i === 0 || atWordEdge(before, c.fromA + i)) &&
			(i + len === a.length || atWordEdge(before, c.fromA + i + len)) &&
			(j === 0 || atWordEdge(after, c.fromB + j)) &&
			(j + len === b.length || atWordEdge(after, c.fromB + j + len))
		);
	}
	let best: { i: number; j: number; len: number } | null = null;
	for (let i = 0; i < a.length; i++) {
		for (let j = 0; j < b.length; j++) {
			if (a[i] !== b[j] || (i > 0 && j > 0 && a[i - 1] === b[j - 1])) continue;
			let run = 0;
			while (i + run < a.length && j + run < b.length && a[i + run] === b[j + run]) run++;
			for (let len = run; len > (best?.len ?? 0); len--) {
				if (!fits(i, j, len)) continue;
				best = { i, j, len };
				break;
			}
		}
	}
	return best;
}

// prosemirror-changeset reads edits fewer than a couple of tokens apart as one, so a short word left
// standing between two (a paragraph split after "A", then typed at its start) came out struck and
// typed again. Words both sides of a small change hold are kept, and the change is what is around them;
// not in a node that draws itself, which changes whole, nor where both sides rework blocks
function keptApart(c: DocChange, before: PMNode, after: PMNode): DocChange[] {
	const lenA = c.toA - c.fromA;
	const lenB = c.toB - c.fromB;
	if (lenA === 0 || lenB === 0 || lenA > SMALL || lenB > SMALL) return [c];
	const a = tokensOf(before.content, c.fromA, c.toA);
	const b = tokensOf(after.content, c.fromB, c.toB);
	if (!a.every(isCharacter) && !b.every(isCharacter)) return [c];
	if (touchesSelfRendered(before, c.fromA, c.toA) || touchesSelfRendered(after, c.fromB, c.toB)) return [c];
	const kept = keptRun(c, a, b, before, after);
	if (!kept) return [c];
	const { i, j, len } = kept;
	const head = { fromA: c.fromA, toA: c.fromA + i, fromB: c.fromB, toB: c.fromB + j };
	const tail = { fromA: c.fromA + i + len, toA: c.toA, fromB: c.fromB + j + len, toB: c.toB };
	return [head, tail].filter((x) => x.toA > x.fromA || x.toB > x.fromB).flatMap((x) => keptApart(x, before, after));
}

function readSame(before: PMNode, fromA: number, toA: number, after: PMNode, fromB: number, toB: number): boolean {
	if (toA < fromA || toA - fromA !== toB - fromB) return false;
	const a = tokensOf(before.content, fromA, toA);
	const b = tokensOf(after.content, fromB, toB);
	return a.length === b.length && a.every((t, i) => t === b[i]);
}

// the stretches, joined wherever what lies between two of them does not read the same on both sides
function apart(before: PMNode, after: PMNode, stretches: DocChange[]): DocChange[] {
	const sizeA = before.content.size;
	const sizeB = after.content.size;
	const out: DocChange[] = [];
	for (const s of stretches) {
		const prev = out[out.length - 1];
		if (!prev) out.push(readSame(before, 0, s.fromA, after, 0, s.fromB) ? { ...s } : { ...s, fromA: 0, fromB: 0 });
		else if (readSame(before, prev.toA, s.fromA, after, prev.toB, s.fromB)) out.push({ ...s });
		else {
			prev.toA = Math.max(prev.toA, s.toA);
			prev.toB = Math.max(prev.toB, s.toB);
		}
	}
	const last = out[out.length - 1];
	if (!last) return [{ fromA: 0, toA: sizeA, fromB: 0, toB: sizeB }];
	if (!readSame(before, last.toA, sizeA, after, last.toB, sizeB)) {
		last.toA = sizeA;
		last.toB = sizeB;
	}
	return out;
}

/**
 * the changes from `before` to `after`, widened to whole words where a word was partly replaced. Each
 * of `stretches` is compared on its own, where what lies between them reads the same on both sides
 */
export function diffDocs(before: PMNode, after: PMNode, stretches: DocChange[] = []): DocChange[] {
	// one step per stretch, each at the place the steps before it have left it; a single map of several
	// ranges would do, but prosemirror-changeset offsets a third range by the second one's size alone.
	// A stretch empty on both sides would come back as an empty change
	const maps = apart(before, after, stretches)
		.filter((s) => s.toA > s.fromA || s.toB > s.fromB)
		.map((s) => new StepMap([s.fromB, s.toA - s.fromA, s.toB - s.fromB]));
	const set = ChangeSet.create(before, undefined, encoder).addSteps(after, maps, 0);
	const changes = set.changes.flatMap((c) => keptApart({ fromA: c.fromA, toA: c.toA, fromB: c.fromB, toB: c.toB }, before, after));
	return wholeWords(changes, after);
}

/** the characters of a range, one placeholder per node that is not text */
export function textOf(doc: PMNode, from: number, to: number): string {
	return doc.textBetween(from, to, '', '￼');
}
