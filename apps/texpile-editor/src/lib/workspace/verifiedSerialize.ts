// The save check: the file a document was written to must parse back to that document. That is
// the second law of the round trip (see blockAssembly.ts); the first, that an untouched document
// writes its file back byte for byte, holds by construction. When the file fails it, the blame
// can only lie in a block that was written from the document, since every other block is the
// file's own bytes: those blocks are written out whole instead of patched inside, then their
// neighbours with them, and the file checked again. What is untouched is never regenerated.
import { Fragment, type Node as PMNode } from 'prosemirror-model';
import { forgetBlock, originsOf, type SourceMap } from '$lib/editor/visual/sourceSpans';
import { padTables } from '$lib/editor/visual/padTables';
import { reopenDifference, type VisualFormat } from '$lib/editor/visual/docShape';

export type Serialized = { text: string; map: SourceMap };

export type Verified = Serialized & {
	/** how far the fallback went: 0 the file as first written, 1 the changed blocks written whole,
	 *  2 their neighbours too, 3 still not agreeing, saved as rung 2 wrote it */
	rung: 0 | 1 | 2 | 3;
	/** how many top-level blocks were written whole */
	rewritten: number;
	/** what still differs on reopen, at rung 3 */
	difference: string | null;
};

export type VerifyOptions = {
	format: VisualFormat;
	/** the document as the editor holds it */
	doc: PMNode;
	/** the file as first written from it */
	first: Serialized;
	/** the file written from `doc` with the blocks in `afresh` written whole */
	serialize: (doc: PMNode, afresh: ReadonlySet<PMNode>) => Serialized;
	/** the document a file parses to; null when it cannot be parsed now (a timeout), which
	 *  leaves the file as it is */
	reparse: (text: string) => Promise<PMNode | null>;
};

/** the top-level blocks the parse no longer knows: the only ones written from the document */
export function changedBlocks(doc: PMNode): number[] {
	const { origins } = originsOf(doc);
	const out: number[] = [];
	for (let i = 0; i < doc.childCount; i++) if (!origins[i]) out.push(i);
	return out;
}

/** `doc` with the blocks at `indices` made afresh, and those blocks, for the serializer */
function withAfresh(doc: PMNode, indices: number[]): { doc: PMNode; afresh: Set<PMNode> } {
	const set = new Set(indices);
	const afresh = new Set<PMNode>();
	const kids: PMNode[] = [];
	doc.forEach((child, _off, i) => {
		if (!set.has(i)) return kids.push(child);
		const fresh = forgetBlock(child);
		afresh.add(fresh);
		kids.push(fresh);
	});
	return { doc: doc.copy(Fragment.fromArray(kids)), afresh };
}

export async function verifiedSerialize(o: VerifyOptions): Promise<Verified> {
	const differs = async (out: Serialized): Promise<string | null> => {
		const again = await o.reparse(out.text);
		return again ? reopenDifference(o.doc, padTables(again), o.format) : null;
	};
	const d0 = await differs(o.first);
	if (!d0) return { ...o.first, rung: 0, rewritten: 0, difference: null };
	const changed = changedBlocks(o.doc);
	if (changed.length === 0) return { ...o.first, rung: 3, rewritten: 0, difference: d0 };
	const attempt = (indices: number[]): Serialized => {
		const { doc, afresh } = withAfresh(o.doc, indices);
		return o.serialize(doc, afresh);
	};
	const first = attempt(changed);
	const d1 = await differs(first);
	if (!d1) return { ...first, rung: 1, rewritten: changed.length, difference: null };
	const wider = new Set<number>();
	for (const i of changed) for (const k of [i - 1, i, i + 1]) if (k >= 0 && k < o.doc.childCount) wider.add(k);
	const widened = [...wider].sort((a, b) => a - b);
	if (widened.length === changed.length) return { ...first, rung: 3, rewritten: changed.length, difference: d1 };
	const second = attempt(widened);
	const d2 = await differs(second);
	if (!d2) return { ...second, rung: 2, rewritten: widened.length, difference: null };
	return { ...second, rung: 3, rewritten: widened.length, difference: d2 };
}
