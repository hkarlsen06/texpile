import { describe, it, expect } from 'vitest';
import { gen, regen, docOf, para, marked } from './mdTestUtils';
import { mdSchema } from '$lib/languages/markdown/visual/schema';
import { markdownToProseMirror } from '$lib/languages/markdown/visual/converter';
import { serializeToMarkdown } from '$lib/languages/markdown/visual/serializer';

/** what typed text is written as, and what it reads back as */
function typed(text: string): { out: string; back: string; blocks: number } {
	const out = serializeToMarkdown(docOf(para(text)));
	const doc = markdownToProseMirror(out).doc;
	return { out, back: doc.textContent, blocks: doc.childCount };
}

describe('prose escaping', () => {
	// M9
	it('protects $, 1), entities and = runs', () => {
		for (const text of ['$x$ and $5-$10', '1) not a list', '&amp; &copy; &#123; AT&T', '===']) {
			const t = typed(text);
			expect(t.back, text).toBe(text);
			expect(t.blocks, text).toBe(1);
		}
		expect(gen('\\$x\\$\n')).toBe('\\$x\\$');
		expect(gen('1\\) not list\n')).toBe('1\\) not list');
		// the reader sees `&amp;`, and that is what the regenerated source must say again
		expect(gen('&amp;amp;\n')).toBe('\\&amp;');
		expect(typed('===').out).toBe('\\===');
	});

	// M30
	it('escapes after a newline inside a text node and drops leading indentation', () => {
		const t = typed('a\n1. b');
		expect(t.out).toBe('a\n1\\. b');
		expect(t.blocks).toBe(1);
		expect(markdownToProseMirror(typed('    code').out).doc.child(0).type.name).toBe('paragraph');
	});

	// M7
	it('keeps a trailing # in a heading', () => {
		expect(gen('# Rated \\#\n')).toBe('# Rated \\#');
		expect(gen('# \\#\n')).toBe('# \\#');
		expect(gen('# C#\n')).toBe('# C#');
		expect(regen('# Rated \\#\n')).toBe('# Rated \\#');
	});

	// M16
	it('drops a hard break with nothing after it', () => {
		const br = mdSchema.nodes.hard_break.create({ lineBreak: true });
		expect(serializeToMarkdown(docOf(para('a', br)))).toBe('a');
		const heading = mdSchema.nodes.heading.create({ level: 1 }, [mdSchema.text('a'), br, mdSchema.text('b')]);
		expect(serializeToMarkdown(docOf(heading))).toBe('# a<br>b');
	});

	// M21
	it('moves punctuation out of emphasis when a letter follows', () => {
		const out = serializeToMarkdown(docOf(para(marked('a.', 'em'), 'b')));
		expect(out).toBe('*a*.b');
		const first = markdownToProseMirror(out).doc.child(0).child(0);
		expect(first.marks.map((m) => m.type.name)).toEqual(['em']);
	});

	// M28
	it('writes inline math the parser reads back', () => {
		const math = (tex: string) => serializeToMarkdown(docOf(para(mdSchema.nodes.inline_math.create(null, mdSchema.text(tex)))));
		expect(math(' x ')).toBe('$x$');
		expect(math('a$b')).toBe('$a\\$b$');
		expect(markdownToProseMirror(math('a$b')).doc.child(0).child(0).type.name).toBe('inline_math');
	});

	// M3
	it('escapes pipes inside every kind of table cell content', () => {
		expect(gen('| a |\n|---|\n| `x\\|y` |\n')).toBe('| a |\n| --- |\n| `x\\|y` |');
		expect(gen('| a |\n|---|\n| $\\|x\\|$ |\n')).toBe('| a |\n| --- |\n| $\\|x\\|$ |');
		expect(gen('| a |\n|---|\n| [l](u\\|v) |\n')).toBe('| a |\n| --- |\n| [l](u\\|v) |');
		const cell = mdSchema.nodes.table_cell.create(null, para('x', mdSchema.nodes.hard_break.create({ lineBreak: true }), 'y'));
		const table = mdSchema.nodes.table.create(null, [mdSchema.nodes.table_row.create(null, [cell])]);
		expect(serializeToMarkdown(docOf(table))).toBe('|  |\n| --- |\n| x<br>y |');
	});
});
