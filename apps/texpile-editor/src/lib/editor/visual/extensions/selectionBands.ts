// the shade on a crossed inline element, stretched to its line box the way the browser paints selected text
import type { EditorView } from 'prosemirror-view';
import { contentBox, cssZoomOf, lineBoxesOf, middle, type LineBox } from '$lib/editor/visual/lineBoxes';

// off screen nobody sees the difference, and a select-all over a long paper would measure every formula in it
const NEAR_SCREEN = 600;

/** the editor's top-level blocks on or near the screen, found without reading every block's box */
function blocksNearScreen(root: HTMLElement): Element[] {
	const blocks = root.children;
	let from = 0;
	let end = blocks.length;
	while (from < end) {
		const mid = (from + end) >> 1;
		if (blocks[mid].getBoundingClientRect().bottom < -NEAR_SCREEN) from = mid + 1;
		else end = mid;
	}
	const near: Element[] = [];
	for (let i = from; i < blocks.length; i++) {
		const box = blocks[i].getBoundingClientRect();
		if (box.top > window.innerHeight + NEAR_SCREEN) break;
		if (box.bottom >= -NEAR_SCREEN) near.push(blocks[i]);
	}
	return near;
}

function blockOf(el: Element): HTMLElement | null {
	for (let up = el.parentElement; up; up = up.parentElement) {
		const display = getComputedStyle(up).display;
		if (!display.startsWith('inline') && display !== 'contents') return up;
	}
	return null;
}

// the hyphen of a selected word is painted by hand (hyphenSelection) and needs the same band
const BANDED = '.pm-selected-node[data-band], .pm-line-hyphen-selected[data-band]';

/** one rule per crossed inline element on screen: how far its line reaches above and below it */
export function selectionBandRules(view: EditorView): string {
	const linesOf = new Map<HTMLElement, LineBox[]>();
	let rules = '';
	const crossed = blocksNearScreen(view.dom).flatMap((block) => [...block.querySelectorAll<HTMLElement>(BANDED)]);
	for (const el of crossed) {
		const outer = el.getClientRects()[0];
		if (!outer) continue;
		const style = getComputedStyle(el);
		if (!style.display.startsWith('inline')) continue;
		const zoom = cssZoomOf(el);
		// without the padding an earlier pass gave it
		const rect = contentBox(outer, style, zoom);
		const block = blockOf(el);
		if (!block) continue;
		let lines = linesOf.get(block);
		if (!lines) linesOf.set(block, (lines = lineBoxesOf(block)));
		const at = middle(rect);
		const line = lines.find((l) => at > l.top && at < l.bottom);
		if (!line) continue;
		const up = Math.max(0, rect.top - line.top) / zoom;
		const down = Math.max(0, line.bottom - rect.bottom) / zoom;
		rules += `[data-band="${el.dataset.band}"]{--band-up:${up.toFixed(4)}px;--band-down:${down.toFixed(4)}px}`;
	}
	return rules;
}

export type SelectionBandPainter = { repaint(): void; destroy(): void };

/** keeps the rules in step with the selection, the scroll position and the editor's width */
export function selectionBandPainter(view: EditorView): SelectionBandPainter {
	const style = document.head.appendChild(document.createElement('style'));
	let frame = 0;
	function paint(): void {
		frame = 0;
		const rules = view.isDestroyed ? '' : selectionBandRules(view);
		if (rules !== style.textContent) style.textContent = rules;
	}
	function repaint(): void {
		if (!frame && (style.textContent || !view.state.selection.empty)) frame = requestAnimationFrame(paint);
	}
	window.addEventListener('scroll', repaint, { capture: true, passive: true });
	const resized = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(repaint);
	resized?.observe(view.dom);
	return {
		repaint,
		destroy() {
			if (frame) cancelAnimationFrame(frame);
			window.removeEventListener('scroll', repaint, { capture: true });
			resized?.disconnect();
			style.remove();
		}
	};
}
