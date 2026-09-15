// @vitest-environment jsdom
// a guest keeps the host's suggestions placed while the text moves under it, and its decisions
// reach the host before the edit they cause
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildAnchor } from '$lib/comments/anchor';
import { openEvent, serializeLog, type CommentEvent } from '$lib/comments/log';
import { activeSuggestions } from '$lib/comments/activeSuggestions.svelte';

let disk: Record<string, string> = {};

vi.mock('$lib/workspace/fileSystem', () => ({
	readTextFile: async (path: string) => {
		const hit = Object.entries(disk).find(([k]) => path.replace(/\\/g, '/').endsWith(k));
		if (!hit) throw new Error(`ENOENT ${path}`);
		return hit[1];
	},
	writeTextFile: async () => {
		throw new Error('a guest has no disk');
	},
	joinPath: (a: string, b: string) => `${a}/${b}`
}));
vi.mock('$lib/workspace/texpileDir', () => ({
	texpilePath: () => null,
	ensureTexpileIgnore: async () => {}
}));
vi.mock('$lib/comments/author', () => ({ resolveAuthor: async () => 'guest', forgetAuthor: () => {} }));

const { CommentsController } = await import('$lib/workspace/commentsController.svelte');

const ROOT = 'session';
const FILE = `${ROOT}/main.tex`;
const TEXT = 'We prove the estimator is sharp for smooth solutions.\n';

function suggestion(id: string, text: string, words: string, restore: string) {
	const at = text.indexOf(words);
	return openEvent({ id, file: 'main.tex', anchor: buildAnchor(text, at, at + words.length), body: '', by: 'host', at: 'now', restore });
}

function guest(initial: string) {
	let text = initial;
	const trace: string[] = [];
	const ctl = new CommentsController({
		root: () => ROOT,
		preferredAuthor: () => 'guest',
		openFileAt: () => {},
		activeText: () => text,
		mode: () => 'editing',
		compares: () => false,
		publish: (e) => trace.push(`publish ${e.t}${e.t === 'resolve' ? ` ${e.decision ?? 'reopened'}` : ''}`),
		applyEdit: async (e) => {
			trace.push('edit');
			text = text.slice(0, e.from) + e.insert + text.slice(e.to);
			return true;
		},
		saveNow: () => {}
	});
	const remote = async (next: string) => {
		text = next;
		ctl.suggestions.textChanged(FILE, text);
		await ctl.suggestions.settle();
	};
	const join = async (log: CommentEvent[]) => {
		await ctl.load(null);
		ctl.adopt(serializeLog(log), FILE, text);
	};
	return { ctl, trace, join, remote, text: () => text };
}

describe('a guest in a shared session', () => {
	beforeEach(() => {
		disk = {};
		activeSuggestions.current = [];
	});

	it('puts the old words back after the host edited elsewhere, telling the host first', async () => {
		const g = guest(TEXT);
		await g.join([suggestion('s1', TEXT, 'sharp', 'reliable')]);
		await g.remote('Note. ' + TEXT);
		expect(activeSuggestions.current.map((s) => g.text().slice(s.from, s.to))).toEqual(['sharp']);
		expect(await g.ctl.suggestions.reject(g.ctl.threads[0])).toBe(true);
		expect(g.text()).toBe('Note. We prove the estimator is reliable for smooth solutions.\n');
		expect(g.trace).toEqual(['publish resolve rejected', 'edit']);
	});

	it('places a suggestion that arrives before the text it sits in', async () => {
		const g = guest(TEXT);
		await g.join([]);
		const after = TEXT.replace('sharp', 'tight');
		await g.ctl.ingest(suggestion('s2', after, 'tight', 'sharp'));
		expect(g.ctl.orphaned.has('s2')).toBe(true);
		await g.remote(after);
		expect(g.ctl.orphaned.has('s2')).toBe(false);
		expect(activeSuggestions.current.map((s) => [after.slice(s.from, s.to), s.restore])).toEqual([['tight', 'sharp']]);
	});
});
