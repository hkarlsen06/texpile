// The workspace's comment log: read it, fold it, append to it.
//
// Lives at .texpile/comments.jsonl. That path is invisible in the file tree - fsService's skipDir
// drops every dot-directory from the walk - so it needs no ignore-list entry. It is NOT invisible
// to the watcher: fsWatch exempts .texpile from the same rule precisely so a log arriving by
// `git pull` reaches reload() while the folder is open.
//
// This is the first thing Texpile writes into a user's project. Everything else kept per folder -
// main file, compile command - is localStorage keyed by root path, because it is personal. Comments
// are the opposite: they exist to be read by someone else, so they belong in the project and in the
// commit.
import { readTextFile, writeTextFile } from '$lib/workspace/fileSystem';
import { ensureTexpileIgnore, texpilePath } from '$lib/workspace/texpileDir';
import { foldLog, parseLog, type CommentEvent, type CommentThread } from './log';
import { collapseStaged } from './stagedEvents';

function keptLines(text: string): string[] {
	return text
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => {
			if (!line.startsWith('{')) return false;
			try {
				const parsed: unknown = JSON.parse(line);
				return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
			} catch {
				return false;
			}
		});
}

function threadOf(e: CommentEvent): string {
	return e.t === 'open' ? e.id : 'thread' in e ? e.thread : '';
}

export class CommentStore {
	/** every thread in the workspace, in the order they were opened */
	threads = $state<CommentThread[]>([]);
	/** the workspace this log belongs to; null before the first load */
	root = $state<string | null>(null);
	loading = $state(false);

	private events: CommentEvent[] = [];
	/** the log verbatim, so appending never has to re-serialize anything it did not parse */
	private lines: string[] = [];
	private staged: CommentEvent[] = [];

	/** stale-load guard: reloads fire on every save (the fs watcher reports our own writes) and
	 *  an older read landing after a newer one would publish stale threads */
	private loadSeq = 0;

	/** null for a guest, whose root is a sentinel rather than a path - see texpilePath */
	private path(root: string): string | null {
		return texpilePath(root, 'comments.jsonl');
	}

	/** point the store at a workspace and read its log; a missing file is an empty log, not an error.
	 *  The store is NOT cleared while the read is in flight: it used to be, and since every save
	 *  re-runs this through the fs watcher, the panel blanked, the topbar badge blinked out and the
	 *  editor's comment highlights flickered on each save. The old threads stay up until the fresh
	 *  fold replaces them in one step. */
	async load(root: string | null): Promise<void> {
		const my = ++this.loadSeq;
		if (root !== this.root) this.staged = [];
		this.root = root;
		const path = root ? this.path(root) : null;
		if (!path) {
			this.adoptLog('');
			return;
		}
		this.loading = true;
		try {
			const text = await readTextFile(path);
			if (my !== this.loadSeq) return;
			this.adoptLog(text);
		} catch {
			// no log yet is the normal state for a project nobody has commented on
			if (my === this.loadSeq) this.adoptLog('');
		} finally {
			if (my === this.loadSeq) this.loading = false;
		}
	}

	/** re-read from disk, for a pull or another window; CommentsController.refresh drives it */
	reload(): Promise<void> {
		return this.load(this.root);
	}

	/**
	 * Append events, and write the log back if this workspace has one.
	 *
	 * The state always advances; only the write is conditional. That is what lets a guest hold the
	 * session's comments in memory with no disk at all - their root is a sentinel, not a path, and
	 * the file lives on the host.
	 *
	 * Read-modify-write rather than a true append, because the fs bridge only offers whole-file
	 * writes. Two Texpile windows on one folder could therefore lose an event; a real O_APPEND
	 * needs its own IPC and is the fix if that ever matters. Concurrent authors on different
	 * machines are already handled - that is what the log format is for.
	 */
	async append(...events: CommentEvent[]): Promise<void> {
		if (events.length === 0 && this.staged.length === 0) return;
		const written = [...collapseStaged(this.staged), ...events];
		this.staged = [];
		this.events = [...this.events, ...written];
		this.lines = [...this.lines, ...written.map((e) => JSON.stringify(e))];
		this.threads = foldLog(this.events);
		const path = this.root ? this.path(this.root) : null;
		if (!path) return;
		await this.ensureIgnore();
		await writeTextFile(path, this.serialize());
	}

	stage(...events: CommentEvent[]): void {
		if (events.length === 0) return;
		this.staged = [...this.staged, ...events];
		this.threads = foldLog([...this.events, ...this.staged]);
	}

	get hasStaged(): boolean {
		return this.staged.length > 0;
	}

	hasStagedFor(file: string): boolean {
		const ids = this.idsOn(file);
		return this.staged.some((e) => ids.has(threadOf(e)));
	}

	discardStaged(file: string): void {
		const ids = this.idsOn(file);
		const kept = this.staged.filter((e) => !ids.has(threadOf(e)));
		if (kept.length === this.staged.length) return;
		this.staged = kept;
		this.threads = foldLog([...this.events, ...this.staged]);
	}

	private idsOn(file: string): Set<string> {
		const ids = new Set(this.threads.filter((t) => t.file === file).map((t) => t.id));
		for (const e of this.staged) if (e.t === 'open' && e.file === file) ids.add(e.id);
		return ids;
	}

	/** seeded if absent, never over one the user has edited; shared with the config writer */
	private async ensureIgnore(): Promise<void> {
		if (this.root) await ensureTexpileIgnore(this.root);
	}

	/** replace everything from a log served over the wire; a guest's catch-up on join */
	adoptLog(text: string): void {
		this.events = parseLog(text);
		this.lines = keptLines(text);
		this.threads = foldLog([...this.events, ...this.staged]);
	}

	/** the log as it would be written, for the host to serve to a joining guest */
	serialize(): string {
		return this.lines.join('\n') + '\n';
	}

	/** false when this workspace has nowhere to keep a log - a guest session, or no folder open */
	get writable(): boolean {
		return this.root !== null && this.path(this.root) !== null;
	}

	/** threads on one file, workspace-relative path */
	forFile(file: string): CommentThread[] {
		return this.threads.filter((t) => t.file === file);
	}
}

/** workspace-relative, posix separators: the log travels between machines and OSes */
export function relativeTo(root: string, path: string): string {
	const r = root.replace(/[\\/]+$/, '').replace(/\\/g, '/');
	const p = path.replace(/\\/g, '/');
	return p.startsWith(r + '/') ? p.slice(r.length + 1) : p;
}
