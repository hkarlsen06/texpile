// the save check end to end, as the app wires it: the pipeline hands the queued text to the
// buffer, which checks it against the document on screen with the real parsers and serializers
// of each format, and what reaches the disk is what the buffer then holds
import { describe, it, expect } from 'vitest';
import { Fragment, type Node as PMNode } from 'prosemirror-model';
import { DocumentBuffer } from '$lib/workspace/documentBuffer.svelte';
import { SavePipeline, type SaveDeps } from '$lib/workspace/savePipeline.svelte';
import { parseLatexFile, type ParsedLatexFile } from '$lib/workspace/latexRoundtrip';
import { parseMarkdownFile } from '$lib/languages/markdown/visual/roundtrip';
import { parseTypstFile } from '$lib/languages/typst/visual/roundtrip';

const FILES: { name: string; path: string; parse: (t: string) => ParsedLatexFile; src: string; edited: string; kept: string }[] = [
	{
		name: 'latex',
		path: 'C:/ws/main.tex',
		parse: parseLatexFile,
		src: '\\documentclass{article}\n\\begin{document}\nAlpha   one. % keep\n\nBeta two.\n\nGamma three.\n\nDelta  four.\n\\end{document}\n',
		edited: 'Beta changed.',
		kept: 'Alpha   one. % keep'
	},
	{
		name: 'markdown',
		path: 'C:/ws/notes.md',
		parse: parseMarkdownFile,
		src: '# Title\n\nAlpha   one.\n\nBeta two.\n\nGamma three.\n',
		edited: 'Beta changed.',
		kept: 'Alpha   one.'
	},
	{
		name: 'typst',
		path: 'C:/ws/main.typ',
		parse: parseTypstFile,
		src: '= Title\n\nAlpha   one.\n\nBeta two.\n\nGamma three.\n',
		edited: 'Beta changed.',
		kept: 'Alpha   one.'
	}
];

function wire(reparse: (text: string, format: 'tex' | 'md' | 'typ') => Promise<PMNode | null>) {
	const writes: { path: string; content: string }[] = [];
	const rewrites: [number, string | null][] = [];
	// the deps read the buffer only once a write runs, after it is made below
	const deps: SaveDeps = {
		sessionEdit: () => {},
		isGuest: () => false,
		autosaveActive: () => true,
		clearDeleted: () => {},
		writeText: async (path, content) => {
			writes.push({ path, content });
		},
		getEol: () => '\n',
		getLoadedPath: () => buffer.path,
		getLiveContent: () => buffer.texSource,
		setDiskBaseline: () => {},
		setDirty: () => {},
		diskChanged: async () => false,
		recordDiskStamp: async () => {},
		raiseConflict: () => {}
	};
	const pipeline = new SavePipeline(deps);
	const buffer = new DocumentBuffer({
		scheduleSave: (path, content) => pipeline.schedule(path, content),
		discardQueuedSave: () => pipeline.discard(),
		writeNow: () => {},
		rebuildVisual: () => {},
		isVisualMode: () => true,
		noteLocalEdit: () => {},
		clearPendingAnchor: () => {},
		reparse,
		noteSaveRewrite: (n, d) => rewrites.push([n, d])
	});
	pipeline.verify = (path, content) => buffer.verifyForWrite(path, content);
	return { buffer, pipeline, writes, rewrites };
}

function withSecondParagraph(doc: PMNode, text: string): PMNode {
	const i = doc.child(0).type.name === 'paragraph' ? 1 : 2;
	const child = doc.child(i);
	const kids: PMNode[] = [];
	doc.forEach((c, _o, k) => kids.push(k === i ? child.type.create(child.attrs, child.type.schema.text(text), child.marks) : c));
	return doc.copy(Fragment.fromArray(kids));
}

describe('the save check as the app wires it', () => {
	for (const f of FILES) {
		it(`${f.name}: an edit is checked with the real parser and written as the buffer holds it`, async () => {
			const { buffer, pipeline, writes, rewrites } = wire((text) => Promise.resolve(f.parse(text).doc));
			buffer.openTex(f.path, f.src, '\n');
			buffer.adoptParsed(f.parse(f.src), f.src);
			buffer.onVisualChange(withSecondParagraph(buffer.visualDoc!, f.edited));
			pipeline.flush();
			await pipeline.whenIdle();
			expect(writes.map((w) => w.path)).toEqual([f.path]);
			expect(writes[0].content).toBe(buffer.texSource);
			expect(writes[0].content).toContain(f.edited);
			expect(writes[0].content).toContain(f.kept);
			expect(rewrites).toEqual([]);
		});
	}

	it('a file the reader disagrees on reaches the disk rewritten, and the buffer follows', async () => {
		const f = FILES[0];
		const stranger = parseLatexFile('\\documentclass{article}\n\\begin{document}\nNothing.\n\\end{document}\n').doc;
		const { buffer, pipeline, writes, rewrites } = wire(() => Promise.resolve(stranger));
		buffer.openTex(f.path, f.src, '\n');
		buffer.adoptParsed(f.parse(f.src), f.src);
		buffer.onVisualChange(withSecondParagraph(buffer.visualDoc!, f.edited));
		const queued = buffer.texSource;
		pipeline.flush();
		await pipeline.whenIdle();
		expect(writes[0].content).toBe(buffer.texSource);
		// the rewrite widened to the neighbours and no further: the block beyond them is the file's bytes
		expect(rewrites).toEqual([[3, expect.stringMatching(/reopen/)]]);
		expect(writes[0].content).toContain('Delta  four.');
		expect(writes[0].content.replace(/\s+/g, ' ')).toBe(queued.replace(/\s+/g, ' '));
	});
});
