import { describe, expect, it } from 'vitest';
import { crossRefText } from '$lib/languages/latex/visual/extensions/drawn/crossRefText';
import { crossRefNamesFromPreamble } from '$lib/languages/latex/visual/extensions/drawn/crossRefNames';

const aux = {
	numbers: { 'fig:a': '3', 'fig:b': '4', 'eq:e': '2', 'sec:s': '5', 'lem:l': '1.2' },
	pages: { 'sec:s': '9' },
	kinds: { 'fig:a': 'figure', 'fig:b': 'figure', 'eq:e': 'equation', 'sec:s': 'section', 'lem:l': 'lemma' },
	titles: { 'sec:s': 'Results' }
};
const defaults = crossRefNamesFromPreamble('');

describe('crossRefText', () => {
	it("prints cleveref's and hyperref's words, plurals and equation parentheses", () => {
		expect(crossRefText('cref', ['fig:a'], aux, defaults).text).toBe('fig.\u00a03');
		expect(crossRefText('Cref', ['fig:a', 'fig:b'], aux, defaults).text).toBe('Figures\u00a03 and 4');
		expect(crossRefText('cref', ['eq:e', 'sec:s'], aux, defaults).text).toBe('eq.\u00a0(2) and section\u00a05');
		expect(crossRefText('autoref', ['sec:s'], aux, defaults).text).toBe('section\u00a05');
		expect(crossRefText('pageref', ['sec:s'], aux, defaults).text).toBe('9');
		expect(crossRefText('nameref', ['sec:s'], aux, defaults).text).toBe('Results');
	});

	it('follows the preamble, and prints a label the .aux does not know as itself', () => {
		const names = crossRefNamesFromPreamble(
			'\\usepackage[capitalise,noabbrev]{cleveref}\n\\crefname{lemma}{Lem.}{Lems.}\n\\renewcommand{\\sectionautorefname}{Section}'
		);
		expect(crossRefText('cref', ['fig:a'], aux, names).text).toBe('Figure\u00a03');
		expect(crossRefText('cref', ['lem:l'], aux, names).text).toBe('Lem.\u00a01.2');
		expect(crossRefText('autoref', ['sec:s'], aux, names).text).toBe('Section\u00a05');
		expect(crossRefText('cref', ['fig:missing'], aux, defaults)).toEqual({ text: 'fig:missing', known: false });
	});
});
