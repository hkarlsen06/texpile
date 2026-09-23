// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildAnchor } from '$lib/comments/anchor';
import { openEvent, parseLog, serializeLog } from '$lib/comments/log';
import { activeSuggestions } from '$lib/comments/activeSuggestions.svelte';

let disk: Record<string, string> = {};

vi.mock('$lib/workspace/fileSystem', () => ({
	readTextFile: async (path: string) => {
		const hit = Object.entries(disk).find(([k]) => path.replace(/\\/g, '/').endsWith(k));
		if (!hit) throw new Error(`ENOENT ${path}`);
		return hit[1];
	},
	writeTextFile: async (path: string, text: string) => {
		disk['.texpile/comments.jsonl'] = text;
	},
	joinPath: (a: string, b: string) => `${a}/${b}`
}));
vi.mock('$lib/workspace/texpileDir', () => ({
	texpilePath: (root: string, name: string) => `${root}/.texpile/${name}`,
	ensureTexpileIgnore: async () => {}
}));
let who = 'louis';
let authorCalls = 0;
vi.mock('$lib/comments/author', () => ({
	resolveAuthor: async () => {
		authorCalls++;
		return who;
	},
	forgetAuthor: () => {}
}));

const { CommentsController } = await import('$lib/workspace/commentsController.svelte');

const ROOT = '/w';
const FILE = `${ROOT}/main.tex`;
const TEXT = 'We prove the estimator is sharp for smooth solutions.\n';

function suggestion(id: string, text: string, words: string, restore: string, at = text.indexOf(words)) {
	return openEvent({ id, file: 'main.tex', anchor: buildAnchor(text, at, at + words.length), body: '', by: 'mei', at: 'now', restore });
}

function make(initial: string, mode: 'editing' | 'suggesting' = 'editing', name = 'main.tex') {
	let text = initial;
	const edits: { from: number; to: number; insert: string }[] = [];
	const ctl = new CommentsController({
		root: () => ROOT,
		preferredAuthor: () => 'louis',
		openFileAt: () => {},
		activeText: () => text,
		mode: () => mode,
		applyEdit: async (e) => {
			edits.push(e);
			text = text.slice(0, e.from) + e.insert + text.slice(e.to);
			return true;
		},
		saveNow: () => {}
	});
	const open = async () => {
		await ctl.load(ROOT);
		ctl.reanchor(`${ROOT}/${name}`, text);
	};
	return { ctl, edits, open, type: (next: string) => (text = next), text: () => text, setMode: (next: typeof mode) => (mode = next) };
}

const logged = () => parseLog(disk['.texpile/comments.jsonl'] ?? '');

