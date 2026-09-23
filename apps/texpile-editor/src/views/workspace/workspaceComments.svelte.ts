// Review-comments wiring: the controller plus every effect that feeds it (mode changes,
// folder loads, the guest event stream, re-anchoring). The log lives in .texpile/comments.jsonl;
// anchors are re-resolved whenever a file opens or its text is replaced from outside, never
// per keystroke - see the controller.
import { untrack } from 'svelte';
import { CommentsController } from '$lib/workspace/commentsController.svelte';
import { workspaceRoot, fileTree } from '$lib/workspace/workspaceStore';
import { fileMode } from '$lib/workspace/fileMode.svelte';
import { userData } from '$lib/storage/userData';
import { collabGuest } from '$lib/collab/guestStore.svelte';
import { collabHost } from '$lib/collab/hostStore.svelte';
import { isSafeRel } from '$lib/collab/protocol';
import { editorViewStore, sourceCmView } from '$lib/stores/editorStore';
import { pmCommentsKey, revealPmComment, sourceAnchorFor } from '$lib/editor/visual/extensions/pmComments';
import { liveCommentRanges } from '$lib/editor/visual/extensions/comments';
import { buildAnchor, type CommentAnchor } from '$lib/comments/anchor';
import { flatFiles } from '$lib/workspace/treeRefresh';
import { relativeTo } from '$lib/comments/store.svelte';
import { hasVisualMode, type DocumentBuffer, type FileKind } from '$lib/workspace/documentBuffer.svelte';
import type { ViewModeSwitch } from '$lib/workspace/viewModeSwitch.svelte';
import type { ParsedLatexFile } from '$lib/workspace/latexRoundtrip';
import type { SourceEdit } from '$lib/workspace/suggestionsController';
import { patchVisualFromSource } from '$lib/workspace/visualSourcePatch';
import { onDecisionStep } from '$lib/comments/decisionHistory';
import { markPmDecision } from '$lib/editor/visual/extensions/pmDecisionStep';
import { markCmDecision } from '$lib/editor/source/extensions/cmDecisionStep';
import { editMode, suggesting } from '$lib/comments/activeSuggestions.svelte';
import type { EditMode } from '$lib/comments/suggestCompare';

type CommentsDeps = {
	doc: DocumentBuffer;
	modes: ViewModeSwitch;
	kind: () => FileKind;
	guest: () => boolean;
	jumpToFileLine: (abs: string, line: number) => void;
	parseVisual: (text: string) => Promise<ParsedLatexFile | null>;
	flushSave: () => void;
};

export class WorkspaceComments {
	readonly ctl: CommentsController;

