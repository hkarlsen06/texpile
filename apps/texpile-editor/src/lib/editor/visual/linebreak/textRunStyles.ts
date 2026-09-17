// how a run of text in the visual editor is drawn, as far as its width goes
import type { Node as PMNode } from 'prosemirror-model';
import type { EditorView } from 'prosemirror-view';

export type TextRunStyle = {
	/** every field below in one string, to keep widths under */
	key: string;
	font: string;
	letterSpacing: string;
	wordSpacing: string;
	kerning: CanvasFontKerning;
	caps: CanvasFontVariantCaps;
	/** false when the text alone does not give its width: transformed case, right to left, a stretched face */
	measurable: boolean;
};

function styleOfElement(element: Element): TextRunStyle {
	const style = getComputedStyle(element);
	// style.font reads '' here: the editor turns ligatures off, which the shorthand cannot say
	const font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
	const letterSpacing = style.letterSpacing === 'normal' ? '0px' : style.letterSpacing;
	const wordSpacing = style.wordSpacing === 'normal' ? '0px' : style.wordSpacing;
	const kerning = style.fontKerning as CanvasFontKerning;
	const caps = style.fontVariantCaps as CanvasFontVariantCaps;
	const stretched = style.fontStretch !== '100%' && style.fontStretch !== 'normal';
	return {
		key: [font, letterSpacing, wordSpacing, kerning, caps].join('|'),
		font,
		letterSpacing,
		wordSpacing,
		kerning,
		caps,
		measurable: style.textTransform === 'none' && style.direction === 'ltr' && !stretched
	};
}

function deepestElementAt(view: EditorView, pos: number): Element | null {
	const at = view.domAtPos(pos, 1);
	let node: Node | null = at.node.nodeType === Node.TEXT_NODE ? at.node : (at.node.childNodes[at.offset] ?? at.node);
	while (node?.firstChild) node = node.firstChild;
	if (!node) return null;
	return node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element);
}

export type RunStyleReader = (view: EditorView, block: HTMLElement, run: PMNode, pos: number) => TextRunStyle | null;

/** reads a style once for each set of marks in a block; a block keeps its element across edits */
export function runStyleReader(): RunStyleReader {
	const seen = new WeakMap<HTMLElement, Map<string, TextRunStyle>>();
	return (view, block, run, pos) => {
		let styles = seen.get(block);
		if (!styles) seen.set(block, (styles = new Map()));
		const marks = run.marks.map((mark) => mark.type.name + JSON.stringify(mark.attrs)).join();
		let style = styles.get(marks);
		if (!style) {
			const element = deepestElementAt(view, pos);
			if (!element || !block.contains(element)) return null;
			styles.set(marks, (style = styleOfElement(element)));
		}
		return style;
	};
}
