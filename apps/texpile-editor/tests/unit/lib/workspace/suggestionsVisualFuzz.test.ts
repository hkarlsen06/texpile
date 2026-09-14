// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { EditorState } from 'prosemirror-state';
import { activeSuggestions } from '$lib/comments/activeSuggestions.svelte';
import { padTables } from '$lib/editor/visual/padTables';
import { computeBlockPatch, syncOrigAttrs } from '$lib/editor/visual/blockPatch';
import type { ParsedLatexFile } from '$lib/workspace/latexRoundtrip';
import { FORMATS, pick, prng, randomEdit, typed, type Format } from './visualEditsFuzz';

let disk: Record<string, string> = {};

vi.mock('$lib/workspace/fileSystem', () => ({
	readTextFile: async (path: string) => {
		const hit = Object.entries(disk).find(([k]) => path.replace(/\\/g, '/').endsWith(k));
		if (!hit) throw new Error(`ENOENT ${path}`);
		return hit[1];
	},
	writeTextFile: async (_path: string, text: string) => {
		disk['.texpile/comments.jsonl'] = text;
	},
	joinPath: (a: string, b: string) => `${a}/${b}`
}));
vi.mock('$lib/workspace/texpileDir', () => ({
	texpilePath: (root: string, name: string) => `${root}/.texpile/${name}`,
	ensureTexpileIgnore: async () => {}
}));
let who = 'me';
vi.mock('$lib/comments/author', () => ({ resolveAuthor: async () => who, forgetAuthor: () => {} }));

const { CommentsController } = await import('$lib/workspace/commentsController.svelte');

const ROOT = '/w';
const RUNS = Number(process.env.SUGGEST_VISUAL_RUNS ?? 12);

const paragraphs = (s: string) =>
	s
		.split(/\n[ \t\r]*\n\s*/)
		.map((p) => p.replace(/\s+/g, ''))
		.filter(Boolean)
		.join('\n\n');

async function session(f: Format, original: string, run: number): Promise<{ text: string; refused: number; log: string[] }> {
	disk = {};
	activeSuggestions.current = [];
	const rnd = prng(run * 104729);
	const rel = `doc.${f.name}`;
	const FILE = `${ROOT}/${rel}`;
	const log: string[] = [];
	let text = original;
	let visual = true;
	let meta!: ParsedLatexFile;
	let state!: EditorState;
	const mount = () => {
		meta = f.parse(text);
		state = EditorState.create({ doc: padTables(meta.doc) });
	};
	mount();
	const make = () =>
		new CommentsController({
			root: () => ROOT,
			preferredAuthor: () => who,
			openFileAt: () => {},
			activeText: () => text,
			mode: () => 'suggesting',
			rewraps: () => visual,
			applyEdit: async (e) => {
				const next = text.slice(0, e.from) + e.insert + text.slice(e.to);
				if (!visual) {
					text = next;
					return true;
				}
				const parsed = f.parse(next);
				if (parsed.preamble !== meta.preamble || parsed.postamble !== meta.postamble) {
					text = next;
					mount();
					return true;
				}
				const patch = computeBlockPatch(state.doc, parsed.doc);
				const tr = state.tr;
				if (patch) tr.replaceWith(patch.from, patch.to, patch.nodes);
				syncOrigAttrs(tr, parsed.doc);
				if (!tr.steps.length) return false;
				state = state.apply(tr);
				text = f.serialize(meta, state.doc);
				return true;
			},
			saveNow: () => {}
		});
	let ctl = make();
	await ctl.load(ROOT);
	ctl.reanchor(FILE, text);

	const steps = 3 + Math.floor(rnd() * 18);
	for (let i = 0; i < steps; i++) {
		who = rnd() < 0.8 ? 'me' : 'mei';
		const roll = rnd();
		if (roll < 0.08) {
			visual = !visual;
			if (visual) mount();
			log.push(visual ? 'to visual' : 'to source');
			continue;
		}
		if (roll < 0.14) {
			await ctl.suggestions.beforeSave(rel, text);
			ctl = make();
			await ctl.load(ROOT);
			if (visual) mount();
			ctl.reanchor(FILE, text);
			log.push('save and reopen');
			continue;
		}
		if (visual) {
			const edit = randomEdit(state, rnd);
			if (!edit) continue;
			state = state.apply(edit.tr);
			log.push(edit.label);
			const next = f.serialize(meta, state.doc);
			if (next === text) continue;
			text = next;
		} else {
			const at = Math.floor(rnd() * (text.length + 1));
			const to = rnd() < 0.4 ? at : Math.min(text.length, at + Math.floor(rnd() * 12));
			const insert = rnd() < 0.2 ? pick(rnd, ['\n', '\n\n', ' ', '']) : typed(rnd);
			if (/[\uDC00-\uDFFF]/.test(text[at] ?? '') || /[\uDC00-\uDFFF]/.test(text[to] ?? '')) continue;
			log.push(`source [${at},${to}) ${JSON.stringify(text.slice(at, to))} -> ${JSON.stringify(insert)}`);
			text = text.slice(0, at) + insert + text.slice(to);
		}
		ctl.suggestions.textChanged(FILE, text);
		if (rnd() < 0.5) await new Promise((r) => setTimeout(r, 0));
		if (rnd() < 0.3) await ctl.suggestions.settle();
	}
	await ctl.suggestions.settle();
	let refused = 0;
	for (const t of ctl.threads.filter((x) => x.restore !== undefined && !x.resolved).sort(() => rnd() - 0.5)) {
		if (rnd() < 0.15) {
			visual = !visual;
			if (visual) mount();
		}
		if (!(await ctl.suggestions.reject(t))) refused++;
	}
	return { text, refused, log };
}

describe('suggestions made in the visual editor', () => {
	for (const f of FORMATS) {
		it(`${f.name}: gives back every word and paragraph once all are rejected`, async () => {
			const files = f.files.filter((p) => statSync(p).size < 20_000);
			const failures: string[] = [];
			for (let run = 1; run <= RUNS && failures.length < 2; run++) {
				const file = files[run % files.length];
				const original = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
				const r = await session(f, original, run);
				if (r.refused || paragraphs(r.text) !== paragraphs(original)) {
					const a = paragraphs(original);
					const b = paragraphs(r.text);
					let s = 0;
					while (s < a.length && a[s] === b[s]) s++;
					failures.push(
						`run ${run} (${file}): ${r.refused} refused\n original: …${JSON.stringify(a.slice(Math.max(0, s - 60), s + 80))}\n rejected: …${JSON.stringify(b.slice(Math.max(0, s - 60), s + 80))}\n steps: ${r.log.join(' | ')}`
					);
				}
			}
			expect(failures).toEqual([]);
		}, 600_000);
	}
});
