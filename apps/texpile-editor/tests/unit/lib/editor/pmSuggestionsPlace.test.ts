import { it, expect } from 'vitest';
import type { Node as PMNode } from 'prosemirror-model';
import { buildAnchor } from '$lib/comments/anchor';
import type { SuggestionMark } from '$lib/comments/activeSuggestions.svelte';
import { placePmSuggestions, type PmSuggestionRange } from '$lib/editor/visual/extensions/pmSuggestionsPlace';
import { bodyOffsetOf, parseLatexFile, parseLatexRegion } from '$lib/workspace/latexRoundtrip';

/** the marks placed in `source` parsed as a file, the way the editor hands them over */
function placed(source: string, marks: SuggestionMark[]) {
	const parsed = parseLatexFile(source);
	const from = bodyOffsetOf(parsed);
	const to = parsed.hadDocumentEnv ? source.length - parsed.postamble.length : source.length;
	return {
		doc: parsed.doc,
		...placePmSuggestions(parsed.doc, marks, {
			text: source,
			map: parsed.map,
			body: { from, to },
			parse: (src) => parseLatexRegion(src, parsed.preamble)
		})
	};
}

function mark(source: string, id: string, words: string, restore: string, from = source.indexOf(words)): SuggestionMark {
	return { id, from, to: from + words.length, restore, mine: true, anchor: buildAnchor(source, from, from + words.length) };
}

const oldOf = (r: PmSuggestionRange | undefined) => r?.old.map((run) => [run.text, run.marks.map((m) => m.type.name)]);

it('draws plain words, tints a changed formula whole, and leaves a title change undrawn', () => {
	const source =
		'\\title{Adaptive Refinement for Hyperbolic Laws}\n\\begin{document}\n' +
		'Refinement is driven by an estimator.\n\n' +
		'On each patch we form the residual $r_j$ by inserting the reconstructed solution.\n\\end{document}\n';
	const { doc, ranges, partial, hidden } = placed(source, [
		mark(source, 'plain', 'driven', 'led'),
		mark(source, 'formula', 'r_j', 'R_j^n'),
		mark(source, 'title', '', 'Mesh ', source.indexOf('Refinement for'))
	]);
	const plain = ranges.find((r) => r.id === 'plain');
	expect(plain && doc.textBetween(plain.from, plain.to)).toBe('driven');
	expect(oldOf(plain)).toEqual([['led', []]]);
	const formula = ranges.find((r) => r.id === 'formula')!;
	expect(formula.node).toBe(true);
	expect(doc.nodeAt(formula.from)?.type.name).toBe('inline_math');
	expect(formula.was?.textContent).toBe('R_j^n');
	expect([...partial]).toEqual([]);
	expect([...hidden]).toEqual(['title']);
});

it('draws formatted old words at the start of the body and new words across a paragraph end', () => {
	const source =
		'\\documentclass{article}\n\\begin{document}Typed over text. More words.\n\nkept added words \\par\n\nand a new paragraph\n\\end{document}\n';
	const { doc, ranges, partial } = placed(source, [
		mark(source, 'replace', 'Typed over', '\nAn inline \\textit{quotation} sits in running'),
		mark(source, 'paragraphs', 'added words \\par\n\nand a new paragraph', ' \\par')
	]);
	expect([...partial]).toEqual([]);
	expect(oldOf(ranges.find((r) => r.id === 'replace'))).toEqual([
		['An inline ', []],
		['quotation', ['em']],
		[' sits in running', []]
	]);
	const paragraphs = ranges.find((r) => r.id === 'paragraphs')!;
	expect(doc.textBetween(paragraphs.from, paragraphs.to, '¶').trim()).toBe('added words¶and a new paragraph');
	expect(paragraphs.old).toEqual([]);
});

