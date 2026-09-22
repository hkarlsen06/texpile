// turning edits to the open file into suggestions, and accepting or rejecting them
import { buildAnchor, type CommentAnchor } from '$lib/comments/anchor';
import { resolveExactly } from '$lib/comments/anchorSearch';
import {
	anchorEvent,
	deleteEvent,
	openEvent,
	resolveEvent,
	type CommentEvent,
	type CommentThread,
	type SuggestionDecision
} from '$lib/comments/log';
import {
	compareSuggestions,
	type ComparedSuggestions,
	type EditMode,
	type PlacedSuggestion,
	type TypingSide,
	type WhitespaceChanges
} from '$lib/comments/suggestCompare';
import { isOpenSuggestion, spotRanks, suggestionAuthor } from '$lib/comments/suggest';
import { carryGestures, type TextSpan } from '$lib/comments/editGestures';
import { commonEnds } from '$lib/comments/suggestHunks';
import { activeSuggestions, takeTypedSides, type SuggestionMark } from '$lib/comments/activeSuggestions.svelte';
import type { CommentStore } from '$lib/comments/store.svelte';

const SPACE_WAIT_MS = 1000;

export type SourceEdit = { from: number; to: number; insert: string };

type Deps = {
	store: CommentStore;
	activeFile: () => string | null;
	activeText: () => string;
	mode: () => EditMode;
	author: () => Promise<string>;
	commit: (...events: CommentEvent[]) => Promise<void>;
	publish: (event: CommentEvent) => void;
	applyEdit: (edit: SourceEdit) => Promise<boolean>;
	saveNow: () => void;
	compares: () => boolean;
	rewraps: () => boolean;
	onLost?: (file: string, lost: Set<string>) => void;
	dropped?: () => void;
};

type FileState = { text: string; placed: PlacedSuggestion[] };

/** an edit recorded for someone other than the reader: `gesture` is where it landed, `opened` what it opened */
type AgentEdit = { by: string; note: string; gesture: TextSpan; opened: string[] };

export class SuggestionsController {
	private states = new Map<string, FileState>();
	private placedFile: string | null = null;
	private seen: { path: string | null; file: string | null; text: string } | null = null;
	private gestures: TextSpan[] = [];
	private sides: Record<string, TypingSide> = {};
	private chain: Promise<void> = Promise.resolve();
	private timer: ReturnType<typeof setTimeout> | null = null;
	private me: string | null = null;

	constructor(private readonly deps: Deps) {}

	place(file: string, text: string): Set<string> {
		const known = this.states.get(file);
		const reopened = !known || file !== this.placedFile;
		this.placedFile = file;
		const against = reopened ? text : known.text;
		const carried = new Map(reopened ? [] : known.placed.map((s, i) => [s.id, { ...s, i }]));
		const { kept, lost } = this.fit(file, against, carried);
		const same = !reopened && sameSuggestions(known.placed, kept);
		this.states.set(file, { text: against, placed: kept });
		if (!same && file === this.deps.activeFile()) this.show(against, kept);
		// warmed whether or not anything is placed yet: resolving it spawns git, and the first comparison
		// awaits it, so the words deleted while it runs are already gone from the file with nothing drawn
		// where they were
		if (this.me === null) void this.learnAuthor();
		return lost;
	}

	private fit(file: string, against: string, carried: Map<string, PlacedSuggestion & { i: number }>) {
		const placed: PlacedSuggestion[] = [];
		const order = new Map<string, number>();
		const lost = new Set<string>();
		for (const t of this.deps.store.forFile(file).filter(isOpenSuggestion)) {
			const base = { id: t.id, restore: t.restore ?? '', author: suggestionAuthor(t) };
			const s = carried.get(t.id);
			const hit = s ? null : resolveExactly(against, t.anchor);
			if (s) placed.push({ ...base, from: s.from, to: s.to });
			else if (hit) placed.push({ ...base, from: hit.from, to: hit.to });
			else lost.add(t.id);
			order.set(t.id, s ? s.i : carried.size + (t.anchor.rank ?? 0));
		}
		placed.sort((a, b) => a.from - b.from || a.to - b.to || order.get(a.id)! - order.get(b.id)!);
		const kept: PlacedSuggestion[] = [];
		for (const s of placed) {
			const prev = kept[kept.length - 1];
			if (prev && s.from < prev.to) lost.add(s.id);
			else kept.push(s);
		}
		return { kept, lost };
	}

