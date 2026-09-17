// paragraphs of the visual editor broken into lines as a whole (Knuth and Plass), with the browser held to those breaks
import { Plugin, PluginKey, type EditorState } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import { observe } from '$lib/runes/observe.svelte';
import { settings } from '$lib/settings';
import { templateFeaturesStore } from '$lib/stores/editorStore';
import { isLargeDocument } from '$lib/languages/latex/visual/largeDocument';
import { hasOldWords, pmSuggestionsKey } from '../extensions/pmSuggestionsState';
import { cssZoomOf } from '../lineBoxes';
import type { DocumentHyphenation } from './documentHyphenationLanguage';
import { loadHyphenator } from './hyphenationLanguages';
import { inlineBoxWatch } from './inlineBoxWatch';
import { linesKeptWhileTyping } from './linesKeptWhileTyping';
import { paragraphBreaks, sameBreaks, type BreakingContext, type ChosenBreaks, type ParagraphBreaks } from './paragraphBreaks';
import { runStyleReader } from './textRunStyles';
import { wordBeingTypedKey, wordBeingTypedPlugin } from './wordBeingTyped';
import { forgetTextWidths } from './wordWidths';

// held to its breaks, left to the browser but justified like the rest, or left entirely alone
type DrawnAs = 'held' | 'plain' | 'alone';

type LineBreakState = {
	decorations: DecorationSet;
	/** how each paragraph is drawn now. In the state because a swapped in state starts empty yet can bring the same nodes back */
	shown: WeakMap<PMNode, DrawnAs>;
	/** every paragraph wraps on its own for now, marks and all (app.css) */
	native: boolean;
	/** a document too large to break carries no decorations, and one rule justifies it when the text is justified */
	plain: boolean;
};

export const lineBreakKey = new PluginKey<LineBreakState>('texpile-line-breaks');

// a line that failed to break where it was told to runs past the edge by far more than rounding does
const SPILL_ALLOWANCE = 2;
// how long the width has to hold still before the document is broken again
const WIDTH_REST_MS = 150;
// a paragraph whose inline views keep changing size is left to the browser once it has been broken this often in a second
const MOST_REBREAKS_A_SECOND = 6;

// ProseMirror reuses any drawn piece up to five ahead that reads the same under an equal decoration and drops what lies
// between, so a line end space before a formula took the one after it and the formula was rebuilt. No two specs are equal
let marksMade = 0;

// the paragraph cannot wrap on its own; only the marked spaces, dashes and hyphenation points let it (app.css)
function decorationsFor(pos: number, paragraph: PMNode, breaks: ChosenBreaks): Decoration[] {
	const held = Decoration.node(
		pos,
		pos + paragraph.nodeSize,
		{ class: breaks.justified ? 'pm-line-par pm-line-justified' : 'pm-line-par' },
		{ holdsParagraph: true }
	);
	const ends = breaks.marks.map((mark) =>
		Decoration.inline(pos + mark.from, pos + mark.to, { class: mark.hyphen ? 'pm-line-hyphen' : 'pm-line-break' }, { made: ++marksMade })
	);
	return [held, ...ends];
}

// a paragraph the browser wraps sits among held ones, and ragged beside justified text it reads as a mistake
function plainlyJustified(pos: number, paragraph: PMNode): Decoration {
	return Decoration.node(pos, pos + paragraph.nodeSize, { class: 'pm-line-justified' }, { holdsParagraph: true });
}

// struck out words are drawn by a widget, whose width and inner breaks the items know nothing of
function paragraphsWithOldWords(state: EditorState): Set<PMNode> {
	const found = new Set<PMNode>();
	for (const range of pmSuggestionsKey.getState(state)?.ranges ?? []) {
		if (hasOldWords(range) && range.from <= state.doc.content.size) found.add(state.doc.resolve(range.from).parent);
	}
	return found;
}

function px(length: string): number {
	return parseFloat(length) || 0;
}

