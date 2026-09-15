import { it, expect, vi } from 'vitest';
import { buildAnchor } from '$lib/comments/anchor';
import { openEvent, replyEvent } from '$lib/comments/log';

let disk = '';

vi.mock('$lib/workspace/fileSystem', () => ({
	readTextFile: async () => disk,
	writeTextFile: async (_path: string, text: string) => {
		disk = text;
	}
}));
vi.mock('$lib/workspace/texpileDir', () => ({
	texpilePath: (root: string, name: string) => `${root}/.texpile/${name}`,
	ensureTexpileIgnore: async () => {}
}));

const { CommentStore } = await import('$lib/comments/store.svelte');

it('writes back the lines it cannot read, in place, and drops merge leftovers', async () => {
	const open = JSON.stringify(
		openEvent({ id: 't1', file: 'main.tex', by: 'ana', body: 'hi', anchor: buildAnchor('some text', 0, 4), at: 'now' })
	);
	const newer = JSON.stringify({ v: 1, t: 'someday', thread: 't1', by: 'bo', at: 'now' });
	disk = [open, '<<<<<<< HEAD', newer, '>>>>>>> branch', ''].join('\n');

	const store = new CommentStore();
	await store.load('/w');
	await store.append(replyEvent({ id: 'm2', thread: 't1', by: 'ana', body: 'ok', at: 'now' }));

	const lines = disk.trim().split('\n');
	expect(lines).toHaveLength(3);
	expect(lines[0]).toBe(open);
	expect(lines[1]).toBe(newer);
	expect(JSON.parse(lines[2]).t).toBe('reply');
});

it('serves staged events with the written ones, and says whether a discard dropped any', async () => {
	disk = '';
	const store = new CommentStore();
	await store.load('/w');
	const open = openEvent({
		id: 't1',
		file: 'main.tex',
		by: 'ana',
		body: '',
		anchor: buildAnchor('some text', 0, 4),
		at: 'now',
		restore: 'old'
	});
	store.stage(open);
	expect(store.serialize()).toBe(JSON.stringify(open) + '\n');
	expect(disk).toBe('');
	expect(store.discardStaged('other.tex')).toBe(false);
	expect(store.discardStaged('main.tex')).toBe(true);
	expect(store.serialize()).toBe('\n');
});
