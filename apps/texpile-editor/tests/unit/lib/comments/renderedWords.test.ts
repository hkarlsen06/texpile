import { it, expect } from 'vitest';
import { renderedWords } from '$lib/comments/renderedWords';

it('reads links in every dialect as tagged text', () => {
	expect(renderedWords('see \\href{https://x.y/a%b}{the \\textit{docs}} or \\url{https://a.b}', 'tex')).toEqual([
		[
			{ text: 'see ', tags: [] },
			{ text: 'the ', tags: ['a'] },
			{ text: 'docs', tags: ['a', 'em'] },
			{ text: ' or ', tags: [] },
			{ text: 'https://a.b', tags: ['a'] }
		]
	]);
	expect(renderedWords('see [the *docs*](https://x.y "title") now', 'md')).toEqual([
		[
			{ text: 'see ', tags: [] },
			{ text: 'the ', tags: ['a'] },
			{ text: 'docs', tags: ['a', 'em'] },
			{ text: ' now', tags: [] }
		]
	]);
	expect(renderedWords('see #link("https://x.y")[the docs] or #link("https://a.b")', 'typ')).toEqual([
		[
			{ text: 'see ', tags: [] },
			{ text: 'the docs', tags: ['a'] },
			{ text: ' or ', tags: [] },
			{ text: 'https://a.b', tags: ['a'] }
		]
	]);
	expect(renderedWords('an ![image](x.png) here', 'md')).toBeNull();
});

it('keeps words that close or open formatting the words around them hold', () => {
	expect(renderedWords('old} thi', 'tex')).toEqual([
		[
			{ text: 'old', tags: [] },
			{ text: ' thi', tags: [], closed: [''] }
		]
	]);
	expect(renderedWords('n \\textbf{ol', 'tex')).toEqual([
		[
			{ text: 'n ', tags: [] },
			{ text: 'ol', tags: ['strong'] }
		]
	]);
	expect(renderedWords('old** thi', 'md')).toEqual([
		[
			{ text: 'old', tags: [] },
			{ text: ' thi', tags: [], closed: ['strong'] }
		]
	]);
	expect(renderedWords('pha](https://x.y) beta', 'md')).toEqual([
		[
			{ text: 'pha', tags: [] },
			{ text: ' beta', tags: [], closed: ['a'] }
		]
	]);
	expect(renderedWords('old] thi', 'typ')).toEqual([
		[
			{ text: 'old', tags: [] },
			{ text: ' thi', tags: [], closed: [''] }
		]
	]);
	expect(renderedWords('a *b _c* d_', 'md')).toBeNull();
});
