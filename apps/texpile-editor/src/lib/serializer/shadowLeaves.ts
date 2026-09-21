// Where the leaves of a regenerated block sit in its text. A shadow run of the block stands a
// private-use character in for the characters of every leaf, keeping the ones the dialect's joins,
// trims and escapes look at, so each leaf can be found in the real output afterwards. The shadow is
// believed only where it equals the real output everywhere else; a block whose shadow differs maps
// no leaves at all
import type { Node } from 'prosemirror-model';
import type { Ctx } from './types';
import { spansOfChars, type CharSource, type Segment } from '$lib/editor/visual/sourceSpans';

const PUA_FIRST = 0xe000;
const PUA_LAST = 0xf8ff;

export type ShadowLeaf = { node: Node; emitted: string; placeholder: string };

export type ShadowDialect = {
	/** the placeholder standing for an emission: the characters the dialect reads stay, the rest is `id` */
	placeholder: (emitted: string, id: string, node: Node) => string;
	/** what one character of a text leaf may become in its emission, most specific first */
	charEmissions: (char: string, node: Node) => string[];
	/** a node whose handler output is one run: its bytes come from attrs, not from text leaves */
	isHandlerLeaf: (node: Node) => boolean;
};

export type Shadow = {
	/** in a shadow run, what stands for this leaf's emission; the emission itself otherwise */
	shadowed: (node: Node, emitted: string) => string;
	/** where the leaves of a regenerated block sit in its text, or null when the shadow could not be believed */
	mapBlockLeaves: (serializeNode: (node: Node, ctx: Ctx) => string, block: Node, ctx: Ctx, real: string) => Segment[] | null;
	/** the real and shadow runs of one block side by side, for the oracles to say why a block maps no leaves */
	shadowRunOf: (serializeNode: (node: Node, ctx: Ctx) => string, block: Node, ctx: Ctx) => { real: string; shadow: string };
};

function isPua(ch: string): boolean {
	const c = ch.charCodeAt(0);
	return c >= PUA_FIRST && c <= PUA_LAST;
}

/**
 * The placeholder for markup dialects (markdown, typst), whose renderers read a run's edges, its
 * whitespace and its punctuation: the first and last characters stay, so does every non-letter,
 * and a space becomes a no-break space, still whitespace to every trim but never a byte of markup
 */
export function markupPlaceholder(emitted: string, id: string): string {
	let out = '';
	for (let i = 0; i < emitted.length; i++) {
		const c = emitted[i];
		if (i === 0 || i === emitted.length - 1) out += c;
		else if (c === ' ') out += ' ';
		else out += /[\p{L}\p{M}]/u.test(c) ? id : c;
	}
	return out;
}