	clear(): void {
		this.placedFile = null;
		if (activeSuggestions.current.length) activeSuggestions.current = [];
	}

	textChanged(path: string | null, text: string): void {
		const same = this.seen && this.seen.path === path;
		const suggesting = this.deps.mode() === 'suggesting';
		this.gestures = same && suggesting ? carryGestures(this.gestures, this.seen!.text, text) : [];
		this.sides = same ? { ...this.sides, ...takeTypedSides() } : takeTypedSides();
		this.seen = { path, file: this.deps.activeFile(), text };
		if (this.timer) clearTimeout(this.timer);
		this.timer = setTimeout(
			() => {
				this.timer = null;
				void this.settle();
			},
			suggesting && this.onlySpaceSince(text) ? SPACE_WAIT_MS : 0
		);
	}

	private onlySpaceSince(text: string): boolean {
		const state = this.states.get(this.deps.activeFile() ?? '');
		if (!state) return false;
		const { start, end } = commonEnds(state.text, text);
		return state.text.length - end === start && /^\s+$/.test(text.slice(start, text.length - end));
	}

	settle(mode: EditMode = this.deps.mode()): Promise<void> {
		const file = this.deps.activeFile();
		return file ? this.run(file, this.deps.activeText(), mode) : this.chain;
	}

	async beforeSave(file: string, content: string): Promise<void> {
		await this.run(file, content, this.deps.mode());
		await this.recordAnchors(file, content);
		if (this.deps.store.hasStaged) await this.deps.store.append();
	}

	async adoptRemote(file: string, before: string, after: string): Promise<void> {
		const state = this.states.get(file);
		if (!state || state.text !== before) this.states.set(file, { text: before, placed: this.fit(file, before, new Map()).kept });
		await this.run(file, after, 'editing', 'paragraphs');
		await this.recordAnchors(file, after);
		if (this.deps.store.hasStaged) await this.deps.store.append();
	}

	private async recordAnchors(file: string, content: string): Promise<void> {
		const state = this.states.get(file);
		if (state?.text === content && state.placed.length) {
			const by = await this.deps.author();
			const at = new Date().toISOString();
			const threads = new Map(this.deps.store.forFile(file).map((t) => [t.id, t]));
			const ranks = spotRanks(state.placed);
			const moved: CommentEvent[] = [];
			for (const s of state.placed) {
				const was = threads.get(s.id)?.anchor;
				const now = anchorOf(content, s, ranks);
				if (was && (was.quote !== now.quote || was.prefix !== now.prefix || was.suffix !== now.suffix || was.rank !== now.rank)) {
					moved.push(anchorEvent({ thread: s.id, anchor: now, by, at }));
				}
			}
			this.stage(moved);
		}
	}

	async adoptDisk(file: string, text: string): Promise<void> {
		if (this.deps.store.hasStagedFor(file)) {
			this.discardUnsaved(file);
			return;
		}
		await this.run(file, text, 'editing', 'paragraphs');
		if (this.deps.store.hasStaged) await this.deps.store.append();
	}

	discardUnsaved(file: string): void {
		if (this.deps.store.discardStaged(file)) this.deps.dropped?.();
		this.states.delete(file);
		if (this.seen?.file === file) this.gestures = [];
	}

	async finish(): Promise<void> {
		const seen = this.seen;
		if (seen?.file && this.states.has(seen.file)) await this.run(seen.file, seen.text, this.deps.mode());
		if (this.deps.store.hasStaged) await this.deps.store.append();
		this.states.clear();
		this.seen = null;
		this.gestures = [];
		this.sides = {};
		this.placedFile = null;
		this.me = null;
	}

	async accept(t: CommentThread): Promise<void> {
		if (!isOpenSuggestion(t)) return;
		await this.settle();
		await this.decide(t, 'accepted');
		this.drop(t.file, t.id);
	}

