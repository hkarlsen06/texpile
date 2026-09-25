import { it, expect } from 'vitest';
import { refinePrompt } from '$lib/ai/refinePrompt';

const ask = (path: string) => refinePrompt({ ask: 'Shorten it.', path, passage: 'Some words.', before: '', after: '' }).system;

it('tells the agent the format and extension of the file, but not its name or folder', () => {
	const typst = ask('C:/Users/mei/thesis/chapters/results.typ');
	expect(typst).toContain('a passage of a Typst file (.typ)');
	expect(typst).toContain('starting with "- "');
	expect(typst).not.toMatch(/results|thesis|mei/);
	expect(ask('paper/main.tex')).toContain('a LaTeX file (.tex). ');
	expect(ask('paper/main.tex')).toContain('itemize');
	expect(ask('notes.md')).toContain('a Markdown file (.md)');
	expect(ask('refs.bib')).toContain('a BibTeX file (.bib)');
	expect(ask('README')).toContain('a plain text file.');
});