it('gives old words the marks of the run they sat in, at its edges and across them', () => {
	const source =
		'\\documentclass{article}\n\\begin{document}\nSee the words \\textbf{gamma beta} now and later \\href{https://x.y}{the guide} too.\n\nAn \\textbf{new}ng here.\n\\end{document}\n';
	const { ranges, partial, hidden } = placed(source, [
		mark(source, 'start', 'gamma', 'alpha'),
		mark(source, 'end', '', ' more', source.indexOf('beta}') + 4),
		mark(source, 'link', 'guide', 'docs'),
		mark(source, 'across', 'new}', 'old} thi')
	]);
	expect([...partial, ...hidden]).toEqual([]);
	const old = Object.fromEntries(ranges.map((r) => [r.id, oldOf(r)]));
	expect(old).toEqual({
		start: [['alpha', ['strong']]],
		end: [[' more', ['strong']]],
		link: [['docs', ['link']]],
		// a word partly replaced is drawn whole, the way a diff reads
		across: [
			['old', ['strong']],
			[' thing', []]
		]
	});
});

it('draws typed words around a formula as words, and a formula among old words as itself', () => {
	const source = '\\begin{document}\nSome text here. Typed before $a$ and after it.\n\nA second paragraph stays.\n\\end{document}\n';
	const { doc, ranges, partial } = placed(source, [
		mark(source, 'typed', ' Typed before $a$ and after it.', ''),
		mark(source, 'gone', 'stays', 'held $b$')
	]);
	expect([...partial]).toEqual([]);
	const typed = ranges.find((r) => r.id === 'typed')!;
	expect(doc.textBetween(typed.from, typed.to)).toBe(' Typed before a and after it.');
	expect(doc.resolve(typed.to).parent.type.name).toBe('paragraph');
	const gone = ranges.find((r) => r.id === 'gone')!;
	expect(gone.old.map((run) => run.node?.type.name ?? run.text)).toEqual(['held ', 'inline_math']);
});

it('draws inserted blocks as words, chips included', () => {
	const source = '\\begin{document}\nOne stays.\n\n\\foo{a}\n\nmiddle words here\n\n\\foo{b}\n\nLast stays.\n\\end{document}\n';
	const from = source.indexOf('\\foo{a}');
	const to = source.indexOf('\\foo{b}') + '\\foo{b}'.length;
	const { doc, ranges, partial } = placed(source, [mark(source, 'wide', source.slice(from, to), '', from)]);
	expect([...partial]).toEqual([]);
	expect(doc.textBetween(ranges[0].from, ranges[0].to, '|')).toContain('middle words here');
});

it('marks the same words with other formatting as a format change', () => {
	const source = '\\begin{document}\nRefinement is \\textbf{driven} by an estimator.\n\\end{document}\n';
	const { doc, ranges } = placed(source, [mark(source, 'bold', '\\textbf{driven}', 'driven')]);
	const [range] = ranges;
	expect(range.format).toBe(true);
	expect(range.partial).toBe(false);
	expect(doc.textBetween(range.from, range.to)).toBe('driven');
	expect(oldOf(range)).toEqual([['driven', []]]);
});

it('draws a paragraph pulled into the heading before it', () => {
	const source = '\\begin{document}\n\\paragraph{Runin Prose follows the heading here.}\n\nNext paragraph stays.\n\\end{document}\n';
	const words = 'Prose follows the heading here.}';
	const { doc, ranges, hidden } = placed(source, [mark(source, 'merged', words, '} Prose follows the heading here.')]);
	expect([...hidden]).toEqual([]);
	expect(ranges.length).toBeGreaterThan(0);
	const inHeading = (pos: number) => doc.resolve(pos).depth > 0 && doc.resolve(pos).node(1).type.name === 'heading';
	expect(ranges.some((r) => inHeading(r.from) || doc.nodeAt(r.from)?.type.name === 'heading')).toBe(true);
});

it('tints the copy the suggestion is in when the text around it repeats', () => {
	const source = '\\begin{document}\nThe cat sat on the mat today.\n\nThe cat sat on the mat today.\n\\end{document}\n';
	const from = source.lastIndexOf('sat');
	const { doc, ranges } = placed(source, [mark(source, 'again', 'sat', 'lay', from)]);
	expect(ranges[0].from).toBeGreaterThan(doc.child(0).nodeSize);
});

