// Remote collaborator presence in the visual editor: a caret bar + name label and a selection
// tint. Positions arrive pre-mapped to PM
// coordinates (WorkspaceView runs the awareness -> sourceMap chain); this plugin only renders.
// Every element is layout-inert: zero-width in-flow anchors with out-of-flow bars, tint via
// background, so a peer's cursor can never move a glyph.
import { Plugin, PluginKey } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { Decoration, DecorationSet } from 'prosemirror-view';
import { paintRange } from '$lib/editor/visual/highlight/paintRange';
import type { Node as PMNode } from 'prosemirror-model';
import { oldWordsBetween } from './pmSuggestionsState';
import './remoteCursors.css';

export type RemotePeerSel = {
	clientId: number;
	name: string;
	color: string;
	/** PM positions, already clamped-mapped by the caller. */
	anchor: number;
	head: number;
};

type PeerRange = { from: number; to: number; tint: string };
type RemoteCursorsState = { decos: DecorationSet; ranges: PeerRange[] };

export const remoteCursorsKey = new PluginKey<RemoteCursorsState>('remote-cursors');

// a peer's color rides untrusted awareness; only these two shapes reach an inline style string,
// so a crafted value (e.g. "red;background:url(https://evil/x)") can't inject extra CSS. The hsl
// form is what a peer on a build before the palette sends, and showing their real color beats
// showing everyone the same gray
const HEX_COLOR = /^#[0-9a-fA-F]{3,8}$/;
const HSL_COLOR = /^hsl\(\d{1,3}deg \d{1,3}% \d{1,3}%\)$/;
function safeColor(c: string): string {
	return HEX_COLOR.test(c) || HSL_COLOR.test(c) ? c : '#888888';
}

function caretDom(name: string, color: string): HTMLElement {
	const span = document.createElement('span');
	span.className = 'pm-remote-caret';
	span.style.setProperty('--peer-color', color);
	span.appendChild(document.createTextNode('⁠')); // zero-width content gives the bar line height
	const label = document.createElement('span');
	label.className = 'pm-remote-caret-label';
	label.textContent = name;
	span.appendChild(label);
	return span;
}

function build(doc: PMNode, peers: RemotePeerSel[]): RemoteCursorsState {
	const decos: Decoration[] = [];
	const ranges: PeerRange[] = [];
	const max = doc.content.size;
	function clamp(n: number) {
		return Math.min(Math.max(0, n), max);
	}
	for (const p of peers) {
		const color = safeColor(p.color);
		const anchor = clamp(p.anchor);
		const head = clamp(p.head);
		if (anchor !== head) {
			const from = Math.min(anchor, head);
			const to = Math.max(anchor, head);
			const tint = `color-mix(in srgb, ${color} 20%, transparent)`;
			ranges.push({ from, to, tint });
			// nothing of a peer's selection is painted by the browser, so all of it is drawn, in the
			// shape a selection of our own would have
			decos.push(
				...paintRange(doc, {
					from,
					to,
					tint,
					key: `peer${p.clientId}`,
					reach: 'line',
					class: 'pm-remote-sel'
				})
			);
		}
		decos.push(
			Decoration.widget(head, () => caretDom(p.name, color), {
				key: `caret:${p.clientId}:${color}:${p.name}`,
				side: 0,
				ignoreSelection: true
			})
		);
	}
	return { decos: DecorationSet.create(doc, decos), ranges };
}

// a suggestion's old words are a widget, which no decoration reaches: the class goes on the element
function shadeOldWords(view: EditorView, shadedBefore: boolean): boolean {
	const tints = new Map<string, string>();
	for (const r of remoteCursorsKey.getState(view.state)?.ranges ?? []) {
		for (const id of oldWordsBetween(view.state, r.from, r.to)) if (!tints.has(id)) tints.set(id, r.tint);
	}
	if (tints.size === 0 && !shadedBefore) return false;
	for (const el of view.dom.querySelectorAll<HTMLElement>('.pm-suggest-old')) {
		const tint = tints.get(el.dataset.comment ?? '');
		el.classList.toggle('pm-peer-selected', tint !== undefined);
		// the line box the rest of the selection reaches (rangeHighlight.css); padding on a block would move it
		el.classList.toggle('pm-range-text', tint !== undefined && el.tagName === 'SPAN' && !el.classList.contains('pm-suggest-was'));
		if (tint) el.style.setProperty('--peer-tint', tint);
		else el.style.removeProperty('--peer-tint');
	}
	return tints.size > 0;
}

/** replace the rendered peer set (empty array clears). */
export function setRemoteCursors(view: EditorView, peers: RemotePeerSel[]): void {
	view.dispatch(view.state.tr.setMeta(remoteCursorsKey, peers).setMeta('addToHistory', false));
}

export const remoteCursorsPlugin = new Plugin<RemoteCursorsState>({
	key: remoteCursorsKey,
	state: {
		init: () => ({ decos: DecorationSet.empty, ranges: [] }),
		apply(tr, prev) {
			const peers = tr.getMeta(remoteCursorsKey) as RemotePeerSel[] | undefined;
			if (peers) return build(tr.doc, peers);
			// between updates, ride along with document changes
			if (!tr.docChanged) return prev;
			return {
				decos: prev.decos.map(tr.mapping, tr.doc),
				ranges: prev.ranges.map((r) => ({ ...r, from: tr.mapping.map(r.from), to: tr.mapping.map(r.to) }))
			};
		}
	},
	props: {
		decorations(state) {
			return remoteCursorsKey.getState(state)?.decos;
		}
	},
	view() {
		let shaded = false;
		return {
			update(view) {
				shaded = shadeOldWords(view, shaded);
			}
		};
	}
});
