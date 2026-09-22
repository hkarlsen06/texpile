// the macro-and-environment stage keeps the file's offsets through the math re-parse, where
// upstream's start every argument over from zero
import { describe, it, expect } from 'vitest';
import type { Node } from '@unified-latex/unified-latex-types';
import { parseLatex } from '$lib/languages/latex/parser/parser';
import { parseLatexFile } from '$lib/workspace/latexRoundtrip';

type Positioned = {
	type: string;
	content?: unknown;
	args?: { content: Node[] }[];
	position?: { start: { offset: number }; end: { offset: number } };
};

/** `type` nodes anywhere under `nodes`, with the bytes their positions name */
function slices(src: string, nodes: unknown[], type: string, out: string[] = []): string[] {
	for (const n of nodes as Positioned[]) {
		if (n.type === type) out.push(n.position ? src.slice(n.position.start.offset, n.position.end.offset) : '?');
		if (Array.isArray(n.content)) slices(src, n.content, type, out);
		for (const a of n.args ?? []) slices(src, a.content, type, out);
	}
	return out;
}

describe('the math re-parse keeps the file’s offsets', () => {
	it('a subscript inside a fraction is placed where it is in the file', () => {
		const src = 'see $\\frac{\\act_i-\\mu_i}{\\sigma_i}\\frac{c}{d}$ here';
		const root = parseLatex(src) as unknown as { content: unknown[] };
		expect(slices(src, root.content, 'macro')).toEqual(['\\frac', '\\act', '_', '\\mu', '_', '\\sigma', '_', '\\frac']);
		expect(slices(src, root.content, 'string')).toEqual(['see', 'i', '-', 'i', 'i', 'c', 'd', 'here']);
	});

	it('a math environment’s body is placed where it is in the file', () => {
		const src = 'x\n\\begin{align}\na_1 &= \\frac{b}{c} \\\\\nd &= e\n\\end{align}\ny';
		const root = parseLatex(src) as unknown as { content: unknown[] };
		expect(slices(src, root.content, 'string')).toEqual(['x', 'a', '1', '&', '=', 'b', 'c', 'd', '&', '=', 'e', 'y']);
	});

	it('an environment holding inline math with a subscript spans to its end', () => {
		const src = [
			'\\documentclass{article}',
			'\\begin{document}',
			'\\begin{theorem}',
			'For any $\\omega\\in\\mathbb{C}$ such that $\\Re\\omega_1 > -3/2$, we have',
			'\\begin{equation}',
			'\\nu_\\omega = \\frac{1}{2}',
			'\\end{equation}',
			'\\end{theorem}',
			'',
			'After.',
			'\\end{document}',
			''
		].join('\n');
		const parsed = parseLatexFile(src);
		expect(parsed.origins.defects).toEqual([]);
		const texts = parsed.origins.origins.map((o) => o.text);
		expect(texts[0]).toMatch(/^\\begin\{theorem\}[\s\S]*\\end\{theorem\}$/);
		expect(texts[texts.length - 1]).toBe('After.');
	});
});