it('tints only the chip a change sits in, and draws a removed accent as its letter', () => {
	const source =
		'\\begin{document}\nWe leave some room \\vspace{3cm} for the figure below.\n\n\\newpage\n\nThe Poincar map is the tool we use here.\n\n\\newpage\n\nThe end.\n\\end{document}\n';
	const { doc, ranges, partial } = placed(source, [
		mark(source, 'space', '3cm', '1.5cm'),
		mark(source, 'break', 'newpage', 'clearpage'),
		mark(source, 'accent', '', "\\'e", source.indexOf(' map'))
	]);
	expect([...partial]).toEqual([]);
	const chip = (id: string) => {
		const r = ranges.find((x) => x.id === id)!;
		return r.node && doc.nodeAt(r.from)?.nodeSize === r.to - r.from ? doc.nodeAt(r.from)!.textContent.trim() : null;
	};
	expect(chip('space')).toBe('\\vspace{3cm}');
	expect(chip('break')).toBe('\\newpage');
	expect(ranges.find((r) => r.id === 'break')!.from).toBe(doc.child(0).nodeSize);
	expect(oldOf(ranges.find((r) => r.id === 'accent'))).toEqual([['é', []]]);
});

// the parser reads an old font group as a chip, so what the reader sees change is a chip becoming words
it('draws an old font group made ordinary bold as the chip it was and the words it is', () => {
	const source = '\\begin{document}\nThe method is \\textbf{fast and small} on every input we tried.\n\\end{document}\n';
	const from = source.indexOf('\\textbf');
	const to = source.indexOf('} on') + 1;
	const { doc, ranges } = placed(source, [mark(source, 'bold', source.slice(from, to), '{\\bf fast and small}', from)]);
	const [range] = ranges;
	expect(range.format).toBeUndefined();
	expect(range.partial).toBe(false);
	expect(doc.textBetween(range.from, range.to)).toBe('fast and small');
	expect(range.old.map((run) => run.node?.textContent)).toEqual(['{\\bf fast and small}']);
});

it('stands a paragraph taken out where it stood, as a block of its own', () => {
	const source = '\\begin{document}\nOpening words.\n\nThe last.\n\\end{document}\n';
	const from = source.indexOf('The last');
	const { doc, ranges, partial } = placed(source, [mark(source, 'cut', '', 'A middle one.\n\n', from)]);
	expect([...partial]).toEqual([]);
	const [gone] = ranges;
	expect(gone.gone?.blocks.map((b: PMNode) => b.textContent)).toEqual(['A middle one.']);
	expect(doc.resolve(gone.from).depth).toBe(0);
	expect(gone.from).toBe(doc.child(0).nodeSize);
});

it('marks a paragraph break that came or went with a bar rather than words', () => {
	const split = '\\begin{document}\nFirst half of the line\n\nand the second half.\n\\end{document}\n';
	const at = split.indexOf('\n\nand');
	const added = placed(split, [mark(split, 'split', '\n\n', ' ', at)]);
	expect(added.ranges.map((r) => r.brk)).toEqual(['added']);
	const joined = '\\begin{document}\nFirst half of the line and the second half.\n\\end{document}\n';
	const removed = placed(joined, [mark(joined, 'join', ' ', '\n\n', at)]);
	expect(removed.ranges.map((r) => r.brk)).toEqual(['removed']);
});

// a letter taken from the very start of a heading belongs INSIDE that heading: drawn at the join it
// reads as the tail of the paragraph above, which is not where the word came from
it('draws a letter cut from the start of a heading inside that heading', () => {
	const source = '\\begin{document}\nA closing line of prose.\n\n\\section{n Typst}\n\nThe picker works the same way.\n\\end{document}\n';
	const at = source.indexOf('n Typst');
	const { doc, ranges } = placed(source, [mark(source, 'cut', '', 'I', at)]);
	const r = ranges.find((x) => x.id === 'cut');
	expect(r).toBeTruthy();
	const $at = doc.resolve(r!.from);
	expect($at.parent.type.name).toBe('heading');
	expect($at.parentOffset).toBe(0);
});

it('keeps the last placement of a mark whose text the editor has moved past', () => {
	const source = '\\begin{document}\nSome words here.\n\\end{document}\n';
	const moved = { ...mark(source, 'old', 'words', 'x'), anchor: buildAnchor('Other words here.', 6, 11) };
	moved.from -= 1;
	moved.to -= 1;
	const { ranges, stale } = placed(source, [moved]);
	expect(ranges).toEqual([]);
	expect([...stale]).toEqual(['old']);
});
