// Content the editor creates has no source slice to fall back on: what the serializer writes
// must read back as the same document. Each case here used to change meaning on reload
// (findings T2, T3, T11, T15, T21 of the 2026-09-05 hunt).
import { describe, it, expect } from 'vitest';
import { serializeToTypst } from '$lib/languages/typst/visual/serializer';
import { typstToProseMirror } from '$lib/languages/typst/visual/converter';
import { typSchema } from '$lib/languages/typst/visual/schema';
import type { Node } from 'prosemirror-model';

const n = typSchema.nodes;
const m = typSchema.marks;
const text = (s: string, marks: string[] = []) =>
	typSchema.text(
		s,
		marks.map((name) => m[name].create())
	);
const para = (...content: Node[]) => n.paragraph.create(null, content);
const doc = (...blocks: Node[]) => n.doc.create(null, blocks);
const out = (...blocks: Node[]) => serializeToTypst(doc(...blocks));

/** the inline nodes of the first paragraph after a reparse, as [type or mark names, text] */
function reread(src: string): [string, string][] {
	const items: [string, string][] = [];
	typstToProseMirror(src)
		.doc.child(0)
		.forEach((c) => {
			items.push([
				c.isText ? c.marks.map((x) => x.type.name).join('+') : c.type.name,
				c.isText ? (c.text ?? '') : String(c.attrs.target ?? '')
			]);
		});
	return items;
}

describe('references (T2)', () => {
	it('text typed right after a ref does not extend its target', () => {
		const src = out(para(n.typ_ref.create({ target: 'k' }), text('s')));
		expect(src).toBe('#ref(<k>)s');
		expect(reread(src)).toEqual([
			['typ_ref', 'k'],
			['', 's']
		]);
	});

	it('an emphasised ref keeps its delimiters outside the marker', () => {
		const ref = n.typ_ref.create({ target: 'h' }).mark([m.em.create()]);
		expect(out(para(ref))).toBe('_#ref(<h>)_');
		expect(reread('_#ref(<h>)_')).toEqual([['typ_ref', 'h']]);
	});
});

describe('inline raw (T3)', () => {
	it('inline code holding a backtick takes the function form', () => {
		const src = out(para(text('a`b', ['code'])));
		expect(src).toBe('#raw("a`b")');
		expect(reread(src)).toEqual([['code', 'a`b']]);
	});
});

describe('line-start markers inside brackets (T11)', () => {
	it('a marker at the start of a cell, a caption or a mark body is escaped', () => {
		const cell = n.table_cell.create(null, para(text('- a')));
		const table = n.table.create(null, n.table_row.create(null, cell));
		expect(out(table)).toContain('[\\- a]');
		expect(out(para(text('= y', ['u'])))).toBe('#underline[\\= y]');
		expect(reread('#underline[\\= y]')).toEqual([['u', '= y']]);
		const term = n.term_item.create(null, [n.term_title.create(null, text('a: b')), para(text('desc'))]);
		expect(out(term)).toBe('/ a\\: b: desc');
	});
});

describe('intraword emphasis (T15)', () => {
	it('bold on part of a word takes the function form, which typst reads back as strong', () => {
		const src = out(para(text('un'), text('happy', ['strong']), text('ness')));
		expect(src).toBe('un#strong[happy]ness');
		expect(reread(src)).toEqual([
			['', 'un'],
			['strong', 'happy'],
			['', 'ness']
		]);
	});
});

describe('small editor-created drifts (T21)', () => {
	it('a header row below the first row is written as table.header', () => {
		const body = n.table_row.create(null, [n.table_cell.create(null, para(text('a'))), n.table_cell.create(null, para(text('b')))]);
		const head = n.table_row.create(null, [n.table_header.create(null, para(text('c'))), n.table_header.create(null, para(text('d')))]);
		const src = out(n.table.create(null, [body, head]));
		expect(src).toBe('#table(\n  columns: 2,\n  [a], [b],\n  table.header([c], [d]),\n)');
		const back = typstToProseMirror(src + '\n').doc.child(0);
		expect(back.type.name).toBe('table');
		expect(back.child(1).child(0).type.name).toBe('table_header');
	});

	it('the dash and ellipsis characters go out as the shorthand typst sources write them', () => {
		expect(out(para(text('a \u2014 b \u2013 c\u2026 d')))).toBe('a --- b -- c... d');
		const back = typstToProseMirror('a --- b -- c... d\n').doc.child(0);
		expect(back.textContent).toBe('a \u2014 b \u2013 c\u2026 d');
	});

	it('a dash or ellipsis next to a hyphen or a dot stays the character, not a shorthand that would fuse', () => {
		expect(out(para(text('x-\u2013y \u2026. z')))).toBe('x-\u2013y \u2026. z');
		expect(typstToProseMirror('x-\u2013y \u2026. z\n').doc.child(0).textContent).toBe('x-\u2013y \u2026. z');
	});

	it('emphasis over whitespace only emits no delimiters', () => {
		expect(out(para(text('a'), text(' ', ['em']), text('b')))).toBe('a b');
	});

	it('a space typed after a hard break survives', () => {
		const src = out(para(text('a'), n.hard_break.create({ lineBreak: true }), text(' b')));
		expect(typstToProseMirror(src + '\n').doc.child(0).textContent).toBe('a b');
	});

	it('an unnumbered heading has a typst form', () => {
		const src = out(n.heading.create({ level: 2, numbered: false }, text('Intro')));
		expect(src).toBe('#heading(level: 2, numbering: none)[Intro]');
		const back = typstToProseMirror(src + '\n').doc.child(0);
		expect(back.type.name).toBe('heading');
		expect(back.attrs.numbered).toBe(false);
	});
});
