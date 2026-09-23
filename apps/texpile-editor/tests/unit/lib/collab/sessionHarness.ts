// A shared session for the suggestion tests, wired the way the app wires it: the real session engine
// (sealed frames over a blind relay), the real materializer writing guest changes to the host's disk,
// one CommentsController per side, and real CodeMirror editors bound to the shared Y.Text through
// y-codemirror, the same binding the source editor uses. Each test file mocks the fs modules onto
// `disk` before importing this.
import * as Y from 'yjs';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { yCollab } from 'y-codemirror.next';
import { deriveSessionKeys } from '$lib/collab/e2e/keys';
import { generateShareCode } from '$lib/collab/e2e/shareCode';
import { CollabSession, textOf, type SessionEvents } from '$lib/collab/session';
import { HostMaterializer, changedSpans } from '$lib/collab/materialize';
import { isSafeCommentEvent, type RelayNotice } from '$lib/collab/protocol';
import type { Transport, TransportStatus } from '$lib/collab/transport';
import { parseLog, serializeLog, type CommentEvent, type CommentThread } from '$lib/comments/log';
import type { EditMode, PlacedSuggestion } from '$lib/comments/suggestCompare';
import { CommentsController } from '$lib/workspace/commentsController.svelte';
import { disk, resetDisk } from './sessionDisk';

export const FILE = 'main.tex';

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
		this.closed = false;
		this.hub.transports.add(this);
		setTimeout(() => this.onStatus?.('connected'), 0);
	}
	send(data: Uint8Array<ArrayBuffer>): void {
		if (!this.closed) this.hub.deliver(this, data);
	}
	/** drop off the relay without ending the session, as a lost connection does */
	drop(): void {
		this.closed = true;
		this.hub.transports.delete(this);
	}
	close(): void {
		this.drop();
	}
}

export async function until(cond: () => boolean, ms = 10000, what = 'condition'): Promise<void> {
	const t0 = Date.now();
	while (!cond()) {
		if (Date.now() - t0 > ms) throw new Error(`${what} not reached in time`);
		await new Promise((r) => setTimeout(r, 5));
	}
}

export const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

export const logged = () => parseLog(disk['.texpile/comments.jsonl'] ?? '');

/** the open suggestions a side holds, as [author, the words now, the words before] */
export function openSuggestions(threads: CommentThread[]): [string, string, string][] {
	return threads
		.filter((t) => t.restore !== undefined && !t.resolved)
		.map((t) => [t.messages[0].by, t.anchor.quote, t.restore!] as [string, string, string])
		.sort();
}

type Placed = PlacedSuggestion[];

/** where a controller has the suggestions on the file right now */
export function placedOn(ctl: CommentsController): { text: string; placed: Placed } | undefined {
	return (ctl.suggestions as unknown as { states: Map<string, { text: string; placed: Placed }> }).states.get(FILE);
}

/** the file with every placed suggestion rejected: what it said before anyone suggested anything */
export function withAllRejected(text: string, placed: Placed): string {
	let out = text;
	for (const s of [...placed].sort((a, b) => b.from - a.from || b.to - a.to)) out = out.slice(0, s.from) + s.restore + out.slice(s.to);
	return out;
}

/** a CodeMirror editor on a shared Y.Text, as the source editor mounts it in a session */
function sharedEditor(ytext: Y.Text, awareness: CollabSession['awareness'], onText: (text: string) => void) {
	const undo = new Y.UndoManager(ytext);
	const view = new EditorView({
		state: EditorState.create({
			doc: ytext.toString(),
			extensions: [
				yCollab(ytext, awareness, { undoManager: undo }),
				EditorView.updateListener.of((u) => {
					if (u.docChanged) onText(u.state.doc.toString());
				})
			]
		}),
		parent: document.body
	});
	return {
		view,
		undo,
		text: () => view.state.doc.toString(),
		change(from: number, to: number, insert: string) {
			view.dispatch({ changes: { from, to, insert }, userEvent: insert ? 'input.type' : 'delete' });
		},
		destroy: () => view.destroy()
	};
}

type Editor = ReturnType<typeof sharedEditor>;