describe('a suggestion in the file', () => {
	beforeEach(() => {
		disk = {};
		activeSuggestions.current = [];
	});

	it('keeps a Delete and an Add across a reopen, and places both', async () => {
		const at = TEXT.indexOf('sharp');
		disk['.texpile/comments.jsonl'] = serializeLog([suggestion('add', TEXT, 'sharp ', ''), suggestion('del', TEXT, '', 'very ', at)]);
		const { ctl, open } = make(TEXT);
		await open();
		expect(ctl.threads.map((t) => t.id).sort()).toEqual(['add', 'del']);
		expect(logged().some((e) => e.t === 'delete')).toBe(false);
		expect(ctl.orphaned.size).toBe(0);
		expect(activeSuggestions.current.map((s) => [s.id, s.from, s.to])).toEqual([
			['del', at, at],
			['add', at, at + 'sharp '.length]
		]);
	});

	it('puts the old words back only where the new words still are', async () => {
		disk['.texpile/comments.jsonl'] = serializeLog([suggestion('s1', TEXT, 'sharp', 'reliable')]);
		const { ctl, edits, open, text } = make(TEXT);
		await open();
		expect(await ctl.suggestions.reject(ctl.threads[0])).toBe(true);
		expect(text()).toBe('We prove the estimator is reliable for smooth solutions.\n');
		expect(logged().find((e) => e.t === 'resolve')).toMatchObject({ thread: 's1', decision: 'rejected' });

		const moved = make('We prove the estimator is blunt for smooth solutions.\n');
		disk['.texpile/comments.jsonl'] = serializeLog([suggestion('s2', TEXT, 'sharp', 'reliable')]);
		await moved.open();
		expect(moved.ctl.orphaned.has('s2')).toBe(true);
		expect(await moved.ctl.suggestions.reject(moved.ctl.threads[0])).toBe(false);
		expect(moved.edits).toEqual([]);
		expect(edits).toHaveLength(1);
	});

	it('keeps what was typed when the folder changes, and drops it when the edit is thrown away', async () => {
		const after = TEXT.replace('sharp', 'tight');
		const kept = make(TEXT, 'suggesting');
		await kept.open();
		kept.type(after);
		kept.ctl.suggestions.textChanged(FILE, after);
		const settling = kept.ctl.suggestions.settle();
		kept.ctl.reanchor(FILE, after);
		await settling;
		await kept.ctl.load('/elsewhere');
		expect(logged().find((e) => e.t === 'open')).toMatchObject({ restore: 'sharp', anchor: { quote: 'tight' } });

		disk = {};
		const thrown = make(TEXT, 'suggesting');
		await thrown.open();
		thrown.type(after);
		thrown.ctl.suggestions.textChanged(FILE, after);
		await thrown.ctl.suggestions.settle();
		thrown.ctl.suggestions.discardUnsaved('main.tex');
		await thrown.ctl.store.append();
		expect(logged().some((e) => e.t === 'open' && e.restore !== undefined)).toBe(false);
	});

	it('shows what is typed while suggesting as soon as typing starts', async () => {
		const { ctl, open, type } = make(TEXT, 'suggesting');
		await open();
		const after = TEXT.replace('sharp', 'tight');
		type(after);
		ctl.suggestions.textChanged(FILE, after);
		await new Promise((r) => setTimeout(r, 20));
		expect(activeSuggestions.current.map((s) => [after.slice(s.from, s.to), s.restore])).toEqual([['tight', 'sharp']]);
	});

	// resolving it spawns git, and the first comparison awaits it: anything deleted while that runs is
	// already gone from the file with nothing drawn where it was
	it('knows who is suggesting before the first comparison needs it', async () => {
		const before = authorCalls;
		const { open } = make(TEXT, 'suggesting');
		await open();
		await new Promise((r) => setTimeout(r, 0));
		expect(authorCalls).toBeGreaterThan(before);
	});

	// Editing: the Delete was made while suggesting, and the mode switched before the undo
	it.each(['suggesting', 'editing'] as const)('takes a Delete away again when the words are put back in %s', async (backIn) => {
		const { ctl, open, type, setMode } = make(TEXT, 'suggesting');
		await open();
		const cut = TEXT.replace('sharp ', '');
		type(cut);
		ctl.suggestions.textChanged(FILE, cut);
		await ctl.suggestions.settle();
		expect(activeSuggestions.current.map((s) => s.restore)).toEqual(['sharp ']);
		setMode(backIn);
		// an undo, or the same thing typed back by hand
		type(TEXT);
		ctl.suggestions.textChanged(FILE, TEXT);
		await ctl.suggestions.settle();
		expect(activeSuggestions.current).toEqual([]);
	});

	it('makes one suggestion of each phrase typed a key at a time, and rejecting them gives the text back', async () => {
		const start = 'Away from a shock a coarse grid resolves the flow.\n';
		const { ctl, open, type, text } = make(start, 'suggesting');
		await open();
		let now = start;
		async function keys(at: number, typed: string, over = 0) {
			for (let i = 0; i < typed.length; i++) {
				now = now.slice(0, at + i) + typed[i] + now.slice(at + i + (i === 0 ? over : 0));
				type(now);
				ctl.suggestions.textChanged(FILE, now);
				await new Promise((r) => setTimeout(r, 5));
			}
		}
		await keys(start.indexOf('a coarse grid'), 'one fine mesh', 'a coarse grid'.length);
		await keys(now.indexOf(' the flow'), ' all of');
		await ctl.suggestions.beforeSave('main.tex', now);
		expect(logged().flatMap((e) => (e.t === 'open' ? [[e.anchor.quote, e.restore]] : []))).toEqual([
			['one fine mesh', 'a coarse grid'],
			[' all of', '']
		]);
		for (const t of ctl.threads.filter((x) => !x.resolved)) expect(await ctl.suggestions.reject(t)).toBe(true);
		expect(text()).toBe(start);
	});

	// a .bib has no dialect of its own, so it anchors as LaTeX: braces and @ everywhere, and the
	// normalizer strips braces
	it('suggests in a .bib, and rejecting gives the entry back', async () => {
		const BIB = `@article{sharp2020,\n  title = {Shock capturing on coarse grids},\n  year = {2020}\n}\n`;
		const { ctl, open, type, text } = make(BIB, 'suggesting', 'refs.bib');
		await open();
		const after = BIB.replace('coarse', 'fine');
		type(after);
		await ctl.suggestions.beforeSave('refs.bib', after);
		expect(logged().flatMap((e) => (e.t === 'open' ? [[e.anchor.quote, e.restore]] : []))).toEqual([['fine', 'coarse']]);
		for (const t of ctl.threads.filter((x) => !x.resolved)) expect(await ctl.suggestions.reject(t)).toBe(true);
		expect(text()).toBe(BIB);
	});

	// one gesture should read as one card. A replacement whose first letter matches the word it
	// replaces leaves a point deletion plus an insertion at the same spot, which used to stay apart
	it('makes one suggestion of a replacement that starts with the same letter', async () => {
		const start = `A coarse grid resolves the flow.\n`;
		const { ctl, open, type, text } = make(start, 'suggesting');
		await open();
		let now = start;
		const at = start.indexOf('coarse');
		for (const [i, ch] of [...'crude'].entries()) {
			now = i === 0 ? start.slice(0, at) + ch + start.slice(at + 'coarse'.length) : now.slice(0, at + i) + ch + now.slice(at + i);
			type(now);
			ctl.suggestions.textChanged(FILE, now);
			await new Promise((r) => setTimeout(r, 5));
		}
		await ctl.suggestions.settle();
		expect(now).toBe(`A crude grid resolves the flow.\n`);
		// one card, and a replacement rather than a Delete beside an Add. The shared first letter is
		// left out of it on purpose: that letter did not change
		expect(activeSuggestions.current.map((s) => [s.restore, now.slice(s.from, s.to)])).toEqual([['oarse', 'rude']]);
		for (const t of ctl.threads.filter((x) => !x.resolved)) expect(await ctl.suggestions.reject(t)).toBe(true);
		expect(text()).toBe(start);
	});

	it('keeps two people’s Deletes at one spot in order across a reopen', async () => {
		const { ctl, open, type } = make(TEXT, 'suggesting');
		await open();
		const mine = TEXT.replace('estimator ', '');
		type(mine);
		await ctl.suggestions.beforeSave('main.tex', mine);
		who = 'mei';
		const both = mine.replace('the ', '');
		type(both);
		await ctl.suggestions.beforeSave('main.tex', both);
		who = 'louis';

		const reopened = make(both, 'suggesting');
		await reopened.open();
		for (const t of reopened.ctl.threads.filter((x) => !x.resolved)) expect(await reopened.ctl.suggestions.reject(t)).toBe(true);
		expect(reopened.text()).toBe(TEXT);
	});

	it('hands peers the whole log again when staged events they saw are thrown away', async () => {
		let resyncs = 0;
		let text = TEXT;
		const ctl = new CommentsController({
			root: () => ROOT,
			preferredAuthor: () => 'louis',
			openFileAt: () => {},
			activeText: () => text,
			mode: () => 'suggesting',
			applyEdit: async () => false,
			saveNow: () => {},
			resync: () => resyncs++
		});
		await ctl.load(ROOT);
		ctl.reanchor(FILE, text);
		ctl.suggestions.textChanged(FILE, text);
		text = TEXT.replace('sharp', 'tight');
		ctl.suggestions.textChanged(FILE, text);
		await ctl.suggestions.settle();
		expect(ctl.store.serialize()).toContain('"restore":"sharp"');
		ctl.suggestions.discardUnsaved('main.tex');
		ctl.suggestions.discardUnsaved('main.tex');
		expect(resyncs).toBe(1);
		expect(ctl.store.serialize()).toBe('\n');
	});

	it('records an agent’s rewrite as one suggestion of its own while the reader is editing, and keeps the reader’s typing theirs', async () => {
		const start = 'Away from a shock a coarse grid resolves the flow well enough for now.\n';
		const { ctl, open, type, text } = make(start, 'editing');
		await open();
		const typed = start.replace('for now', 'for this test');
		type(typed);
		ctl.suggestions.textChanged(FILE, typed);
		const words = 'a coarse grid resolves the flow well enough';
		const from = typed.indexOf(words);
		const id = await ctl.suggestions.suggestAs('Claude', { from, to: from + words.length, insert: 'coarse grids resolve it' }, 'Shorten');
		await ctl.suggestions.beforeSave('main.tex', text());
		const opened = logged().filter((e) => e.t === 'open');
		expect(opened).toEqual([
			expect.objectContaining({
				id,
				by: 'Claude',
				body: 'Shorten',
				restore: words,
				anchor: expect.objectContaining({ quote: 'coarse grids resolve it' })
			})
		]);
		expect(await ctl.suggestions.reject(ctl.threads[0])).toBe(true);
		expect(text()).toBe(typed);
	});

	it('writes what was typed while suggesting to the log before the file is saved', async () => {
		const { ctl, open, type } = make(TEXT, 'suggesting');
		await open();
		const after = TEXT.replace('sharp', 'tight');
		type(after);
		ctl.reanchor(FILE, after);
		await ctl.suggestions.beforeSave('main.tex', after);
		const opened = logged().find((e) => e.t === 'open');
		expect(opened).toMatchObject({ restore: 'sharp', anchor: { quote: 'tight' } });
	});
});
