// Remote collaborator presence in the visual editor: a caret bar + name label and a selection
// tint. Positions arrive pre-mapped to PM
// coordinates (WorkspaceView runs the awareness -> sourceMap chain); this plugin only renders.
// Every element is layout-inert: zero-width in-flow anchors with out-of-flow bars, tint via
// background, so a peer's cursor can never move a glyph.
import { Plugin, PluginKey } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { Decoration, DecorationSet } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import './remoteCursors.css';

export type RemotePeerSel = {
	clientId: number;
	name: string;
	color: string;
	/** PM positions, already clamped-mapped by the caller. */
	anchor: number;
	head: number;
};

export const remoteCursorsKey = new PluginKey<DecorationSet>('remote-cursors');

// a peer's color rides untrusted awareness; only these two shapes reach an inline style string,
// so a crafted value (e.g. "red;background:url(https://evil/x)") can't inject extra CSS. The hsl
// form is what a peer on a build before the palette sends, and showing their real color beats
// showing everyone the same gray
const HEX_COLOR = /^#[0-9a-fA-F]{3,8}$/;
const HSL_COLOR = /^hsl\(\d{1,3}deg \d{1,3}% \d{1,3}%\)$/;
function safeColor(c: string): string {
	return HEX_COLOR.test(c) || HSL_COLOR.test(c) ? c : '#888888';
}

// what the browser paints no selection over, so a peer's range would break across it: the same set
// cursor-plugin shades for the local selection, and for the same reason
const SHADED_TYPES = new Set([
	'raw_latex',
	'code_block',
	'block_math',
	'inline_math',
	'inline_latex',
	'includedoc',
	'horizontal_rule',
	'image'
]);
/** a range wholly inside one of these is a peer editing its content, not crossing it */
const EDITABLE_TYPES = new Set(['code_block', 'raw_latex', 'inline_latex', 'image']);

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

function build(doc: PMNode, peers: RemotePeerSel[]): DecorationSet {
	const decos: Decoration[] = [];
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
			decos.push(Decoration.inline(from, to, { class: 'pm-remote-sel', style: `--peer-color: ${color}` }));
			doc.nodesBetween(from, to, (node, pos) => {
				const start = pos;
				const end = pos + node.nodeSize;
				if (start === end || node.isText || !SHADED_TYPES.has(node.type.name)) return;
				if (EDITABLE_TYPES.has(node.type.name) && from >= start && to <= end) return;
				// data-band names an inline one for selectionBands.ts, which stretches its shade to the line box
				const band = node.isInline ? { 'data-band': `peer${p.clientId}-${start}` } : {};
				decos.push(Decoration.node(start, end, { class: 'pm-remote-sel-node', style: `--peer-color: ${color}`, ...band }));
			});
		}
		decos.push(
			Decoration.widget(head, () => caretDom(p.name, color), {
				key: `caret:${p.clientId}:${color}:${p.name}`,
				side: 0,
				ignoreSelection: true
			})
		);
	}
	return DecorationSet.create(doc, decos);
}

/** replace the rendered peer set (empty array clears). */
export function setRemoteCursors(view: EditorView, peers: RemotePeerSel[]): void {
	view.dispatch(view.state.tr.setMeta(remoteCursorsKey, peers).setMeta('addToHistory', false));
}

export const remoteCursorsPlugin = new Plugin<DecorationSet>({
	key: remoteCursorsKey,
	state: {
		init: () => DecorationSet.empty,
		apply(tr, set) {
			const peers = tr.getMeta(remoteCursorsKey) as RemotePeerSel[] | undefined;
			if (peers) return build(tr.doc, peers);
			// between updates, ride along with document changes
			return tr.docChanged ? set.map(tr.mapping, tr.doc) : set;
		}
	},
	props: {
		decorations(state) {
			return remoteCursorsKey.getState(state);
		}
	}
});