export function createShadow(dialect: ShadowDialect): Shadow {
	let shadow: ShadowLeaf[] | null = null;

	function shadowed(node: Node, emitted: string): string {
		if (!shadow || shadow.length > PUA_LAST - PUA_FIRST) return emitted;
		const placeholder = dialect.placeholder(emitted, String.fromCharCode(PUA_FIRST + shadow.length), node);
		shadow.push({ node, emitted, placeholder });
		return placeholder;
	}

	function run(serializeNode: (node: Node, ctx: Ctx) => string, block: Node, ctx: Ctx): { out: string; leaves: ShadowLeaf[] } {
		const leaves: ShadowLeaf[] = [];
		shadow = leaves;
		try {
			return { out: serializeNode(block, ctx), leaves };
		} finally {
			shadow = null;
		}
	}

	/** the characters of a text leaf against its emission, one by one; the whole run when they cannot be told */
	function textLeafSpans(leaf: ShadowLeaf): CharSource[] {
		const text = leaf.node.text ?? '';
		const whole = () => new Array<CharSource>(text.length).fill({ srcFrom: 0, srcTo: leaf.emitted.length, kind: 'sub' });
		const chars: CharSource[] = [];
		let off = 0;
		for (let i = 0; i < text.length; i++) {
			const e = dialect.charEmissions(text[i], leaf.node).find((c) => leaf.emitted.startsWith(c, off));
			if (e === undefined) return whole();
			chars.push({ srcFrom: off, srcTo: off + e.length, kind: e === text[i] ? 'text' : 'sub' });
			off += e.length;
		}
		return off === leaf.emitted.length ? chars : whole();
	}

	function mapBlockLeaves(serializeNode: (node: Node, ctx: Ctx) => string, block: Node, ctx: Ctx, real: string): Segment[] | null {
		const { out, leaves } = run(serializeNode, block, ctx);
		if (out.length !== real.length) return null;
		for (let i = 0; i < out.length; i++) {
			if (out[i] === real[i] || isPua(out[i]) || (out[i] === ' ' && real[i] === ' ')) continue;
			return null;
		}

		// the leaves' positions, relative to the block node; a block that is itself one run stands at 0
		const at = new Map<Node, number>();
		let twice = false;
		if (dialect.isHandlerLeaf(block) || block.type.spec.leafText) at.set(block, 0);
		block.descendants((n, pos) => {
			const leaf = n.isText || n.isLeaf || dialect.isHandlerLeaf(n) || !!n.type.spec.leafText;
			if (!leaf) return true;
			if (at.has(n)) twice = true;
			at.set(n, pos + 1);
			return false;
		});
		if (twice) return null;

		// a leaf with a marker is found by it, allowing for whitespace a handler trimmed off its edges;
		// one without, by being the only thing in the gap between the found leaves either side of it
		type Found = { start: number; lead: number; tail: number };
		const located: (Found | null)[] = leaves.map((leaf, k) => {
			const id = String.fromCharCode(PUA_FIRST + k);
			const p = leaf.placeholder;
			const j = p.indexOf(id);
			if (j < 0) return null;
			const i0 = out.indexOf(id);
			if (i0 < 0) return null;
			const maxLead = Math.min(j, /^\s*/.exec(p)![0].length);
			const maxTail = /\s*$/.exec(p)![0].length;
			for (let lead = 0; lead <= maxLead; lead++) {
				const start = i0 - (j - lead);
				if (start < 0) continue;
				for (let tail = 0; tail <= maxTail && lead + tail < p.length; tail++) {
					if (out.startsWith(p.slice(lead, p.length - tail), start)) return { start, lead, tail };
				}
			}
			return null;
		});
		for (let k = 0; k < leaves.length; k++) {
			if (located[k] !== null || !leaves[k].emitted) continue;
			let from = 0;
			for (let p = k - 1; p >= 0; p--) {
				const f = located[p];
				if (f) {
					from = f.start + leaves[p].emitted.length - f.lead - f.tail;
					break;
				}
			}
			let to = real.length;
			for (let q = k + 1; q < leaves.length; q++) {
				const f = located[q];
				if (f) {
					to = f.start;
					break;
				}
			}
			if (from > to) continue;
			const gap = real.slice(from, to);
			const first = gap.indexOf(leaves[k].emitted);
			if (first < 0 || gap.indexOf(leaves[k].emitted, first + 1) >= 0) continue;
			located[k] = { start: from + first, lead: 0, tail: 0 };
		}

		const segs: Segment[] = [];
		for (let k = 0; k < leaves.length; k++) {
			const found = located[k];
			const leaf = leaves[k];
			const pm = at.get(leaf.node);
			if (!found || pm === undefined) continue;
			const { start, lead, tail } = found;
			const coreLen = leaf.emitted.length - lead - tail;
			if (leaf.node.isText) {
				// characters a handler trimmed off stand for nothing
				const chars = textLeafSpans(leaf).map((c) => {
					if (!c) return null;
					const srcFrom = Math.max(0, c.srcFrom - lead);
					const srcTo = Math.min(coreLen, c.srcTo - lead);
					return srcTo > srcFrom ? { srcFrom, srcTo, kind: c.kind } : null;
				});
				for (const s of spansOfChars(chars)) {
					segs.push({ pmFrom: pm + s.from, pmTo: pm + s.to, srcFrom: start + s.srcFrom, srcTo: start + s.srcTo, kind: s.kind });
				}
				continue;
			}
			// an atom whose text child appears once inside its emission maps that child character for character
			const core = leaf.emitted.slice(lead, lead + coreLen);
			const inner = leaf.node.childCount === 1 && leaf.node.firstChild!.isText ? (leaf.node.firstChild!.text ?? '') : '';
			const at1 = inner ? core.indexOf(inner) : -1;
			if (inner && at1 >= 0 && core.indexOf(inner, at1 + 1) < 0) {
				segs.push({ pmFrom: pm + 1, pmTo: pm + 1 + inner.length, srcFrom: start + at1, srcTo: start + at1 + inner.length, kind: 'text' });
			} else if (coreLen > 0) {
				segs.push({ pmFrom: pm, pmTo: pm + leaf.node.nodeSize, srcFrom: start, srcTo: start + coreLen, kind: 'sub' });
			}
		}
		return segs.sort((a, b) => a.pmFrom - b.pmFrom);
	}

	function shadowRunOf(serializeNode: (node: Node, ctx: Ctx) => string, block: Node, ctx: Ctx): { real: string; shadow: string } {
		const real = serializeNode(block, ctx);
		return { real, shadow: run(serializeNode, block, ctx).out };
	}

	return { shadowed, mapBlockLeaves, shadowRunOf };
}