	async reject(t: CommentThread): Promise<boolean> {
		const file = this.deps.activeFile();
		if (!isOpenSuggestion(t) || t.file !== file) return false;
		await this.settle();
		const text = this.deps.activeText();
		const state = this.states.get(file);
		const s = state?.text === text ? state.placed.find((x) => x.id === t.id) : undefined;
		if (!state || !s) return false;
		const decided = await this.decision(t, 'rejected');
		this.deps.publish(decided);
		if (!(await this.deps.applyEdit({ from: s.from, to: s.to, insert: s.restore }))) {
			this.deps.publish(await this.decision(t, undefined));
			return false;
		}
		const delta = s.restore.length - (s.to - s.from);
		const next = text.slice(0, s.from) + s.restore + text.slice(s.to);
		const at = state.placed.indexOf(s);
		const rest = state.placed
			.filter((x) => x.id !== s.id)
			.map((x) =>
				x.from > s.to || (x.from === s.to && state.placed.indexOf(x) > at) ? { ...x, from: x.from + delta, to: x.to + delta } : x
			);
		this.states.set(file, { text: next, placed: rest });
		await this.deps.store.append(decided);
		await this.run(file, this.deps.activeText(), 'editing');
		this.show(this.states.get(file)?.text ?? next, this.states.get(file)?.placed ?? rest);
		this.deps.saveNow();
		return true;
	}

	/**
	 * An edit made for someone else, an agent: applied to the open file and recorded as a suggestion by
	 * `by` whatever mode the reader is in, with `note` as its first message. The reader's own typing is
	 * compared first so it stays theirs. Resolves the new suggestion's id, or null when nothing was made.
	 */
	async suggestAs(by: string, edit: SourceEdit, note = ''): Promise<string | null> {
		const file = this.deps.activeFile();
		if (!file || !this.deps.compares()) return null;
		await this.settle();
		const before = this.deps.activeText();
		if (this.states.get(file)?.text !== before) return null;
		if (!(await this.deps.applyEdit(edit))) return null;
		const after = this.deps.activeText();
		// the edit's own landing, so the change it makes is one suggestion however many words it touches
		const { start, end } = commonEnds(before, after);
		const agent: AgentEdit = { by, note, gesture: { from: start, to: after.length - end }, opened: [] };
		this.seen = { path: this.seen?.path ?? null, file, text: after };
		this.gestures = [];
		await this.run(file, after, 'suggesting', undefined, agent);
		return agent.opened[0] ?? null;
	}

