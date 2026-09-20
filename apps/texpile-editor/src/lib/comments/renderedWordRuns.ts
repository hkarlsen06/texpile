// the words a reading of marked-up text builds, as the visual editor shows them

/** `closed` names the surrounding formatting the words closed before this run: a tag, or blank for a tex brace */
export type WordRun = { text: string; tags: string[]; closed?: string[] };

export type RenderedWords = WordRun[][];

/**
 * the words, plus what they leave the text around them to balance: the closers and openers, as their delimiters.
 * `chips`: a letter among the words is a chip the editor draws (\'e), which the document's text holds as its source
 */
export type RenderedSource = { words: RenderedWords; closed: string[]; open: string[]; chips?: true };

export const NO_BREAK_SPACE = '\u00A0';

/** what flattenDoc writes for a formula, so typed words fit around one the document draws itself */
export const ATOM = '\u{FFFC}';

/**
 * How the words meet the text around them: whether they begin a line (where md and typ read a
 * list or heading marker; true unless said otherwise), whether a block edge sits on either side,
 * whether a code span opened before them (their first backtick then closes it), and whether one
 * they leave open closes after them, and whether they start inside a heading's braces
 */
export type RenderEdges = {
	lineStart?: boolean;
	breakBefore?: boolean;
	breakAfter?: boolean;
	inCode?: boolean;
	codeAfter?: boolean;
	blockOpen?: boolean;
};

export class Words {
	paragraphs: RenderedWords = [[]];
	tags: string[] = [];
	private chips = false;
	private closed: string[] = [];
	private closedKeys: string[] = [];
	private broke = false;

	add(text: string) {
		const runs = this.paragraphs[this.paragraphs.length - 1];
		const last = runs[runs.length - 1];
		if (last && last.tags.join() === this.tags.join() && (last.closed?.length ?? 0) === this.closed.length) last.text += text;
		else runs.push({ text, tags: [...this.tags], ...(this.closed.length ? { closed: [...this.closed] } : {}) });
		this.broke = false;
	}

	chip(text = '') {
		if (text) this.add(text);
		this.chips = true;
	}

	space() {
		const runs = this.paragraphs[this.paragraphs.length - 1];
		if (!runs[runs.length - 1]?.text.endsWith(' ') && !this.broke) this.add(' ');
	}

	paragraphBreak() {
		if (this.broke) return;
		const runs = this.paragraphs[this.paragraphs.length - 1];
		const last = runs[runs.length - 1];
		if (last) last.text = last.text.trimEnd();
		if (last && !last.text) runs.pop();
		this.paragraphs.push([]);
		this.broke = true;
	}

	closeContext(tag: string, key: string) {
		this.closed.push(tag);
		this.closedKeys.push(key);
	}

	done(open: string[]): RenderedSource {
		return { words: this.paragraphs, closed: this.closedKeys, open, ...(this.chips ? { chips: true as const } : {}) };
	}
}

export function whitespace(s: string, i: number, words: Words, open: unknown[]): number | null {
	let j = i;
	while (j < s.length && /\s/.test(s[j])) j++;
	if (!/\n[ \t\r]*\n/.test(s.slice(i, j))) words.space();
	else if (open.length) return null;
	else words.paragraphBreak();
	return j;
}

// the closing $ of an inline formula, or -1 for display math (a doubled $, or typst's padded form)
export function inlineMathEnd(s: string, open: number, padded: boolean): number {
	const close = s.indexOf('$', open + 1);
	if (s[open + 1] === '$' || close < 0) return -1;
	return padded || !/^\s|\s$/.test(s.slice(open + 1, close)) ? close : -1;
}