/** typing and deleting in an editor the way a person does: one keystroke per transaction */
function keyboard(ed: Editor) {
	return {
		/** type `words` just before the first `mark` */
		type(words: string, mark: string) {
			for (const ch of words) {
				const at = ed.text().indexOf(mark);
				if (at < 0) throw new Error(`no "${mark}" in ${JSON.stringify(ed.text())}`);
				ed.change(at, at, ch);
			}
		},
		/** type `words` at an offset */
		typeAt(at: number, words: string) {
			for (const [i, ch] of [...words].entries()) ed.change(at + i, at + i, ch);
		},
		/** delete the first `words`, a backspace at a time from its end */
		erase(words: string) {
			const at = ed.text().indexOf(words);
			if (at < 0) throw new Error(`no "${words}" in ${JSON.stringify(ed.text())}`);
			for (let i = words.length; i > 0; i--) ed.change(at + i - 1, at + i, '');
		},
		/** select `words` and type over them */
		replace(words: string, by: string) {
			const at = ed.text().indexOf(words);
			if (at < 0) throw new Error(`no "${words}" in ${JSON.stringify(ed.text())}`);
			ed.change(at, at + words.length, by.slice(0, 1));
			if (by.length > 1) this.typeAt(at + 1, by.slice(1));
		}
	};
}

export type SessionOptions = {
	text: string;
	log?: CommentEvent[];
	/** whether the host has the file open in its editor */
	hostOpens?: boolean;
	/** false: an older host that never says whether it is suggesting */
	hostAdvertises?: boolean;
};