	private run(
		file: string,
		after: string,
		mode: EditMode,
		whitespace: WhitespaceChanges = this.deps.rewraps() ? 'paragraphs' : 'exact',
		agent?: AgentEdit
	): Promise<void> {
		const active = file === this.deps.activeFile();
		if (active && this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		const measured = this.seen?.file === file && this.seen.text === after;
		const gestures = agent ? [agent.gesture] : measured ? this.gestures : [];
		const sides = active && !agent ? this.sides : {};
		if (measured) this.gestures = [];
		if (active) this.sides = {};
		this.chain = this.chain.then(() => this.compare(file, after, mode, gestures, sides, whitespace, agent)).catch(() => undefined);
		return this.chain;
	}

	private async compare(
		file: string,
		after: string,
		mode: EditMode,
		gestures: TextSpan[],
		sides: Record<string, TypingSide>,
		whitespace: WhitespaceChanges,
		agent?: AgentEdit
	): Promise<void> {
		const state = this.states.get(file);
		if (!state || state.text === after) return;
		if (mode === 'editing' && state.placed.length === 0) {
			this.states.set(file, { text: after, placed: [] });
			if (!this.deps.compares()) this.refit(file);
			return;
		}
		const author = agent?.by ?? (await this.deps.author());
		if (!agent) this.me = author;
		const current = this.states.get(file);
		if (!current || current.text !== state.text) return;
		const r = compareSuggestions({
			before: current.text,
			after,
			pending: current.placed,
			mode,
			author,
			gestures,
			sides,
			whitespace,
			newId: () => crypto.randomUUID()
		});
		this.states.set(file, { text: after, placed: r.placed });
		if (!this.deps.compares()) return this.refit(file);
		for (const c of r.changes)
			if (agent && c.t === 'open' && r.placed.some((s) => s.id === c.id && s.author === author)) agent.opened.push(c.id);
		this.stage(this.eventsFor(file, after, r, author, agent?.note));
		if (file === this.deps.activeFile()) this.show(after, r.placed);
	}

	private refit(file: string): void {
		const state = this.states.get(file)!;
		const lost = this.place(file, state.text);
		const now = this.states.get(file)!;
		if (file === this.deps.activeFile()) this.show(now.text, now.placed);
		this.deps.onLost?.(file, lost);
	}

	private eventsFor(file: string, text: string, r: ComparedSuggestions, by: string, note = ''): CommentEvent[] {
		const at = new Date().toISOString();
		const placed = new Map(r.placed.map((s) => [s.id, s]));
		const ranks = spotRanks(r.placed);
		const out: CommentEvent[] = [];
		for (const c of r.changes) {
			const s = placed.get(c.id);
			if (c.t === 'open' && s) {
				const body = s.author === by ? note : '';
				out.push(openEvent({ id: s.id, file, by: s.author, body, anchor: anchorOf(text, s, ranks), at, restore: s.restore }));
			} else if (c.t === 'revise' && s) {
				out.push(anchorEvent({ thread: s.id, anchor: anchorOf(text, s, ranks), restore: s.restore, by, at }));
			} else if (c.t === 'close') {
				out.push(resolveEvent({ thread: c.id, resolved: true, decision: 'closed', by, at }));
			} else if (c.t === 'withdraw') {
				const answered = (this.deps.store.threads.find((x) => x.id === c.id)?.messages.length ?? 0) > 1;
				out.push(
					answered ? resolveEvent({ thread: c.id, resolved: true, decision: 'closed', by, at }) : deleteEvent({ thread: c.id, by, at })
				);
			}
		}
		return out;
	}

	private stage(events: CommentEvent[]): void {
		if (events.length === 0) return;
		this.deps.store.stage(...events);
		for (const e of events) this.deps.publish(e);
	}

	private async decide(t: CommentThread, decision: SuggestionDecision): Promise<void> {
		await this.deps.commit(await this.decision(t, decision));
	}

	private async decision(t: CommentThread, decision: SuggestionDecision | undefined): Promise<CommentEvent> {
		return resolveEvent({ thread: t.id, resolved: !!decision, decision, by: await this.deps.author(), at: new Date().toISOString() });
	}

	private drop(file: string, id: string): void {
		const state = this.states.get(file);
		if (!state) return;
		const placed = state.placed.filter((s) => s.id !== id);
		this.states.set(file, { text: state.text, placed });
		if (file === this.deps.activeFile()) this.show(state.text, placed);
	}

	private async learnAuthor(): Promise<void> {
		const me = await this.deps.author();
		if (me === this.me) return;
		this.me = me;
		const state = this.states.get(this.deps.activeFile() ?? '');
		if (state) this.show(state.text, state.placed);
	}

	private show(text: string, placed: PlacedSuggestion[]): void {
		const marks = placed.map((s) => {
			return { id: s.id, from: s.from, to: s.to, restore: s.restore, mine: s.author === this.me, anchor: buildAnchor(text, s.from, s.to) };
		});
		const shown = activeSuggestions.current;
		if (marks.length === shown.length && marks.every((m, i) => sameMark(m, shown[i]))) return;
		activeSuggestions.current = marks;
	}
}

function sameMark(a: SuggestionMark, b: SuggestionMark): boolean {
	return a.id === b.id && a.from === b.from && a.to === b.to && a.restore === b.restore && a.mine === b.mine;
}

function sameSuggestions(a: PlacedSuggestion[], b: PlacedSuggestion[]): boolean {
	return (
		a.length === b.length && a.every((s, i) => s.id === b[i].id && s.from === b[i].from && s.to === b[i].to && s.restore === b[i].restore)
	);
}

function anchorOf(text: string, s: PlacedSuggestion, ranks: Map<string, number>): CommentAnchor {
	const anchor = buildAnchor(text, s.from, s.to);
	const rank = ranks.get(s.id);
	return rank === undefined ? anchor : { ...anchor, rank };
}
