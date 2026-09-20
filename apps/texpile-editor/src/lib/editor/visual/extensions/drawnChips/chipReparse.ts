// an edited chip's source read again the way opening the file reads it: words typed into it become a paragraph, or
// words of its paragraph, and the commands around them chips again. null keeps it the one chip it was
import type { Node } from 'prosemirror-model';

/** what replaces the chip once its edited source is read again, or null to keep it */
export type ChipReparse = (source: string, chip: Node) => Node[] | null;

function isChipItself(nodes: Node[], chip: Node): boolean {
	return nodes.length === 1 && nodes[0].type === chip.type && nodes[0].textContent === chip.textContent;
}

// the fragment's own source slices say nothing about where it now stands, so its blocks are written out afresh
function withoutOrig(block: Node): Node {
	return 'orig' in block.attrs ? block.type.create({ ...block.attrs, orig: null }, block.content, block.marks) : block;
}

export function chipReplacement(doc: Node | null, chip: Node, block: boolean): Node[] | null {
	if (!doc) return null;
	const blocks: Node[] = [];
	doc.forEach((child) => blocks.push(withoutOrig(child)));
	if (block) return isChipItself(blocks, chip) ? null : blocks;
	if (blocks.length === 0) return [];
	// a paragraph of chips alone reads back as a raw block: still the chip, perhaps with its commands regrouped
	if (blocks.length !== 1 || blocks[0].type.name !== 'paragraph') return null;
	const inline: Node[] = [];
	blocks[0].forEach((child) => inline.push(child.mark(chip.marks.reduce((marks, mark) => mark.addToSet(marks), child.marks))));
	return isChipItself(inline, chip) ? null : inline;
}
