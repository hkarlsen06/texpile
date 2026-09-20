import { it, expect } from 'vitest';
import { schema } from '$lib/languages/latex/schema/latexPMSchema';
import { buildAnchor } from '$lib/comments/anchor';
import { placePmSuggestions } from '$lib/editor/visual/extensions/pmSuggestionsPlace';
import { parseLatexFile } from '$lib/workspace/latexRoundtrip';

const SOURCE =
	'\\title{Adaptive Refinement for Hyperbolic Laws}\n\\begin{document}\n' +
	'Refinement is driven by an estimator.\n\n' +
	'On each patch we form the residual $r_j$ by inserting the reconstructed solution.\n';

function mark(id: string, words: string, restore: string, at = SOURCE.indexOf(words)) {
	return { id, from: at, to: at + words.length, restore, mine: false, anchor: buildAnchor(SOURCE, at, at + words.length) };
}

it('draws plain words, outlines a formula change, and leaves a title change undrawn', () => {
	const doc = schema.nodes.doc.create(null, [
		schema.nodes.paragraph.create(null, schema.text('Refinement is driven by an estimator.')),
		schema.nodes.paragraph.create(null, [
			schema.text('On each patch we form the residual '),
			schema.nodes.inline_math.create({ latex: 'r_j' }),
			schema.text(' by inserting the reconstructed solution.')
		])
	]);
	const { ranges, partial, hidden } = placePmSuggestions(
		doc,
		[mark('plain', 'driven', 'led'), mark('formula', 'r_j', 'R_j^n'), mark('title', '', 'Mesh ', SOURCE.indexOf('Refinement for'))],
		'tex'
	);
	const plain = ranges.find((r) => r.id === 'plain');
	expect(plain && doc.textBetween(plain.from, plain.to)).toBe('driven');
	expect(plain?.partial).toBe(false);
	expect([...partial]).toEqual(['formula']);
	expect([...hidden]).toEqual(['title']);
});

it('draws formatted old words at the start of the body and new words across a paragraph end', () => {
	const source =
		'\\documentclass{article}\n\\begin{document}Typed over text. More words.\n\nkept added words \\par\n\nand a new paragraph\n\\end{document}\n';
	const at = (id: string, words: string, restore: string) => {
		const from = source.indexOf(words);
		return { id, from, to: from + words.length, restore, mine: true, anchor: buildAnchor(source, from, from + words.length) };
	};
	const doc = parseLatexFile(source).doc;
	const { ranges, partial } = placePmSuggestions(
		doc,
		[
			at('replace', 'Typed over', '\nAn inline \\textit{quotation} sits in running'),
			at('paragraphs', 'added words \\par\n\nand a new paragraph', ' \\par')
		],
		'tex'
	);
	expect([...partial]).toEqual([]);
	expect(ranges.find((r) => r.id === 'replace')?.old).toEqual([
		{ text: 'An inline ', tags: [] },
		{ text: 'quotation', tags: ['em'] },
		{ text: ' sits in running', tags: [] }
	]);
	const paragraphs = ranges.find((r) => r.id === 'paragraphs')!;
	expect(doc.textBetween(paragraphs.from, paragraphs.to, '¶')).toBe('added words¶and a new paragraph');
	expect(paragraphs.old).toEqual([]);
});

it('gives old words the formatting of the run they sat in, at its edges and across them', () => {
	const source =
		'\\documentclass{article}\n\\begin{document}\nSee the words \\textbf{gamma beta} now and later \\href{https://x.y}{the guide} too.\n\nAn \\textbf{new}ng here.\n\\end{document}\n';
	const at = (id: string, words: string, restore: string, from = source.indexOf(words)) => ({
		id,
		from,
		to: from + words.length,
		restore,
		mine: true,
		anchor: buildAnchor(source, from, from + words.length)
	});
	const doc = parseLatexFile(source).doc;
	const { ranges, partial, hidden } = placePmSuggestions(
		doc,
		[
			at('start', 'gamma', 'alpha'),
			at('end', '', ' more', source.indexOf('beta}') + 4),
			at('link', 'guide', 'docs'),
			at('across', 'new}', 'old} thi')
		],
		'tex'
	);
	expect([...partial, ...hidden]).toEqual([]);
	const old = Object.fromEntries(ranges.map((r) => [r.id, r.old]));
	expect(old).toEqual({
		start: [{ text: 'alpha', tags: ['strong'] }],
		end: [{ text: ' more', tags: ['strong'] }],
		link: [{ text: 'docs', tags: ['a'] }],
		across: [
			{ text: 'old', tags: ['strong'] },
			{ text: ' thi', tags: [] }
		]
	});
});

it('draws typed words around a formula as words, and a formula among old words as a region', () => {
	const source = '\\begin{document}\nSome text here. Typed before $a$ and after it.\n\nA second paragraph stays.\n\\end{document}\n';
	const doc = parseLatexFile(source).doc;
	const at = (id: string, words: string, restore: string) => {
		const from = source.indexOf(words);
		return { id, from, to: from + words.length, restore, mine: true, anchor: buildAnchor(source, from, from + words.length) };
	};
	const { ranges, partial } = placePmSuggestions(
		doc,
		[at('typed', ' Typed before $a$ and after it.', ''), at('gone', 'stays', 'held $b$')],
		'tex'
	);
	expect([...partial]).toEqual(['gone']);
	const typed = ranges.find((r) => r.id === 'typed')!;
	expect(doc.textBetween(typed.from, typed.to)).toBe(' Typed before a and after it.');
	expect(doc.resolve(typed.to).parent.type.name).toBe('paragraph');
});