function contentWidth(block: HTMLElement): number {
	const style = getComputedStyle(block);
	const box = block.getBoundingClientRect().width / cssZoomOf(block);
	return box - px(style.paddingLeft) - px(style.paddingRight) - px(style.borderLeftWidth) - px(style.borderRightWidth);
}

function lineBreaker(view: EditorView): { update(view: EditorView, before: EditorState): void; destroy(): void } {
	let broken = new WeakMap<PMNode, ParagraphBreaks>();
	let outdated = new WeakSet<PMNode>();
	let retried = new WeakSet<PMNode>();
	let rebreaks = new WeakMap<PMNode, { since: number; count: number }>();
	let widths = new WeakMap<HTMLElement, number>();
	const unchecked = new Set<HTMLElement>();
	let rootWidth = -1;
	let checkFrame = 0;
	let rebreakFrame = 0;
	let afterComposition = 0;
	let widthRest = 0;
	// a splitter drag or a window resize changes the width every frame, and each change would re-break the whole
	// document; the browser wraps on its own until the width rests
	let widthMoving = false;
	let wanted = '';
	let language: DocumentHyphenation | undefined;
	const typing = linesKeptWhileTyping((paragraph) => broken.get(paragraph));

	function paragraphOf(element: Element): PMNode | null {
		const block = element.closest('p');
		if (!block || !view.dom.contains(block)) return null;
		const paragraph = view.state.doc.nodeAt(view.posAtDOM(block, 0) - 1);
		return paragraph?.type.name === 'paragraph' ? paragraph : null;
	}

	function publish(next: LineBreakState): void {
		view.dispatch(view.state.tr.setMeta(lineBreakKey, next).setMeta('addToHistory', false));
	}

	function rebreakNextFrame(fromScratch: boolean): void {
		// never from inside a resize observer: new breaks change heights, which one may not cause from its own callback
		if (rebreakFrame) return;
		rebreakFrame = requestAnimationFrame(() => {
			rebreakFrame = 0;
			if (fromScratch) startOver();
			else rebreak();
		});
	}

	/** false once the paragraph has been broken too often lately: two views trading sizes must not spin */
	function inlineViewChanged(paragraph: PMNode): boolean {
		const now = performance.now();
		const recent = rebreaks.get(paragraph);
		if (!recent || now - recent.since > 1000) rebreaks.set(paragraph, { since: now, count: 1 });
		else if (++recent.count > MOST_REBREAKS_A_SECOND) {
			broken.set(paragraph, 'native');
			return false;
		}
		outdated.add(paragraph);
		retried.delete(paragraph);
		return true;
	}

	const inlineBoxes = inlineBoxWatch((element) => {
		const paragraph = paragraphOf(element);
		if (paragraph && inlineViewChanged(paragraph)) rebreakNextFrame(false);
	});

	const context: BreakingContext = {
		justified: true,
		hyphenator: null,
		styleOf: runStyleReader(),
		inlineWidthOf: inlineBoxes.widthOf,
		wholeWord: null,
		widthOf(block) {
			let width = widths.get(block);
			if (width === undefined) widths.set(block, (width = contentWidth(block)));
			return width;
		}
	};

	function drawnAs(breaks: ParagraphBreaks, struck: boolean): DrawnAs {
		if (typeof breaks === 'object' && !struck) return 'held';
		return breaks !== 'untouched' && context.justified ? 'plain' : 'alone';
	}

	function check(): void {
		checkFrame = 0;
		if (view.isDestroyed) return;
		let spilled = false;
		for (const block of unchecked) {
			if (block.scrollWidth <= block.clientWidth + SPILL_ALLOWANCE) continue;
			const paragraph = paragraphOf(block);
			if (!paragraph) continue;
			// once more with what is on the page now, then the browser takes it
			if (retried.has(paragraph)) broken.set(paragraph, 'native');
			else outdated.add(paragraph);
			retried.add(paragraph);
			spilled = true;
		}
		unchecked.clear();
		if (spilled) rebreak();
	}

	function rebreak(fromScratch = false): void {
		// a redraw in the middle of a composition can end it; its end comes back here
		if (view.isDestroyed || view.composing || widthMoving) return;
		const { doc } = view.state;
		const held = lineBreakKey.getState(view.state)!;
		context.wholeWord = wordBeingTypedKey.getState(view.state) ?? null;
		const current = fromScratch ? DecorationSet.empty : held.decorations;
		const shown = fromScratch ? new WeakMap<PMNode, DrawnAs>() : held.shown;
		const struck = paragraphsWithOldWords(view.state);
		const stale: Decoration[] = [];
		const fresh: Decoration[] = [];
		const large = isLargeDocument(doc);
		if (!large)
			doc.descendants((node, pos) => {
				// a table sizes its columns from how its cells wrap, so its paragraphs cannot be held to one width
				if (node.type.name.includes('table')) return false;
				if (!node.isTextblock) return true;
				if (node.type.name !== 'paragraph' || node.childCount === 0) return false;
				const known = broken.get(node);
				const hidden = struck.has(node);
				if (known && !outdated.has(node) && shown.get(node) === drawnAs(known, hidden)) return false;
				const block = view.nodeDOM(pos);
				if (!(block instanceof HTMLElement)) return false;
				let breaks = known;
				if (!breaks || outdated.has(node)) {
					breaks = paragraphBreaks(view, node, pos, block, context, typing.take(node));
					broken.set(node, breaks);
					outdated.delete(node);
					if (typeof breaks === 'object') unchecked.add(block);
					if (known && sameBreaks(known, breaks) && shown.get(node) === drawnAs(breaks, hidden)) return false;
				}
				const end = pos + node.nodeSize;
				const mine = current.find(pos, end).filter((old) => old.from >= pos && old.to <= end);
				const drawn = drawnAs(breaks, hidden);
				if (drawn === 'held' && typeof breaks === 'object') {
					stale.push(...mine);
					fresh.push(...decorationsFor(pos, node, breaks));
				} else {
					// only the hold comes off. Taking every mark out at once leaves ProseMirror more stale pieces of text
					// than it looks past, and it then rebuilds the formulas and citations behind them
					stale.push(...mine.filter((old) => old.spec.holdsParagraph));
					if (drawn === 'plain') fresh.push(plainlyJustified(pos, node));
				}
				shown.set(node, drawn);
				return false;
			});
		const changed = stale.length > 0 || fresh.length > 0;
		const decorations = large ? DecorationSet.empty : changed ? current.remove(stale).add(doc, fresh) : current;
		const plain = large && context.justified;
		if (decorations !== held.decorations || shown !== held.shown || held.native || held.plain !== plain)
			publish({ decorations, shown, native: false, plain });
		if (unchecked.size > 0 && !checkFrame) checkFrame = requestAnimationFrame(check);
	}

	function startOver(): void {
		widthMoving = false;
		broken = new WeakMap();
		outdated = new WeakSet();
		retried = new WeakSet();
		rebreaks = new WeakMap();
		widths = new WeakMap();
		typing.forget();
		context.styleOf = runStyleReader();
		if (view.isDestroyed) return;
		rootWidth = view.dom.clientWidth;
		rebreak(true);
	}

	function wrapNatively(): void {
		if (view.isDestroyed) return;
		const held = lineBreakKey.getState(view.state)!;
		if (!held.native) publish({ ...held, native: true });
	}

	const resized = new ResizeObserver(() => {
		const width = view.dom.clientWidth;
		if (width === rootWidth) return;
		// an editor built before it had a place on the page has nothing drawn yet, so nothing to hold back
		if (rootWidth <= 0) {
			rebreakNextFrame(true);
			return;
		}
		rootWidth = width;
		clearTimeout(widthRest);
		widthRest = window.setTimeout(startOver, WIDTH_REST_MS);
		if (widthMoving) return;
		widthMoving = true;
		requestAnimationFrame(wrapNatively);
	});
	resized.observe(view.dom);

	// a citation that resolves or a formula that gets typeset changes width without a transaction
	const inlineViews = new MutationObserver((records) => {
		const touched = new Set<PMNode>();
		for (const record of records) {
			const element = record.target instanceof Element ? record.target : record.target.parentElement;
			const swapped = [...record.addedNodes].some((node) => node instanceof HTMLElement && node.contentEditable === 'false');
			const inside = swapped ? element : element?.closest('[contenteditable="false"]');
			const paragraph = inside ? paragraphOf(inside) : null;
			if (paragraph && broken.has(paragraph)) touched.add(paragraph);
		}
		if ([...touched].filter(inlineViewChanged).length > 0) rebreak();
	});
	inlineViews.observe(view.dom, { subtree: true, childList: true, characterData: true });

	function fontsLoaded(): void {
		forgetTextWidths();
		startOver();
	}
	document.fonts.addEventListener('loadingdone', fontsLoaded);

	function compositionEnded(): void {
		// the transaction that ends the composition has already gone by
		clearTimeout(afterComposition);
		afterComposition = window.setTimeout(rebreak, 60);
	}
	view.dom.addEventListener('compositionend', compositionEnded);

	const stopObserving = observe(
		(): { justified: boolean; language: DocumentHyphenation } => ({
			justified: settings.current.visualJustify !== false,
			// a document that names no language is taken for English
			language: settings.current.visualHyphenate === false ? 'none' : (templateFeaturesStore.current.hyphenationLanguage ?? 'en-us')
		}),
		(now) => {
			if (wanted === `${now.justified} ${now.language}`) return;
			wanted = `${now.justified} ${now.language}`;
			context.justified = now.justified;
			if (now.language !== language) {
				language = now.language;
				context.hyphenator = null;
				if (now.language !== 'none')
					void loadHyphenator(now.language).then((hyphenator) => {
						if (language !== now.language) return;
						context.hyphenator = hyphenator;
						startOver();
					});
			}
			// the view is still being built when the first value arrives
			queueMicrotask(startOver);
		}
	);

	return {
		update(_, before) {
			const state = view.state;
			const swapped = lineBreakKey.getState(before)?.shown !== lineBreakKey.getState(state)?.shown;
			const again = typing.toBreakAgain(before, state);
			for (const paragraph of again) {
				outdated.add(paragraph);
				retried.delete(paragraph);
			}
			if (swapped || again.length > 0 || before.doc !== state.doc || pmSuggestionsKey.getState(before) !== pmSuggestionsKey.getState(state))
				rebreak();
		},
		destroy() {
			if (checkFrame) cancelAnimationFrame(checkFrame);
			if (rebreakFrame) cancelAnimationFrame(rebreakFrame);
			clearTimeout(afterComposition);
			clearTimeout(widthRest);
			resized.disconnect();
			inlineBoxes.disconnect();
			inlineViews.disconnect();
			document.fonts.removeEventListener('loadingdone', fontsLoaded);
			view.dom.removeEventListener('compositionend', compositionEnded);
			stopObserving();
		}
	};
}

function lineBreakPlugin(): Plugin<LineBreakState> {
	return new Plugin<LineBreakState>({
		key: lineBreakKey,
		state: {
			init: () => ({ decorations: DecorationSet.empty, shown: new WeakMap(), native: false, plain: false }),
			apply(tr, held) {
				const next = tr.getMeta(lineBreakKey) as LineBreakState | undefined;
				if (next || !tr.docChanged) return next ?? held;
				return { ...held, decorations: held.decorations.map(tr.mapping, tr.doc) };
			}
		},
		props: {
			decorations: (state) => lineBreakKey.getState(state)?.decorations,
			attributes(state): Record<string, string> {
				const held = lineBreakKey.getState(state);
				return held?.native ? { class: 'pm-lines-native' } : held?.plain ? { class: 'pm-lines-plain' } : {};
			}
		},
		view: lineBreaker
	});
}

export function lineBreakPlugins(): Plugin[] {
	return [wordBeingTypedPlugin(), lineBreakPlugin()];
}