	constructor(private d: CommentsDeps) {
		function mode(): EditMode {
			return suggesting.current && !d.guest() && !collabHost.active && !fileMode.current ? 'suggesting' : 'editing';
		}
		this.ctl = new CommentsController({
			root: () => workspaceRoot.current,
			// a guest has no git repo to fall back to (its root is the 'session' sentinel), but it DOES
			// have the name it joined with - that is what every peer already sees on its cursor
			preferredAuthor: () => userData.current.commentAuthor || userData.current.collabName || (d.guest() ? collabGuest.selfName : ''),
			// new anchors and event resolution read the LIVE buffer; the reanchor snapshot goes stale
			// under remote edits in a shared session (see the controller's activeText comment)
			activeText: () => this.activeText(),
			// the mode-preserving jump, not openFileAtLine: revealing a comment from the panel must not
			// yank a visual-mode reader into source - the same courtesy SyncTeX inverse clicks get
			openFileAt: (abs, line) => d.jumpToFileLine(abs, line),
			// Preferred over the line jump while the reader is in visual mode: pmComments has the thread's
			// exact range in the rendered document, so this lands ON the highlight instead of at the top of
			// the block containing it. False whenever that is not available - source/diff mode, a file with
			// no visual editor, a view still mounting, or a thread this view could not place - and
			// openFileAt above takes over unchanged.
			revealInVisual: (id) => {
				if (d.modes.mode !== 'visual' || !hasVisualMode(d.kind())) return false;
				const v = editorViewStore.current;
				return !!v && revealPmComment(v, id);
			},
			liveAnchors: (text) => this.liveAnchors(text),
			// a guest's events go up to the host, which owns the log; a host's go out to every guest.
			// Solo, both are no-ops and the log is just a file.
			publish: (event) => {
				if (d.guest()) collabGuest.sendComment(event);
				else if (collabHost.active) collabHost.broadcastComment(event);
			},
			mode,
			compares: () => !d.guest(),
			rewraps: () => d.modes.mode === 'visual' && hasVisualMode(d.kind()),
			applyEdit: (edit) => this.applyEdit(edit),
			markDecision: (seq) => this.markDecision(seq),
			saveNow: () => d.flushSave(),
			resync: () => collabHost.resendCommentLog()
		});

		$effect(() => onDecisionStep((s) => void this.ctl.suggestions.revisitAccept(s.seq, s.undone)));

		let lastMode = mode();
		$effect(() => {
			const next = mode();
			editMode.current = next;
			if (next === lastMode) return;
			const was = lastMode;
			lastMode = next;
			untrack(() => void this.ctl.suggestions.settle(was));
		});

		$effect(() => {
			const text = this.activeText();
			const path = d.doc.path;
			untrack(() => this.ctl.suggestions.textChanged(path, text));
		});

		// "not in this view" is a statement about the VISUAL view; source draws everything it resolves,
		// so the badge has to disappear in source mode - for the remembered files too, or the panel tells
		// a reader already in source to switch to source
		$effect(() => {
			this.ctl.setVisualMode(d.modes.mode === 'visual');
		});
		$effect(() => {
			// null for a guest: their workspaceRoot is the sentinel 'session', not a path, and the log
			// lives on the host's disk. Comments in a shared session need the session protocol to carry
			// their events; until it does, a guest has no log rather than a broken one.
			//
			// Null in single-file mode too: the root there is only the file's own folder, so the log it
			// points at is some other project's - and writing to it would drop a .texpile beside a file
			// we are visiting, holding threads that project will never see.
			void this.ctl.load(d.guest() || fileMode.current ? null : workspaceRoot.current);
		});
		// A guest has no disk, so its log arrives over the wire: single events as they happen, and the
		// whole thing once on join. load(null) above leaves it empty until then rather than reading a
		// path built from the 'session' sentinel.
		$effect(() => {
			if (!d.guest()) return;
			collabGuest.onCommentEvent = (event) => void this.ctl.ingest(event);
			collabGuest.onCommentLog = (log) =>
				this.ctl.adopt(
					log,
					d.doc.path,
					untrack(() => this.activeText())
				);
			// this guest clicked the streamed preview; the host's tinymist resolved the span and sent
			// the answer back here - the same landing an own-preview click gets on the host
			collabGuest.onTypstJump = (p) => {
				if (!isSafeRel(p.file) || !Number.isFinite(p.line) || p.line < 0) return;
				d.jumpToFileLine(p.file, Math.floor(p.line) + 1);
			};
			return () => {
				collabGuest.onCommentEvent = null;
				collabGuest.onCommentLog = null;
				collabGuest.onTypstJump = null;
			};
		});
		$effect(() => {
			// re-asked on every reconnect: events sent while we were away are only in the host's log
			if (d.guest() && collabGuest.status === 'online') collabGuest.requestComments();
		});
		$effect(() => {
			// keyed on doc.path AND the view mode - NOT on the text, because while the editor is live
			// CodeMirror maps the decorations through each transaction - exactly - and re-searching on
			// top of that could snap a range onto another copy of the quote mid-edit. The mode matters
			// because leaving source unmounts the editor and CM's exactly-mapped ranges go with it, so
			// re-entering must re-search the current text rather than replay the pre-mount list (which
			// after edits can even point past the end of the file).
			void d.modes.mode;
			// and on every document the visual editor swaps in: the plugin's mapped ranges go with the
			// old one, and the ranges the new one is placed from must be of the text as it is now
			void d.doc.visualDoc;
			this.ctl.reanchor(
				d.doc.path,
				untrack(() => this.activeText())
			);
		});
	}

