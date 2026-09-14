// The reactive half of pmComments, shared by every visual editor (latex, markdown, typst): keep
// the plugin's ranges in step with the thread list and the document, and the focused thread in
// step with the panel selection. One implementation, because the guards are the subtle part and
// three hand-copied versions of them would drift.
//
// Runs $effects, so it must be called during component init.
import type { EditorView } from 'prosemirror-view';
import type { CommentThread } from '$lib/comments/log';
import type { AnchorDialect } from '$lib/comments/anchor';
import { setPmComments, focusPmComment, resolvePmComments, setPmCommentPending } from './pmComments';
import { setPmSuggestions } from './pmSuggestions';
import { placePmSuggestions } from './pmSuggestionsPlace';
import { isSuggestion } from '$lib/comments/suggest';
import { activeSuggestions, suggestionVisibility, type SuggestionMark } from '$lib/comments/activeSuggestions.svelte';

const PLACE_MS = 150;

export type PmCommentsSyncArgs = {
	/** the mounted view, or null until it exists */
	view: () => EditorView | null;
	threads: () => CommentThread[];
	/** the source dialect anchors are matched against; static per editor */
	dialect: AnchorDialect;
	/**
	 * Bumped by the caller when a re-parsed doc is SWAPPED onto the view (updateState rebuilds
	 * plugin state, dropping the old ranges). Typing must not bump it: ranges map through
	 * transactions, and re-searching mid-edit could snap a range onto another copy of its text.
	 */
	epoch: () => number;
	selected: () => string | null;
	/** the threads that could not be drawn in this view, for the panel's "not in this view" */
	onPlaced?: (lost: string[]) => void;
	/**
	 * A comment composer is open. The editor SETS its pending tint at the gesture (the pill or
	 * context menu know the exact selection); this only clears it when the composer closes -
	 * committed, cancelled, or abandoned by a file switch.
	 */
	pendingActive?: () => boolean;
};

export function syncPmComments(args: PmCommentsSyncArgs): void {
	// Re-place threads when the list changes or a swap lands. The fingerprint guard matters
	// because the threads array usually arrives through an object literal rebuilt on every parent
	// render - identity alone would re-resolve (a full flatten + search per thread) on every
	// unrelated state change. An anchor changes only by re-pinning (an `anchor` event), so id +
	// resolved + the anchor's own offsets are the whole of what the decorations depend on.
	let lastFp = '';
	let lastEpoch = -1;
	$effect(() => {
		const v = args.view();
		const threads = args.threads().filter((t) => !isSuggestion(t));
		const epoch = args.epoch();
		if (!v) return;
		const fp = threads.map((t) => `${t.id}:${t.resolved ? 1 : 0}:${t.anchor.start}-${t.anchor.end}`).join('|');
		if (fp === lastFp && epoch === lastEpoch) return;
		lastFp = fp;
		lastEpoch = epoch;
		const placed = resolvePmComments(v.state.doc, threads, args.dialect);
		setPmComments(v, placed.ranges);
		args.onPlaced?.(placed.lost);
	});

	let lastMarks: SuggestionMark[] | null = null;
	let lastMarksEpoch = -1;
	let placedAt = 0;
	let later: ReturnType<typeof setTimeout> | null = null;
	function placeSuggestions(v: EditorView, marks: SuggestionMark[]) {
		if (later) clearTimeout(later);
		later = null;
		lastMarks = marks;
		placedAt = performance.now();
		const placed = placePmSuggestions(v.state.doc, marks, args.dialect);
		setPmSuggestions(v, placed.ranges);
		suggestionVisibility.current = { partial: placed.partial, hidden: placed.hidden };
	}
	$effect(() => {
		const v = args.view();
		const marks = activeSuggestions.current;
		const epoch = args.epoch();
		if (!v || (marks === lastMarks && epoch === lastMarksEpoch)) return;
		const swapped = epoch !== lastMarksEpoch;
		lastMarksEpoch = epoch;
		const wait = placedAt + PLACE_MS - performance.now();
		if (swapped || wait <= 0) return placeSuggestions(v, marks);
		const doc = v.state.doc;
		if (later) clearTimeout(later);
		later = setTimeout(() => (v.state.doc === doc ? placeSuggestions(v, marks) : (later = null)), wait);
	});
	$effect(() => () => {
		if (later) clearTimeout(later);
		suggestionVisibility.current = { partial: new Set(), hidden: new Set() };
	});

	$effect(() => {
		const v = args.view();
		const active = args.pendingActive?.() ?? false;
		if (!v || active) return;
		setPmCommentPending(v, null);
	});

	// Declared AFTER the placement effect on purpose: effects run in declaration order, so the ranges
	// are already in plugin state when this reveals one.
	let lastFocused: string | null | undefined;
	$effect(() => {
		const v = args.view();
		const id = args.selected();
		if (!v || id === lastFocused) return;
		lastFocused = id;
		focusPmComment(v, id);
	});
}
