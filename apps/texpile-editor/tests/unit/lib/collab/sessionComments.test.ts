// @vitest-environment jsdom
// review comments between a host and a guest through the real session engine: sealed frames over a
// blind relay, the shared Y.Text, the materializer landing guest edits on the host's disk
import { it, expect, vi } from 'vitest';
import * as Y from 'yjs';
import { deriveSessionKeys } from '$lib/collab/e2e/keys';
import { generateShareCode } from '$lib/collab/e2e/shareCode';
import { CollabSession, textOf, type SessionEvents } from '$lib/collab/session';
import { HostMaterializer, EDIT_ORIGIN } from '$lib/collab/materialize';
import { isSafeCommentEvent } from '$lib/collab/protocol';
import type { RelayNotice } from '$lib/collab/protocol';
import type { Transport, TransportStatus } from '$lib/collab/transport';
import { buildAnchor } from '$lib/comments/anchor';
import { openEvent, parseLog, serializeLog, type CommentEvent } from '$lib/comments/log';

let disk: Record<string, string> = {};

vi.mock('$lib/workspace/fileSystem', () => ({
	readTextFile: async (path: string) => {
		const hit = Object.entries(disk).find(([k]) => path.replace(/\\/g, '/').endsWith(k));
		if (!hit) throw new Error(`ENOENT ${path}`);
		return hit[1];
	},
	writeTextFile: async (path: string, text: string) => {
		disk[path.replace(/\\/g, '/').replace(/^\/w\//, '')] = text;
	},
	joinPath: (a: string, b: string) => `${a}/${b}`
}));
vi.mock('$lib/workspace/texpileDir', () => ({
	texpilePath: (root: string, name: string) => `${root}/.texpile/${name}`,
	ensureTexpileIgnore: async () => {}
}));
vi.mock('$lib/comments/author', () => ({
	resolveAuthor: async (root: string | null) => (root === 'session' ? 'mei' : 'louis'),
	forgetAuthor: () => {}
}));

const { CommentsController } = await import('$lib/workspace/commentsController.svelte');

class FakeHub {
	transports = new Set<FakeTransport>();
	deliver(from: FakeTransport, data: Uint8Array): void {
		for (const t of this.transports) if (t !== from && !t.closed) setTimeout(() => t.onMessage?.(data, from.role === 'host'), 0);
	}
}

class FakeTransport implements Transport {
	onMessage: ((data: Uint8Array, fromHost: boolean) => void) | null = null;
	onNotice: ((n: RelayNotice) => void) | null = null;
	onStatus: ((s: TransportStatus, detail?: string) => void) | null = null;
	closed = false;
	constructor(
		private hub: FakeHub,
		readonly role: 'host' | 'guest'
	) {}
	start(): void {
		this.hub.transports.add(this);
		setTimeout(() => this.onStatus?.('connected'), 0);
	}
	send(data: Uint8Array<ArrayBuffer>): void {
		if (!this.closed) this.hub.deliver(this, data);
	}
	close(): void {
		this.closed = true;
		this.hub.transports.delete(this);
	}
}

async function until(cond: () => boolean, ms = 10000): Promise<void> {
	const t0 = Date.now();
	while (!cond()) {
		if (Date.now() - t0 > ms) throw new Error('condition not reached in time');
		await new Promise((r) => setTimeout(r, 10));
	}
}

const TEXT = 'We prove the estimator is sharp for smooth solutions.\n';
const logged = () => parseLog(disk['.texpile/comments.jsonl'] ?? '');

function suggestion(id: string, words: string, restore: string) {
	const at = TEXT.indexOf(words);
	return openEvent({ id, file: 'main.tex', anchor: buildAnchor(TEXT, at, at + words.length), body: '', by: 'louis', at: 'now', restore });
}

async function connect(log: CommentEvent[], hostOpens: string | null = '/w/main.tex') {
	disk = { 'main.tex': TEXT, '.texpile/comments.jsonl': serializeLog(log) };
	const key = (await deriveSessionKeys(generateShareCode())).contentKey;
	const hub = new FakeHub();
	const party = (role: 'host' | 'guest', events: SessionEvents) => {
		const doc = new Y.Doc();
		const transport = new FakeTransport(hub, role);
		const session = new CollabSession({ doc, transport, key, role, user: { name: role, color: '#123456' }, events });
		transport.start();
		return { doc, session };
	};

	let hostText = TEXT;
	const host = party('host', {
		onControl: (payload) => {
			if (payload.kind !== 'comment-event' || !isSafeCommentEvent(payload.event)) return;
			void hostCtl.ingest(payload.event);
			host.session.sendControl({ kind: 'comment-event', event: payload.event });
		},
		onBlobRequest: (name, from) => {
			if (name === 'comments') host.session.sendBlob('comments', 0, new TextEncoder().encode(hostCtl.store.serialize()), from);
		}
	});
	const hostCtl = new CommentsController({
		root: () => '/w',
		preferredAuthor: () => '',
		openFileAt: () => {},
		activeText: () => hostText,
		mode: () => 'editing',
		publish: (event) => host.session.sendControl({ kind: 'comment-event', event }),
		applyEdit: async () => false,
		saveNow: () => {}
	});
	const mat = new HostMaterializer(
		host.doc,
		'/w',
		{
			readBytes: async (p) => new TextEncoder().encode(disk[p.replace(/^\/w\//, '')]),
			writeText: async (p, content) => {
				disk[p.replace(/^\/w\//, '')] = content;
			},
			listFiles: async () => [{ rel: 'main.tex', size: disk['main.tex'].length }]
		},
		(root, rel) => `${root}/${rel}`
	);
	mat.onWrite = (rel, before, after) => hostCtl.adoptRemoteWrite(rel, before, after);
	await mat.seed();
	await hostCtl.load('/w');
	if (hostOpens) {
		textOf(host.doc, 'main.tex').observe(() => {
			hostText = textOf(host.doc, 'main.tex').toString();
			hostCtl.suggestions.textChanged(hostOpens, hostText);
		});
		hostCtl.reanchor(hostOpens, hostText);
		hostCtl.suggestions.textChanged(hostOpens, hostText);
	}

	let guestText = '';
	const guest = party('guest', {
		onControl: (payload) => {
			if (payload.kind === 'comment-event') void guestCtl.ingest(payload.event);
		},
		onBlob: (name, _rev, bytes) => {
			if (name === 'comments') guestCtl.adopt(new TextDecoder().decode(bytes), 'session/main.tex', guestText);
		}
	});
	const guestEdit = (from: number, to: number, insert: string) => {
		const t = textOf(guest.doc, 'main.tex');
		guest.doc.transact(() => {
			if (to > from) t.delete(from, to - from);
			if (insert) t.insert(from, insert);
		}, EDIT_ORIGIN);
	};
	const guestCtl = new CommentsController({
		root: () => 'session',
		preferredAuthor: () => 'mei',
		openFileAt: () => {},
		activeText: () => guestText,
		mode: () => 'editing',
		compares: () => false,
		publish: (event) => guest.session.sendControl({ kind: 'comment-event', event }),
		applyEdit: async (e) => {
			guestEdit(e.from, e.to, e.insert);
			return true;
		},
		saveNow: () => {}
	});
	textOf(guest.doc, 'main.tex').observe(() => {
		guestText = textOf(guest.doc, 'main.tex').toString();
		guestCtl.suggestions.textChanged('session/main.tex', guestText);
	});
	await guestCtl.load(null);
	await until(() => guestText === TEXT);
	guestCtl.reanchor('session/main.tex', guestText);
	guest.session.requestBlob('comments');
	await until(() => guestCtl.threads.length === log.length);

	return {
		hostCtl,
		guestCtl,
		mat,
		hostText: () => hostText,
		guestText: () => guestText,
		guestEdit,
		hostEdit(next: string) {
			hostText = next;
			hostCtl.suggestions.textChanged('/w/main.tex', next);
			mat.hostEdit('main.tex', next);
		},
		hostOpen(path: string | null) {
			hostText = path ? disk['main.tex'] : '';
			hostCtl.reanchor(path, hostText);
		},
		close() {
			mat.destroy();
			host.session.destroy();
			guest.session.destroy();
		}
	};
}

it('records a guest rejection as rejected on the host, for replaced and for inserted words', async () => {
	const s = await connect([suggestion('s1', 'sharp', 'reliable'), suggestion('s2', 'smooth ', '')]);

	s.hostEdit('Note. ' + TEXT);
	await until(() => s.guestText() === 'Note. ' + TEXT);
	await s.guestCtl.suggestions.settle();

	const thread = (id: string) => s.guestCtl.threads.find((t) => t.id === id)!;
	expect(await s.guestCtl.suggestions.reject(thread('s1'))).toBe(true);
	await until(() => logged().some((e) => e.t === 'resolve' && e.thread === 's1' && e.decision === 'rejected'));
	await until(() => s.hostText() === 'Note. We prove the estimator is reliable for smooth solutions.\n');
	await s.hostCtl.suggestions.settle();

	expect(await s.guestCtl.suggestions.reject(thread('s2'))).toBe(true);
	await until(() => logged().some((e) => e.t === 'resolve' && e.thread === 's2' && e.decision === 'rejected'));
	await until(() => disk['main.tex'] === 'Note. We prove the estimator is reliable for solutions.\n');
	await s.hostCtl.suggestions.settle();
	await s.hostCtl.store.append();

	expect(s.hostCtl.threads.map((t) => [t.id, t.resolved, t.decision])).toEqual([
		['s1', true, 'rejected'],
		['s2', true, 'rejected']
	]);
	expect(logged().filter((e) => e.t === 'delete')).toEqual([]);
	expect(s.guestCtl.threads.map((t) => [t.id, t.decision])).toEqual([
		['s1', 'rejected'],
		['s2', 'rejected']
	]);
	s.close();
});

it('keeps a suggestion placed when a guest edits a file the host does not have open', async () => {
	const s = await connect([suggestion('s1', 'sharp', 'reliable')], null);
	await s.guestCtl.suggestions.settle();

	s.guestEdit(TEXT.indexOf('sharp'), TEXT.indexOf('sharp'), 'now ');
	const moved = TEXT.replace('is sharp', 'is now sharp');
	await until(() => disk['main.tex'] === moved);
	await until(() => logged().some((e) => e.t === 'anchor' && e.thread === 's1' && e.anchor.prefix.endsWith('is now ')));

	s.hostOpen('/w/main.tex');
	expect(s.hostCtl.orphaned.has('s1')).toBe(false);
	s.hostOpen(null);

	s.guestEdit(moved.indexOf('sharp'), moved.indexOf('sharp') + 5, 'blunt');
	await until(() => disk['main.tex'] === moved.replace('sharp', 'blunt'));
	await until(() => logged().some((e) => e.t === 'resolve' && e.thread === 's1' && e.decision === 'closed'));
	await until(() => s.guestCtl.threads[0]?.decision === 'closed');
	s.close();
});

it('carries a plain thread both ways: open, reply, resolve, edit and delete a message', async () => {
	const s = await connect([]);
	const at = TEXT.indexOf('sharp');
	const id = (await s.guestCtl.openOn('main.tex', buildAnchor(TEXT, at, at + 5), 'is this sharp?'))!;
	await until(() => s.hostCtl.threads.some((t) => t.id === id));
	const hostThread = () => s.hostCtl.threads.find((t) => t.id === id)!;
	const guestThread = () => s.guestCtl.threads.find((t) => t.id === id)!;

	const reply = (await s.hostCtl.reply(hostThread(), 'yes, sharp'))!;
	await until(() => guestThread().messages.length === 2);
	await s.guestCtl.setResolved(guestThread(), true);
	await until(() => hostThread().resolved);
	await s.hostCtl.editMessage(hostThread().messages[1], 'yes, very sharp');
	await until(() => guestThread().messages[1].body === 'yes, very sharp');
	await s.guestCtl.removeMessage(guestThread(), guestThread().messages[1]);
	await until(() => hostThread().messages.length === 1);

	const shape = (t: { id: string; file: string; resolved: boolean; messages: { id: string; by: string; body: string }[] }) => ({
		id: t.id,
		file: t.file,
		resolved: t.resolved,
		messages: t.messages.map((m) => [m.id, m.by, m.body])
	});
	expect(shape(guestThread())).toEqual(shape(hostThread()));
	expect(shape(hostThread())).toEqual({ id, file: 'main.tex', resolved: true, messages: [[id, 'mei', 'is this sharp?']] });
	expect(logged().map((e) => e.t)).toEqual(['open', 'reply', 'resolve', 'edit', 'delete-message']);
	expect(logged().some((e) => e.t === 'reply' && e.id === reply && e.by === 'louis')).toBe(true);
	s.close();
});