	/** the live buffer the anchors resolve against */
	activeText(): string {
		return hasVisualMode(this.d.kind()) ? this.d.doc.texSource : this.d.doc.rawContent;
	}

	private async applyEdit(edit: SourceEdit): Promise<boolean> {
		const before = this.activeText();
		if (edit.from < 0 || edit.to > before.length || edit.to < edit.from) return false;
		const next = before.slice(0, edit.from) + edit.insert + before.slice(edit.to);
		if (this.d.modes.mode === 'visual' && hasVisualMode(this.d.kind())) {
			const v = editorViewStore.current;
			return !!v && patchVisualFromSource(v, this.d.doc, this.d.parseVisual, before, next);
		}
		const cm = sourceCmView.current;
		if (!cm || cm.state.doc.toString() !== before) return false;
		cm.dispatch({ changes: { from: edit.from, to: edit.to, insert: edit.insert } });
		return true;
	}

	private markDecision(seq: number): void {
		if (this.d.modes.mode === 'visual' && hasVisualMode(this.d.kind())) {
			const v = editorViewStore.current;
			if (v) markPmDecision(v, seq);
			return;
		}
		const cm = sourceCmView.current;
		if (cm) markCmDecision(cm, seq);
	}

	async beforeSave(absPath: string, content: string): Promise<void> {
		const root = workspaceRoot.current;
		if (!root || this.d.guest() || fileMode.current) return;
		const file = relativeTo(root, absPath);
		if (file === absPath.replace(/\\/g, '/')) return;
		await this.ctl.suggestions.beforeSave(file, content);
	}

	discarded(absPath: string): void {
		const root = workspaceRoot.current;
		if (root) this.ctl.suggestions.discardUnsaved(relativeTo(root, absPath));
	}

	async adoptDisk(): Promise<void> {
		const file = this.ctl.activeFile;
		if (file) await this.ctl.suggestions.adoptDisk(file, this.activeText());
		this.reanchorNow();
	}

	/** re-search the open file's threads against its text as it is now; see the reanchor effect */
	reanchorNow(): void {
		this.ctl.reanchor(this.d.doc.path, this.activeText());
	}

	liveAnchors(text: string): Map<string, CommentAnchor> | null {
		const out = new Map<string, CommentAnchor>();
		if (this.d.modes.mode === 'visual' && hasVisualMode(this.d.kind())) {
			const v = editorViewStore.current;
			// the map describes texSource; another text has no map to read
			if (!v || text !== this.d.doc.texSource) return null;
			for (const r of pmCommentsKey.getState(v.state)?.ranges ?? []) {
				if (r.resolved) continue;
				const anchor = sourceAnchorFor(v.state.doc, this.d.doc.sourceMap, text, r.from, r.to);
				if (anchor) out.set(r.id, anchor);
			}
			return out;
		}
		const cm = sourceCmView.current;
		if (!cm || cm.state.doc.toString() !== text) return null;
		for (const r of liveCommentRanges(cm.state)) {
			if (!r.resolved) out.set(r.id, buildAnchor(text, r.from, r.to));
		}
		return out;
	}

	/**
	 * Which files the panel's threads can actually open: threads survive their file's deletion ON
	 * PURPOSE (the log is append-only, and undoing the delete brings them straight back), so the
	 * panel needs to know a thread's file is gone to say so instead of presenting a dead link.
	 * null while no folder is open - "unknown", drawing no badges, rather than "everything missing".
	 */
	get filesPresent(): Set<string> | null {
		const root = workspaceRoot.current;
		if (!root) return null;
		return new Set(flatFiles(fileTree.current).map((p) => relativeTo(root, p)));
	}
}
