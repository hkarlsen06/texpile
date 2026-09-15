import { it, expect } from 'vitest';
import { renderSource, renderedWords } from '$lib/comments/renderedWords';

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

it('ends the block at the brace that closes the heading the words started in', () => {
	const prose = { text: 'Prose here.', tags: [] };
	expect(renderSource('Prose here.}', 'tex', { blockOpen: true })).toEqual({ words: [[prose], []], closed: [], open: [] });
	expect(renderSource('} Prose here.', 'tex', { blockOpen: true })).toEqual({ words: [[], [prose]], closed: [], open: [] });
	expect(renderSource('Prose here.', 'tex', { blockOpen: true })).toEqual({ words: [[prose]], closed: [], open: ['{'] });
	expect(renderSource('Prose here.}', 'tex')).toEqual({ words: [[prose]], closed: ['}'], open: [] });
});

it('ends the block at the line end of the heading the words started on', () => {
	const head = { text: 'P arsing', tags: [] };
	const rest = { text: 'The syntax', tags: [] };
	expect(renderSource('P arsing\nThe syntax', 'md', { blockOpen: true })).toEqual({ words: [[head], [rest]], closed: [], open: [] });
	expect(renderSource('P arsing\nThe syntax', 'typ', { blockOpen: true })).toEqual({ words: [[head], [rest]], closed: [], open: [] });
	expect(renderSource('P arsing\nThe syntax', 'md')).toEqual({
		words: [[{ text: 'P arsing The syntax', tags: [] }]],
		closed: [],
		open: []
	});
	expect(renderedWords('bullet.\n/ Another term', 'typ')).toEqual([[{ text: 'bullet.', tags: [] }], [{ text: 'Another term', tags: [] }]]);
});