it('outlines every paragraph a suggestion spans when only its middle can be placed', () => {
	const source = '\\begin{document}\nOne stays.\n\n\\foo{a}\n\nmiddle words here\n\n\\foo{b}\n\nLast stays.\n\\end{document}\n';
	const doc = parseLatexFile(source).doc;
	const from = source.indexOf('\\foo{a}');
	const to = source.indexOf('\\foo{b}') + '\\foo{b}'.length;
	const mark = { id: 'wide', from, to, restore: '', mine: true, anchor: buildAnchor(source, from, to) };
	const { ranges } = placePmSuggestions(doc, [mark], 'tex');
	expect(ranges[0].partial).toBe(true);
	expect(doc.textBetween(ranges[0].from, ranges[0].to, '|')).toBe('\\foo{a}|middle words here|\\foo{b}');
});

it('marks the same words with other formatting as a format change', () => {
	const source = '\\begin{document}\nRefinement is \\textbf{driven} by an estimator.\n\\end{document}\n';
	const doc = parseLatexFile(source).doc;
	const from = source.indexOf('\\textbf{driven}');
	const to = from + '\\textbf{driven}'.length;
	const mark = { id: 'bold', from, to, restore: 'driven', mine: true, anchor: buildAnchor(source, from, to) };
	const [range] = placePmSuggestions(doc, [mark], 'tex').ranges;
	expect(range.format).toBe(true);
	expect(range.partial).toBe(false);
	expect(doc.textBetween(range.from, range.to)).toBe('driven');
	expect(range.old).toEqual([{ text: 'driven', tags: [] }]);
});

it('outlines a paragraph pulled into the heading before it, since the words change blocks', () => {
	const source = '\\begin{document}\n\\paragraph{Runin Prose follows the heading here.}\n\nNext paragraph stays.\n\\end{document}\n';
	const doc = parseLatexFile(source).doc;
	const words = 'Prose follows the heading here.}';
	const from = source.indexOf(words);
	const to = from + words.length;
	const mark = { id: 'merged', from, to, restore: '} Prose follows the heading here.', mine: true, anchor: buildAnchor(source, from, to) };
	const { ranges, partial } = placePmSuggestions(doc, [mark], 'tex');
	expect([...partial]).toEqual(['merged']);
	expect(doc.textBetween(ranges[0].from, ranges[0].to, '|')).toBe('Runin Prose follows the heading here.');
});

it('tints the copy the suggestion is in when the text around it repeats', () => {
	const source = '\\begin{document}\nThe cat sat on the mat today.\n\nThe cat sat on the mat today.\n\\end{document}\n';
	const doc = parseLatexFile(source).doc;
	const from = source.lastIndexOf('sat');
	const mark = (copy?: number) => ({
		id: 'again',
		from,
		to: from + 3,
		restore: 'lay',
		mine: true,
		anchor: buildAnchor(source, from, from + 3),
		...(copy === undefined ? {} : { copy: () => copy })
	});
	const second = doc.child(0).nodeSize;
	expect(placePmSuggestions(doc, [mark()], 'tex').ranges[0].from).toBeLessThan(second);
	expect(placePmSuggestions(doc, [mark(1)], 'tex').ranges[0].from).toBeGreaterThan(second);
});

it('tints only the chip a change sits in, and draws a removed accent as its letter', () => {
	const source =
		'\\begin{document}\nWe leave some room \\vspace{3cm} for the figure below.\n\n\\newpage\n\nThe Poincar map is the tool we use here.\n\n\\newpage\n\nThe end.\n\\end{document}\n';
	const doc = parseLatexFile(source).doc;
	const at = (id: string, words: string, restore: string, from = source.indexOf(words)) => ({
		id,
		from,
		to: from + words.length,
		restore,
		mine: true,
		anchor: buildAnchor(source, from, from + words.length)
	});
	const { ranges, partial } = placePmSuggestions(
		doc,
		[at('space', '3cm', '1.5cm'), at('break', 'newpage', 'clearpage'), at('accent', '', "\\'e", source.indexOf(' map'))],
		'tex'
	);
	expect([...partial]).toEqual([]);
	const chip = (id: string) => {
		const r = ranges.find((x) => x.id === id)!;
		return r.chip && doc.nodeAt(r.from)?.nodeSize === r.to - r.from ? doc.nodeAt(r.from)!.textContent.trim() : null;
	};
	expect(chip('space')).toBe('\\vspace{3cm}');
	expect(chip('break')).toBe('\\newpage');
	expect(ranges.find((r) => r.id === 'break')!.from).toBe(doc.child(0).nodeSize);
	expect(ranges.find((r) => r.id === 'accent')?.old).toEqual([{ text: 'é', tags: [] }]);
});

it('marks an old font group made ordinary bold as a format change', () => {
	const source = '\\begin{document}\nThe method is \\textbf{fast and small} on every input we tried.\n\\end{document}\n';
	const doc = parseLatexFile(source).doc;
	const from = source.indexOf('\\textbf');
	const to = source.indexOf('} on') + 1;
	const mark = { id: 'bold', from, to, restore: '{\\bf fast and small}', mine: true, anchor: buildAnchor(source, from, to) };
	const [range] = placePmSuggestions(doc, [mark], 'tex').ranges;
	expect(range.format).toBe(true);
	expect(range.partial).toBe(false);
	expect(doc.textBetween(range.from, range.to)).toBe('fast and small');
});
