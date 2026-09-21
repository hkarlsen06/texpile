// the elements a suggestion's old content is drawn with, and the mark a moved break gets
import { DOMSerializer, type Node as PMNode, type Schema } from 'prosemirror-model';
import type { GoneContent, OldRun } from './pmSuggestionsPlace';
import { renderStaticMath } from './mathlivebridge/mathStatic';

let graphemes: Intl.Segmenter | undefined;
const serializers = new WeakMap<Schema, DOMSerializer>();

function serializerFor(schema: Schema): DOMSerializer {
	let s = serializers.get(schema);
	if (!s) serializers.set(schema, (s = DOMSerializer.fromSchema(schema)));
	return s;
}

function isMath(node: PMNode): boolean {
	return node.type.name === 'inline_math' || node.type.name === 'block_math';
}

function withMarks(schema: Schema, inner: Node, marks: readonly OldRun['marks'][number][]): Node {
	const serializer = serializerFor(schema);
	return marks.reduceRight<Node>((content, mark) => {
		const { dom, contentDOM } = DOMSerializer.renderSpec(document, serializer.marks[mark.type.name](mark, true));
		// dressed like the link mark, without its target: these words are gone from the document
		if (mark.type.name === 'link' && dom instanceof HTMLElement) dom.classList.add('anchor');
		(contentDOM ?? dom).appendChild(content);
		return dom;
	}, inner);
}

// one span a character, named by its offset in the words: the line breaker ends lines inside them by
// marking these (lineBreakPlugin), which no decoration could reach
export function oldWordsElement(schema: Schema, runs: OldRun[], id: string, focused: boolean): HTMLElement {
	graphemes ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' });
	const span = document.createElement('span');
	span.className = `pm-suggest-old${focused ? ' pm-suggest-focused' : ''}`;
	span.dataset.comment = id;
	let offset = 0;
	for (const run of runs) {
		const characters = document.createDocumentFragment();
		if (run.node) {
			const character = document.createElement('span');
			character.dataset.i = String(offset);
			character.appendChild(
				isMath(run.node) ? renderStaticMath(run.node.textContent, false) : serializerFor(schema).serializeNode(run.node)
			);
			characters.appendChild(character);
			offset += run.text.length;
		} else {
			for (const { segment } of graphemes.segment(run.text)) {
				const character = document.createElement('span');
				character.dataset.i = String(offset);
				character.textContent = segment;
				characters.appendChild(character);
				offset += segment.length;
			}
		}
		span.appendChild(withMarks(schema, characters, run.marks));
	}
	return span;
}

// the node as it was, beside the one it is now: a formula typeset by the same renderer that draws the
// new one, anything else as its source, since a node that draws itself has no words to strike
export function oldNodeElement(node: PMNode, id: string, focused: boolean): HTMLElement {
	const block = node.isBlock;
	const holder = document.createElement(block ? 'div' : 'span');
	holder.className = `pm-suggest-old pm-suggest-was${focused ? ' pm-suggest-focused' : ''}`;
	holder.dataset.comment = id;
	holder.contentEditable = 'false';
	if (isMath(node)) holder.appendChild(renderStaticMath(node.textContent, block));
	else {
		const code = document.createElement('code');
		code.textContent = node.textContent;
		holder.appendChild(code);
	}
	return holder;
}

function runsElement(schema: Schema, runs: OldRun[]): HTMLElement {
	const line = document.createElement('p');
	for (const run of runs) {
		const inner: Node = run.node
			? isMath(run.node)
				? renderStaticMath(run.node.textContent, false)
				: serializerFor(schema).serializeNode(run.node)
			: document.createTextNode(run.text);
		line.appendChild(withMarks(schema, inner, run.marks));
	}
	return line;
}

// content gone from the document across block edges, so there is nothing left in it to strike. It
// takes a block of its own where it was taken from, which is what the diff view does with a removed
// block; the end and start of the blocks it broke off from are its first and last lines
export function goneBlocksElement(schema: Schema, gone: GoneContent, id: string, focused: boolean): HTMLElement {
	const holder = document.createElement('div');
	holder.className = `pm-suggest-old pm-suggest-gone${focused ? ' pm-suggest-focused' : ''}`;
	holder.dataset.comment = id;
	holder.contentEditable = 'false';
	const serializer = serializerFor(schema);
	if (gone.head.length) holder.appendChild(runsElement(schema, gone.head));
	for (const block of gone.blocks) holder.appendChild(serializer.serializeNode(block));
	if (gone.tail.length) holder.appendChild(runsElement(schema, gone.tail));
	return holder;
}

/**
 * A bar where the break is, the way a diff marks one. Not a pilcrow or a ↵: those are characters the
 * document does not contain, and a reader has to be told what they mean.
 */
export function breakMark(way: 'added' | 'removed', id: string, focused: boolean): HTMLElement {
	const span = document.createElement('span');
	span.className = `pm-suggest-break pm-suggest-break-${way}${focused ? ' pm-suggest-focused' : ''}`;
	span.dataset.comment = id;
	span.contentEditable = 'false';
	return span;
}
