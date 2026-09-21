import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import type { Node as PMNode } from 'prosemirror-model';
import { EditorState } from 'prosemirror-state';
import type { ParsedLatexFile } from '$lib/workspace/latexRoundtrip';
import { padTables } from '$lib/editor/visual/padTables';
import { formatImage } from '$lib/languages/markdown/visual/inlineSyntax';
import { FORMATS, pick, prng, randomEdit, typed, type Format } from './visualEditsFuzz';

const RUNS = Number(process.env.VISUAL_FUZZ_RUNS ?? 20);

type Cell = { ch: string; marks: string[] };

function visible(doc: PMNode, format: Format['name']): string[] {
	const lines: string[] = [];
	function cellsOf(node: PMNode): Cell[] {
		const plain = format === 'md' && node.type.name === 'image';
		const cells: Cell[] = [];
		node.forEach((child) => {
			if (child.isText) {
				for (const ch of child.text!) {
					const space = /\s/.test(ch);
					const marks = plain || space ? [] : child.marks.map((m) => (m.type.name === 'link' ? `link(${m.attrs.href})` : m.type.name));
					cells.push({ ch: space ? ' ' : ch, marks });
				}
			} else if (child.type.name === 'hard_break') {
				cells.push({ ch: plain ? ' ' : '⏎', marks: [] });
			} else {
				cells.push({
					ch: `‹${child.type.name}:${child.textContent.replace(/\s+/g, ' ').trim() || JSON.stringify(child.attrs)}›`,
					marks: []
				});
			}
		});
		return cells;
	}
	function render(cells: Cell[]): string {
		const word = (c: string) => /^[\p{L}\p{N}]$/u.test(c);
		const emphasis = (m: string) => /^(strong|em|s)$/.test(m);
		const head = cells.findIndex((c) => c.ch !== ' ' && c.ch !== '⏎' && !c.marks.includes('item_label'));
		if (head >= 0) for (let i = head; i < cells.length; i++) cells[i].marks = cells[i].marks.filter((m) => m !== 'item_label');
		if (format === 'md') {
			for (let i = 0; i < cells.length;) {
				if (!word(cells[i].ch)) {
					cells[i].marks = cells[i].marks.filter((m) => !emphasis(m));
					i++;
					continue;
				}
				let j = i;
				while (j < cells.length && word(cells[j].ch)) j++;
				const key = (k: number) => cells[k].marks.filter(emphasis).sort().join('+');
				if (cells.slice(i, j).some((_, k) => key(i + k) !== key(i)))
					for (let k = i; k < j; k++) cells[k].marks = cells[k].marks.filter((m) => !emphasis(m));
				i = j;
			}
		}
		let out = '';
		let key = '';
		for (const { ch, marks } of cells) {
			const k = [...marks].sort().join('+');
			if (ch !== ' ' && ch !== '⏎' && k !== key) {
				out += `«${k}»`;
				key = k;
			}
			out += ch;
		}
		out = out
			.replace(/\s+/g, ' ')
			.replace(/ ?⏎ ?/g, '⏎')
			.replace(/›(«[^»]*»)? /g, '›$1')
			.replace(/ («[^»]*»)?‹/g, '$1‹')
			.trim()
			.replace(/^⏎+/, '');
		if (format === 'md') out = out.replace(/⏎+$/, '');
		return out.replace(/^«»/, '');
	}
	function push(path: string, name: string, line: string) {
		let text = line;
		if (!text) return;
		const comments = format === 'typ' && name === 'paragraph' ? /^(‹inline_latex:\/[/*][^‹›]*›⏎?)+/.exec(text) : null;
		if (comments && comments[0].length < text.length) {
			push(path, name, comments[0]);
			text = text.slice(comments[0].length);
		}
		if (name === 'paragraph' && /^(‹inline_latex:[^‹›]*›⏎?)+$/.test(text)) {
			lines.push(`${path}raw_latex: ${text.replace(/‹inline_latex:|›|⏎|\s/g, '')}`);
		} else if (name === 'raw_latex') lines.push(`${path}raw_latex: ${text.replace(/\s/g, '')}`);
		else lines.push(`${path}${name}: ${text}`);
	}
	function typstDisplay(child: PMNode, path: string): boolean {
		const equation = (tex: string, label: unknown) => `${path}block_math: ${tex.replace(/\s+/g, ' ').trim()}${label ? ` <${label}>` : ''}`;
		if (child.type.name === 'block_math') {
			lines.push(equation(child.textContent, child.attrs.label));
			return true;
		}
		if (child.type.name !== 'paragraph') return false;
		const kids: PMNode[] = [];
		child.forEach((c) => {
			if (!c.isText || c.text!.trim()) kids.push(c);
		});
		const lead = kids.findIndex((c) => !(c.type.name === 'inline_latex' && /^\/[/*]/.test(c.textContent)));
		const [math, label, ...more] = lead < 0 ? [] : kids.slice(lead);
		if (math?.type.name !== 'inline_math' || !/^\s/.test(String(math.attrs.typst ?? '')) || more.length) return false;
		if (label && !(label.type.name === 'inline_latex' && /^<[^<>]*>$/.test(label.textContent))) return false;
		const comments = kids.slice(0, lead).map((c) => c.textContent);
		if (comments.length) push(path, 'raw_latex', comments.join(''));
		lines.push(equation(math.textContent, label?.textContent.slice(1, -1)));
		return true;
	}
	function walkBlocks(node: PMNode, path: string) {
		node.forEach((child, _offset, index) => {
			const name = child.type.name;
			if (format === 'typ' && typstDisplay(child, path)) return;
			if (node.type.name === 'list' && index > 0 && child.isTextblock) {
				const cells = cellsOf(child).map((c) => ({ ...c, marks: c.marks.filter((m) => m !== 'item_label') }));
				push(path, name, render(cells));
				return;
			}
			if (child.type.spec.code) {
				push(path, name, child.textContent.replace(/\s+/g, ' ').trim());
			} else if (format === 'md' && name === 'image') {
				push(
					path,
					'paragraph',
					`‹inline_latex:${formatImage(String(child.attrs.alt ?? ''), String(child.attrs.src ?? ''), render(cellsOf(child)))}›`
				);
			} else if (format === 'typ' && name === 'image' && child.attrs.showCaption === false) {
				lines.push(`${path}${name}`);
			} else if (format === 'md' && /^table_(cell|header)$/.test(name)) {
				const cells: Cell[] = [];
				child.forEach((p) => {
					const own = cellsOf(p);
					if (!own.some((c) => c.ch !== ' ' && c.ch !== '⏎')) return;
					if (cells.length) cells.push({ ch: '⏎', marks: [] });
					cells.push(...own);
				});
				push(`${path}${name}>`, 'paragraph', render(cells));
			} else if (child.isTextblock) {
				push(path, `${name}${child.attrs.level ?? ''}`, render(cellsOf(child)));
			} else if (child.isLeaf || child.isAtom) {
				lines.push(`${path}${name}`);
			} else {
				walkBlocks(child, `${path}${name}>`);
			}
		});
	}
	walkBlocks(doc, '');
	return lines.reduce<string[]>((out, line) => {
		const prev = out[out.length - 1];
		const raw = /^(.*?)raw_latex: (.*)$/;
		const a = prev && raw.exec(prev);
		const b = raw.exec(line);
		if (a && b && a[1] === b[1]) out[out.length - 1] = `${a[1]}raw_latex: ${a[2]}${b[2]}`;
		else out.push(line);
		return out;
	}, []);
}

function printed(line: string, format: Format['name']): string {
	if (format === 'tex')
		return line.replace(/’/g, "'").replace(/‘/g, '`').replace(/“/g, '``').replace(/”/g, "''").replace(/—/g, '---').replace(/–/g, '--');
	if (format === 'typ') return line.replace(/…/g, '...').replace(/—/g, '---').replace(/–/g, '--');
	return line;
}

function wordsOf(line: string): string {
	return line
		.slice(line.indexOf(': ') + 2)
		.replace(/«[^»]*»|‹[a-z_]+:|›/g, '')
		.replace(/\s+/g, '');
}

function firstDiff(a: string[], b: string[], byWords: boolean): string {
	const aw = byWords ? a.map(wordsOf).join('') : '';
	const bw = byWords ? b.map(wordsOf).join('') : '';
	if (byWords) {
		let i = 0;
		while (i < aw.length && aw[i] === bw[i]) i++;
		return `  edited:   …${JSON.stringify(aw.slice(Math.max(0, i - 40), i + 40))}\n  reopened: …${JSON.stringify(bw.slice(Math.max(0, i - 40), i + 40))}`;
	}
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		if (a[i] !== b[i]) {
			const x = a[i] ?? '';
			const y = b[i] ?? '';
			let k = 0;
			while (k < x.length && x[k] === y[k]) k++;
			const from = Math.max(0, k - 80);
			return `  edited:   ${JSON.stringify(x.slice(from, k + 80))}\n  reopened: ${JSON.stringify(y.slice(from, k + 80))}`;
		}
	}
	return '';
}

function textDiff(a: string, b: string): string {
	let s = 0;
	while (s < a.length && a[s] === b[s]) s++;
	let e = 0;
	while (e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e++;
	// VISUAL_FUZZ_CONTEXT widens the window shown around the first difference
	const width = Number(process.env.VISUAL_FUZZ_CONTEXT ?? 300);
	const cut = (x: string) => JSON.stringify(x.slice(Math.max(0, s - 40), Math.min(x.length - e + 20, s + width)));
	return `  was:    ${cut(a)}\n  became: ${cut(b)}`;
}

type Failure = { kind: string; detail: string; shape?: string };

function shapeOf(a: string, b: string): string {
	let s = 0;
	while (s < a.length && a[s] === b[s]) s++;
	let e = 0;
	while (e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e++;
	const fold = (x: string) =>
		x
			.slice(0, 60)
			.replace(/[A-Za-z]+/g, 'a')
			.replace(/[0-9]+/g, '0')
			.replace(/[^\p{ASCII}‹›«»⏎]+/gu, 'u');
	return `${fold(a.slice(s, a.length - e))} => ${fold(b.slice(s, b.length - e))}`;
}

function reopenFailure(f: Format, parsed: ParsedLatexFile, doc: PMNode): Failure | null {
	let saved: string;
	try {
		saved = f.serialize(parsed, doc);
	} catch (e) {
		return { kind: 'serializer throws', detail: String(e) };
	}
	const again = f.parse(saved);
	if (again.preamble !== parsed.preamble) return { kind: 'preamble changes', detail: textDiff(parsed.preamble, again.preamble) };
	const want = visible(doc, f.name).map((l) => printed(l, f.name));
	const got = visible(padTables(again.doc), f.name).map((l) => printed(l, f.name));
	const ww = want.map(wordsOf).join('');
	const gw = got.map(wordsOf).join('');
	if (ww !== gw) return { kind: 'words change on reopen', detail: firstDiff(want, got, true), shape: shapeOf(ww, gw) };
	if (want.join('\n') !== got.join('\n'))
		return {
			kind: 'structure or marks change on reopen',
			detail: firstDiff(want, got, false),
			shape: shapeOf(want.join('\n'), got.join('\n'))
		};
	return null;
}

function sourceEdit(text: string, rnd: () => number): string {
	const at = Math.floor(rnd() * (text.length + 1));
	const to = rnd() < 0.5 ? at : Math.min(text.length, at + Math.floor(rnd() * 12));
	const insert = rnd() < 0.3 ? pick(rnd, ['\n', '\n\n', ' ']) : typed(rnd);
	return text.slice(0, at) + insert + text.slice(to);
}

function chain(f: Format, source: string, seed: number, failures: Failure[]) {
	const rnd = prng(seed);
	let text = source;
	let typedInSource = false;
	for (let round = 0; round < 4; round++) {
		const parsed = f.parse(text);
		const plain = f.serialize(parsed, parsed.doc);
		if (plain !== text) {
			failures.push({ kind: 'opening changes the file', detail: textDiff(text, plain) });
			return;
		}
		const opened = padTables(parsed.doc);
		const padded = f.serialize(parsed, opened);
		if (padded !== text) {
			failures.push({ kind: 'the first visual edit rewrites a table the editor padded', detail: textDiff(text, padded) });
			return;
		}
		const states = [EditorState.create({ doc: opened })];
		const labels: string[] = [];
		// VISUAL_FUZZ_STEPS raises the most edits a round makes, for a heavier session
		const steps = 1 + Math.floor(rnd() * Number(process.env.VISUAL_FUZZ_STEPS ?? 8));
		for (let i = 0; i < steps; i++) {
			const edit = randomEdit(states[states.length - 1], rnd);
			if (!edit) continue;
			states.push(states[states.length - 1].apply(edit.tr));
			labels.push(edit.label);
		}
		if (reopenFailure(f, parsed, states[states.length - 1].doc)) {
			for (let i = 1; i < states.length; i++) {
				const bad = reopenFailure(f, parsed, states[i].doc);
				if (!bad) continue;
				let saved: string;
				try {
					saved = textDiff(f.serialize(parsed, states[i - 1].doc), f.serialize(parsed, states[i].doc));
				} catch {
					saved = '';
				}
				const kind = typedInSource ? `${bad.kind} (after random source edits)` : bad.kind;
				failures.push({ kind, shape: bad.shape, detail: `  edit: ${labels[i - 1]}\n${bad.detail}\n  file:\n${saved}` });
				break;
			}
			return;
		}
		text = f.serialize(parsed, states[states.length - 1].doc);
		if (process.env.VISUAL_FUZZ_SOURCE !== '1') continue;
		const sourceEdits = Math.floor(rnd() * 3);
		for (let i = 0; i < sourceEdits; i++) text = sourceEdit(text, rnd);
		if (sourceEdits) typedInSource = true;
	}
}

describe('visual editor round trip', () => {
	for (const f of FORMATS) {
		it(`${f.name}: what is typed in the visual editor comes back when the file is opened again`, () => {
			const failures: Failure[] = [];
			const sources = f.files.map((p) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n'));
			if (!sources.length) return;
			const only = Number(process.env.VISUAL_FUZZ_ONLY ?? 0);
			for (let run = only || 1; run <= (only || RUNS); run++) {
				const source = sources[run % sources.length];
				const seen = failures.length;
				try {
					chain(f, source, run * 7919, failures);
				} catch (e) {
					failures.push({ kind: 'throws', detail: String((e as Error).stack ?? e).slice(0, 400) });
				}
				for (const x of failures.slice(seen)) x.detail = `  run ${run}: ${f.files[run % sources.length]}\n${x.detail}`;
			}
			const groups = new Map<string, Failure[]>();
			for (const x of failures) {
				const key = `${x.kind} | ${x.shape ?? ''}`;
				groups.set(key, [...(groups.get(key) ?? []), x]);
			}
			const report = [...groups]
				.sort((a, b) => a[0].localeCompare(b[0]))
				.map(([key, xs]) => `\n### ${f.name} ${xs.length}x ${key}\n${xs[0].detail}`);
			expect(report.join('\n')).toBe('');
		}, 600_000);
	}
});
