import { it, expect } from 'vitest';
import { schema } from '$lib/languages/latex/schema/latexPMSchema';
import { buildAnchor } from '$lib/comments/anchor';
import { placePmSuggestions } from '$lib/editor/visual/extensions/pmSuggestionsPlace';

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