export async function startSession(o: SessionOptions) {
	resetDisk({ [FILE]: o.text, '.texpile/comments.jsonl': serializeLog(o.log ?? []) });
	const key = (await deriveSessionKeys(generateShareCode())).contentKey;
	const hub = new FakeHub();
	const cleanups: (() => void)[] = [];
	const party = (role: 'host' | 'guest', name: string, events: SessionEvents) => {
		const doc = new Y.Doc();
		const transport = new FakeTransport(hub, role);
		const session = new CollabSession({ doc, transport, key, role, user: { name, color: '#123456' }, events });
		transport.start();
		cleanups.push(() => session.destroy());
		return { doc, session, transport };
	};

	// host
	const host = party('host', 'louis', {
		onControl: (payload) => {
			if (payload.kind !== 'comment-event' || !isSafeCommentEvent(payload.event)) return;
			void hostCtl.ingest(payload.event);
			host.session.sendControl({ kind: 'comment-event', event: payload.event });
		},
		onBlobRequest: (name, from) => {
			if (name === 'comments') host.session.sendBlob('comments', 0, new TextEncoder().encode(hostCtl.store.serialize()), from);
		}
	});
	let hostMode: EditMode = 'editing';
	if (o.hostAdvertises !== false) host.session.setSuggesting(false);
	let hostEditor: Editor | null = null;
	let hostText = o.text;
	const hostCtl = new CommentsController({
		root: () => '/w',
		preferredAuthor: () => '',
		openFileAt: () => {},
		activeText: () => (hostEditor ? hostEditor.text() : hostText),
		mode: () => hostMode,
		publish: (event) => host.session.sendControl({ kind: 'comment-event', event }),
		applyEdit: async (e) => {
			if (!hostEditor) return false;
			hostEditor.change(e.from, e.to, e.insert);
			return true;
		},
		saveNow: () => {}
	});
	const writes: { tex: string; log: CommentEvent[] }[] = [];
	const mat = new HostMaterializer(
		host.doc,
		'/w',
		{
			readBytes: async (p) => new TextEncoder().encode(disk[p.replace(/^\/w\//, '')]),
			writeText: async (p, content) => {
				const rel = p.replace(/^\/w\//, '');
				if (rel === FILE) writes.push({ tex: content, log: logged() });
				disk[rel] = content;
			},
			listFiles: async () => [{ rel: FILE, size: disk[FILE].length }]
		},
		(root, rel) => `${root}/${rel}`
	);
	// as hostStore wires it
	mat.onWrite = (rel, content) => hostCtl.beforeRemoteWrite(rel, content);
	mat.senderOf = (origin) => host.session.senderOf(origin);
	mat.onRemoteChange = (rel, before, after, from, gestures) =>
		hostCtl.remoteEdit(rel, before, after, { ...host.session.authorOf(from), gestures });
	cleanups.push(() => mat.destroy());
	await mat.seed();
	await hostCtl.load('/w');

	function openOnHost(): void {
		const ytext = textOf(host.doc, FILE);
		// the app feeds the controller from an effect, so after the change has fully landed
		hostEditor = sharedEditor(ytext, host.session.awareness, (text) =>
			queueMicrotask(() => hostCtl.suggestions.textChanged('/w/' + FILE, text))
		);
		hostCtl.reanchor('/w/' + FILE, hostEditor.text());
		hostCtl.suggestions.textChanged('/w/' + FILE, hostEditor.text());
	}
	if (o.hostOpens !== false) openOnHost();

	const hostSide = {
		ctl: hostCtl,
		session: host.session,
		doc: host.doc,
		mat,
		writes,
		text: () => textOf(host.doc, FILE).toString(),
		get editor() {
			if (!hostEditor) throw new Error('the host has no editor open');
			return hostEditor;
		},
		get keys() {
			return keyboard(this.editor);
		},
		async mode(next: EditMode) {
			const was = hostMode;
			hostMode = next;
			host.session.setSuggesting(next === 'suggesting');
			if (next !== was) await hostCtl.suggestions.settle(was);
		},
		open() {
			if (!hostEditor) openOnHost();
		},
		close() {
			hostEditor?.destroy();
			hostEditor = null;
			hostText = '';
			hostCtl.reanchor(null, '');
		},
		/** the host's editor saving: its own comparison first, then the file */
		async save() {
			const text = hostEditor ? hostEditor.text() : hostText;
			await hostCtl.suggestions.beforeSave(FILE, text);
			disk[FILE] = text;
			mat.hostEdit(FILE, text);
		},
		/** drop off the relay and come back, the way a laptop lid does */
		away: () => host.transport.drop(),
		back: () => host.transport.start()
	};

	const guests: Awaited<ReturnType<typeof join>>[] = [];

	async function join(name: string) {
		let mode: EditMode = 'editing';
		const g = party('guest', name, {
			onControl: (payload) => {
				if (payload.kind === 'comment-event') void ctl.ingest(payload.event);
			},
			onBlob: (blob, _rev, bytes) => {
				if (blob === 'comments') ctl.adopt(new TextDecoder().decode(bytes), 'session/' + FILE, editor.text());
			}
		});
		const ytext = textOf(g.doc, FILE);
		await until(() => ytext.toString() === hostSide.text(), 10000, `${name} catching up`);
		const ctl = new CommentsController({
			root: () => 'session',
			preferredAuthor: () => name,
			openFileAt: () => {},
			activeText: () => editor.text(),
			mode: () => mode,
			compares: () => false,
			publish: (event) => g.session.sendControl({ kind: 'comment-event', event }),
			applyEdit: async (e) => {
				editor.change(e.from, e.to, e.insert);
				return true;
			},
			saveNow: () => {}
		});
		const editor = sharedEditor(ytext, g.session.awareness, (text) =>
			queueMicrotask(() => ctl.suggestions.textChanged('session/' + FILE, text))
		);
		cleanups.push(() => editor.destroy());
		// as workspaceComments wires it
		let running = ytext.toString();
		ytext.observe((ev) => {
			const before = running;
			running = ytext.toString();
			const who = g.session.senderOf(ev.transaction.origin);
			if (who === null || before === running || ctl.activeFile !== FILE) return;
			ctl.remoteEdit(FILE, before, running, { ...g.session.authorOf(who), gestures: changedSpans(ev.delta) });
		});
		await ctl.load(null);
		ctl.reanchor('session/' + FILE, editor.text());
		g.session.requestBlob('comments');
		await until(() => ctl.threads.length === hostCtl.threads.length, 10000, `${name} getting the log`);
		const side = {
			name,
			ctl,
			session: g.session,
			doc: g.doc,
			editor,
			keys: keyboard(editor),
			text: () => editor.text(),
			hostRecords: () => [...g.session.peers.values()].some((p) => p.role === 'host' && p.suggesting !== undefined),
			async mode(next: EditMode) {
				const was = mode;
				mode = next;
				g.session.setSuggesting(next === 'suggesting');
				await until(
					() => host.session.peers.get(g.doc.clientID)?.suggesting === (next === 'suggesting'),
					10000,
					`${name}'s mode reaching the host`
				);
				if (next !== was) await ctl.suggestions.settle(was);
			},
			away: () => g.transport.drop(),
			back: () => g.transport.start(),
			leave: () => g.session.destroy()
		};
		guests.push(side);
		return side;
	}

	/** everyone holds the same text, every comparison has run, and every event has arrived */
	async function quiet(): Promise<void> {
		for (let round = 0; round < 3; round++) {
			await until(() => guests.every((g) => g.text() === hostSide.text()), 10000, 'every copy agreeing');
			await tick(20);
			await hostCtl.suggestions.settle();
			for (const g of guests) await g.ctl.suggestions.settle();
			await mat.flushAll();
			await tick(20);
		}
	}

	return {
		host: hostSide,
		join,
		guests,
		quiet,
		close() {
			for (const c of cleanups.reverse()) c();
		}
	};
}

export type Session = Awaited<ReturnType<typeof startSession>>;
export type Guest = Awaited<ReturnType<Session['join']>>;
