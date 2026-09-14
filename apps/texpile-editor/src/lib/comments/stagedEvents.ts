// a burst of suggestion events reduced to the lines worth writing
import type { CommentEvent } from './log';

export function collapseStaged(staged: CommentEvent[]): CommentEvent[] {
	const withdrawn = new Set(staged.flatMap((e) => (e.t === 'delete' ? [e.thread] : [])));
	const bornAndGone = new Set(staged.flatMap((e) => (e.t === 'open' && withdrawn.has(e.id) ? [e.id] : [])));
	const out: (CommentEvent | null)[] = [];
	const opened = new Map<string, number>();
	const lastAnchor = new Map<string, number>();

	for (const e of staged) {
		const id = e.t === 'open' ? e.id : 'thread' in e ? e.thread : null;
		if (id && bornAndGone.has(id)) continue;
		if (e.t === 'open') {
			opened.set(e.id, out.length);
			out.push(e);
			continue;
		}
		if (e.t !== 'anchor') {
			out.push(e);
			continue;
		}
		if (withdrawn.has(e.thread)) continue;
		const at = opened.get(e.thread);
		const open = at === undefined ? null : out[at];
		if (at !== undefined && open?.t === 'open') {
			out[at] = { ...open, anchor: e.anchor, restore: e.restore ?? open.restore, ...(e.file ? { file: e.file } : {}) };
			continue;
		}
		const prev = lastAnchor.get(e.thread);
		const earlier = prev === undefined ? null : out[prev];
		if (prev !== undefined && earlier?.t === 'anchor') out[prev] = null;
		out.push(earlier?.t === 'anchor' ? { ...e, restore: e.restore ?? earlier.restore, file: e.file ?? earlier.file } : e);
		lastAnchor.set(e.thread, out.length - 1);
	}
	return out.filter((e): e is CommentEvent => e !== null);
}
