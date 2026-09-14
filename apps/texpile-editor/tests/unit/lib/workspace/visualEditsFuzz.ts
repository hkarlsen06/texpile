import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Node as PMNode, MarkType } from 'prosemirror-model';
import type { EditorState, Transaction } from 'prosemirror-state';
import { canSplit } from 'prosemirror-transform';
import { parseLatexFile, serializeLatexFile, type ParsedLatexFile } from '$lib/workspace/latexRoundtrip';
import { parseMarkdownFile, serializeMarkdownFile } from '$lib/languages/markdown/visual/roundtrip';
import { parseTypstFile, serializeTypstFile } from '$lib/languages/typst/visual/roundtrip';

export type Format = {
	name: 'tex' | 'md' | 'typ';
	parse: (text: string) => ParsedLatexFile;
	serialize: (meta: ParsedLatexFile, doc: PMNode) => string;
	files: string[];
};

const FIXTURES = join(__dirname, '../../../fixtures');
const LIVE = join(__dirname, '../../../live/fixtures');
const DOCS = join(__dirname, '../../../../../../docs');

export function walk(dir: string, ext: RegExp, max = 400_000): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		if (name === '_draft') continue;
		const p = join(dir, name);
		const st = statSync(p);
		if (st.isDirectory()) out.push(...walk(p, ext, max));
		else if (ext.test(name) && st.size < max) out.push(p);
	}
	return out;
}

export const FORMATS: Format[] = [
	{
		name: 'tex',
		parse: (t) => parseLatexFile(t),
		serialize: serializeLatexFile,
		files: [join(FIXTURES, 'comments/feature-sweep.tex'), ...walk(LIVE, /\.tex$/, process.env.VISUAL_FUZZ_RUNS ? 120_000 : 16_000)]
	},
	{
		name: 'md',
		parse: (t) => parseMarkdownFile(t),
		serialize: serializeMarkdownFile,
		files: [join(FIXTURES, 'comments/feature-sweep.md'), join(FIXTURES, 'comments/guide.md'), ...walk(DOCS, /\.md$/)]
	},
	{
		name: 'typ',
		parse: (t) => parseTypstFile(t),
		serialize: serializeTypstFile,
		files: [join(FIXTURES, 'comments/feature-sweep.typ')]
	}
];
for (const dir of (process.env.VISUAL_FUZZ_CORPUS ?? '').split(';').filter(Boolean)) {
	for (const f of FORMATS) f.files.push(...walk(dir, new RegExp(`\\.${f.name}$`), 120_000));
}

const PIECES = [
	'a',
	'b',
	'x',
	'the',
	'word',
	'Foo',
	'42',
	'3.14',
	' ',
	' ',
	' ',
	'  ',
	' ',
	...'%$&#_{}~^\\*-+=/<>@[]()`|!"\'.,:;?',
	'--',
	'---',
	'...',
	'1.',
	'- ',
	'# ',
	'> ',
	'= ',
	'+ ',
	'\\\\',
	'//',
	'/*',
	'<!--',
	'\\section',
	'\\textbf{',
	'$x$',
	'*a*',
	'_b_',
	'[x](y)',
	'@key',
	'<lab>',
	'中文',
	'😀',
	'é'
];

export function prng(seed: number) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export function pick<T>(rnd: () => number, xs: T[]): T {
	return xs[Math.floor(rnd() * xs.length)];
}

export function typed(rnd: () => number): string {
	let s = '';
	const n = 1 + Math.floor(rnd() * 4);
	for (let i = 0; i < n; i++) s += pick(rnd, PIECES);
	return s;
}

export type Block = { node: PMNode; pos: number; cell: number };

export function proseBlocks(doc: PMNode): Block[] {
	const out: Block[] = [];
	let cell = -1;
	let cellEnd = -1;
	doc.descendants((node, pos) => {
		if (node.type.spec.code) return false;
		if (pos >= cellEnd) cell = -1;
		if (/^table_(cell|header)$/.test(node.type.name)) {
			cell = pos;
			cellEnd = pos + node.nodeSize;
		}
		if (node.isTextblock) {
			out.push({ node, pos, cell });
			return false;
		}
		return true;
	});
	return out;
}

export function spotIn(doc: PMNode, b: Block, rnd: () => number): number | null {
	for (let tries = 0; tries < 6; tries++) {
		const p = b.pos + 1 + Math.floor(rnd() * (b.node.content.size + 1));
		if (doc.resolve(p).parent === b.node) return p;
	}
	return b.node.content.size === 0 ? b.pos + 1 : null;
}

export type Edit = { label: string; tr: Transaction };

export function randomEdit(state: EditorState, rnd: () => number): Edit | null {
	const doc = state.doc;
	const blocks = proseBlocks(doc);
	if (!blocks.length) return null;
	const b = pick(rnd, blocks);
	const tr = state.tr;
	const roll = rnd();
	const at = spotIn(doc, b, rnd);
	if (at === null) return null;
	const where = `${b.node.type.name}@${b.pos} "${b.node.textContent.slice(0, 30)}"`;
	try {
		if (roll < 0.45) {
			const s = typed(rnd);
			tr.insertText(s, at);
			return { label: `type ${JSON.stringify(s)} at ${at - b.pos - 1} in ${where}`, tr };
		}
		if (roll < 0.6) {
			const other = spotIn(doc, b, rnd);
			if (other === null || other === at) return null;
			const [from, to] = [Math.min(at, other), Math.max(at, other)];
			const words = doc.textBetween(from, to, '', '*');
			tr.delete(from, to);
			return { label: `delete ${JSON.stringify(words)} in ${where}`, tr };
		}
		if (roll < 0.7) {
			const b2 = pick(rnd, blocks);
			if (b2.cell !== b.cell) return null;
			const other = spotIn(doc, b2, rnd);
			if (other === null) return null;
			const [from, to] = [Math.min(at, other), Math.max(at, other)];
			if (to - from > 400) return null;
			tr.delete(from, to);
			return { label: `delete across ${JSON.stringify(doc.textBetween(from, to, '|', '*'))} from ${where}`, tr };
		}
		if (roll < 0.8) {
			if (!canSplit(doc, at)) return null;
			tr.split(at);
			return { label: `split at ${at - b.pos - 1} in ${where}`, tr };
		}
		if (roll < 0.87) {
			const i = blocks.indexOf(b);
			if (i === 0) return null;
			const prev = blocks[i - 1];
			if (prev.cell !== b.cell) return null;
			tr.delete(prev.pos + prev.node.nodeSize - 1, b.pos + 1);
			return { label: `join ${where} onto the block before`, tr };
		}
		if (roll < 0.95) {
			const other = spotIn(doc, b, rnd);
			if (other === null || other === at) return null;
			const [from, to] = [Math.min(at, other), Math.max(at, other)];
			const marks = ['strong', 'em'].map((n) => doc.type.schema.marks[n]).filter(Boolean) as MarkType[];
			const mark = pick(rnd, marks);
			if (!b.node.type.allowsMarkType(mark)) return null;
			if (rnd() < 0.7) tr.addMark(from, to, mark.create());
			else tr.removeMark(from, to, mark);
			return { label: `${mark.name} ${JSON.stringify(doc.textBetween(from, to, '', '*'))} in ${where}`, tr };
		}
		const br = doc.type.schema.nodes.hard_break;
		const $at = doc.resolve(at);
		if (!br || !$at.parent.canReplaceWith($at.index(), $at.index(), br)) return null;
		tr.replaceWith(at, at, br.create());
		return { label: `line break at ${at - b.pos - 1} in ${where}`, tr };
	} catch {
		return null;
	}
}
