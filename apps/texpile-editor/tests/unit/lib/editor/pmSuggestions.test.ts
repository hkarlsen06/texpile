// @vitest-environment jsdom
import { it, expect } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { schema } from '$lib/languages/latex/schema/latexPMSchema';
import { buildAnchor } from '$lib/comments/anchor';
import { editMode, takeTypedSides } from '$lib/comments/activeSuggestions.svelte';
import { placePmSuggestions } from '$lib/editor/visual/extensions/pmSuggestionsPlace';
import { pmSuggestions, pmSuggestionsKey, setPmSuggestions } from '$lib/editor/visual/extensions/pmSuggestions';

const SOURCE =
	'\\begin{document}\n' +
	'Refinement is driven by an estimator.\n\n' +
	'On each patch we form the residual $r_j$ by inserting the reconstructed solution.\n';

function mark(id: string, words: string, restore: string, at = SOURCE.indexOf(words)) {
	return { id, from: at, to: at + words.length, restore, mine: false, anchor: buildAnchor(SOURCE, at, at + words.length) };
}

function mount() {
	const doc = schema.nodes.doc.create(null, [
		schema.nodes.paragraph.create(null, schema.text('Refinement is driven by an estimator.')),
		schema.nodes.paragraph.create(null, [
			schema.text('On each patch we form the residual '),
			schema.nodes.inline_math.create({ latex: 'r_j' }),
			schema.text(' by inserting the reconstructed solution.')
		])
	]);
	const place = document.createElement('div');
	document.body.appendChild(place);
	return new EditorView(place, { state: EditorState.create({ doc, plugins: [pmSuggestions()] }) });
}

it('draws old and new words in their paragraph, and keeps a region drawn across a join', () => {
	const view = mount();
	const end = SOURCE.indexOf('estimator.') + 'estimator.'.length;
	const placed = placePmSuggestions(
		view.state.doc,
		[mark('replace', 'driven', 'led'), mark('cut', '', ' It is cheap.', end), mark('formula', 'r_j', 'R_j^n')],
		'tex'
	);
	setPmSuggestions(view, placed.ranges);

	const [first, second] = [...view.dom.querySelectorAll('p')];
	const drawn = (p: Element, cls: string) => [...p.querySelectorAll(cls)].map((e) => e.textContent);
	expect(drawn(first, '.pm-suggest-new')).toEqual(['driven']);
	expect(drawn(first, '.pm-suggest-old')).toEqual(['led', ' It is cheap.']);
	expect(first.textContent).toBe('Refinement is leddriven by an estimator. It is cheap.');
	expect(second.classList.contains('pm-suggest-partial')).toBe(true);
	expect(drawn(second, '.pm-suggest-old')).toEqual([]);

	const boundary = view.state.doc.child(0).nodeSize;
	view.dispatch(view.state.tr.join(boundary));
	expect(view.dom.querySelectorAll('.pm-suggest-partial')).toHaveLength(1);
	view.destroy();
});

it('tints a formula among typed words, whose source the formula keeps as content', () => {
	const view = mount();
	const second = view.state.doc.child(0).nodeSize + 1;
	const to = second + view.state.doc.child(1).content.size;
	setPmSuggestions(view, [{ id: 'typed', from: second, to, restore: '', old: [], mine: true, partial: false }]);
	expect(view.dom.querySelector('.inline-math')?.classList.contains('pm-suggest-new')).toBe(true);
	view.destroy();
});

it('tints a format change without striking out the words it keeps', () => {
	const view = mount();
	const at = 1 + view.state.doc.child(0).textContent.indexOf('driven');
	const old = [{ text: 'driven', tags: [] }];
	setPmSuggestions(view, [
		{ id: 'f', from: at, to: at + 'driven'.length, restore: 'driven', old, mine: true, partial: false, format: true }
	]);
	expect([...view.dom.querySelectorAll('.pm-suggest-new')].map((e) => e.textContent)).toEqual(['driven']);
	expect(view.dom.querySelector('.pm-suggest-old')).toBeNull();
	view.destroy();
});

it('puts what is typed in front of old words when the arrow key put the caret there', () => {
	editMode.current = 'suggesting';
	const view = mount();
	const text = view.state.doc.child(0).textContent;
	const at = 1 + text.indexOf('driven');
	setPmSuggestions(view, [
		{ id: 'r', from: at, to: at + 'driven'.length, restore: 'led', old: [{ text: 'led', tags: [] }], mine: true, partial: false }
	]);
	view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at)));
	takeTypedSides();

	const pressed = view.someProp('handleKeyDown', (f) => f(view, new KeyboardEvent('keydown', { key: 'ArrowLeft' })));
	expect(pressed).toBe(true);
	expect(view.state.selection.head).toBe(at);
	view.dispatch(view.state.tr.insertText('mostly ', at));
	const [r] = pmSuggestionsKey.getState(view.state)!.ranges;
	expect(view.state.doc.textBetween(r.from, r.to)).toBe('driven');
	expect(view.dom.querySelector('p')?.textContent).toBe('Refinement is mostly leddriven by an estimator.');
	expect(takeTypedSides()).toEqual({ r: 'before' });
	view.destroy();
});
