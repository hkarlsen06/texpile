// a suggestion drawn as struck old words and tinted new words, when the rendered document shows exactly that
import type { Node as PMNode } from 'prosemirror-model';
import { TextSelection } from 'prosemirror-state';
import type { AnchorDialect, CommentAnchor } from '$lib/comments/anchor';
import type { SuggestionMark } from '$lib/comments/activeSuggestions.svelte';
import { ATOM, renderSource, renderedWords, type RenderedWords, type WordRun } from '$lib/comments/renderedWords';
import { isSelfRendered } from '$lib/editor/visual/diff/selfRendered';
import type { FlatDoc } from './pmCommentsResolve';

type Span = { from: number; to: number };

export type DrawnWords = { from: number; to: number; old: WordRun[] };

const EDGE_SPACE: Record<AnchorDialect, [RegExp, RegExp]> = {
	tex: [/(?:\s|\\par(?![a-zA-Z]))*$/, /^(?:\s|\\par(?![a-zA-Z]))*/],
	md: [/\s*$/, /^\s*/],
	typ: [/\s*$/, /^\s*/]
};

// a line that opens or closes a block ends the paragraph as surely as a blank line
const BLOCK_BEFORE: Record<AnchorDialect, RegExp> = {
	tex: /(?:\\[a-zA-Z]+\*?|[}\]])[ \t]*\n\s*$/,
	md: /(?:^|\n)[ \t]*(?:[-+*>]|\d+[.)]|#{1,6})[ \t]*$/,
	typ: /(?:(?:^|\n)[ \t]*(?:[-+/]|=+|\d+\.)[ \t]*|[}\]][ \t]*\n\s*)$/
};

const BLOCK_AFTER: Record<AnchorDialect, RegExp> = {
	tex: /^\s*\n[ \t]*\\/,
	md: /^\s*\n[ \t]*(?:[-+*>]|\d+[.)]|#{1,6})[ \t]/,
	typ: /^\s*\n[ \t]*(?:(?:[-+/]|=+|\d+\.)[ \t]|#)/
};

// characters that fuse with the same character next to them into another glyph
const JOINING: Record<AnchorDialect, string> = { tex: "-`'", md: '', typ: '-.' };

const LINE_MARKER: Record<'md' | 'typ', RegExp> = {
	md: /^[ \t]*(?:[-+*>]|\d+[.)]|#{1,6})[ \t]/,
	typ: /^[ \t]*(?:[-+/]|=+|\d+\.)[ \t]/
};

// what separates a deletion from the text beside it: only markup there means they were in different runs
const RUN_EDGE: Record<AnchorDialect, [RegExp, RegExp]> = {
	tex: [/(?:\\[a-zA-Z]+\*?|[{}]|\s)*$/, /^(?:\\[a-zA-Z]+\*?|[{}]|\s)*/],
	md: [/[*_~`\s]*$/, /^[*_~`\s]*/],
	typ: [/(?:#[a-zA-Z.]+|[*_`[\]]|\s)*$/, /^(?:#[a-zA-Z.]+|[*_`[\]]|\s)*/]
};

const RUN_MARKUP: Record<AnchorDialect, RegExp> = { tex: /[{}]/, md: /[*_~`]/, typ: /[*_`[\]]/ };

const HEADING_OPEN: Record<AnchorDialect, RegExp> = {
	tex: /\\(?:part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?(?:\[[^\]]*\])?\{[^{}]*$/,
	md: /(?:^|\n)[ \t]*#{1,6}[ \t]+[^\n]*$/,
	typ: /(?:^|\n)[ \t]*=+[ \t]+[^\n]*$/
};

const MARK_TAGS = new Map([
	['em', 'em'],
	['strong', 'strong'],
	['code', 'code'],
	['u', 'u'],
	['sup', 'sup'],
	['sub', 'sub'],
	['s', 's'],
	['link', 'a']
]);

export function pmSpan(doc: PMNode, text: string, index: number[], from: number, to: number): Span | null {
	if (to === from) {
		const after = from > 0 && text[from - 1] !== '\n' && text[from - 1] !== '\u{FFFC}';
		const raw = after ? index[from - 1] + 1 : from < index.length ? index[from] : index.length ? index[index.length - 1] + 1 : null;
		if (raw === null) return null;
		try {
			const at = TextSelection.near(doc.resolve(raw), 1).from;
			return { from: at, to: at };
		} catch {
			return null;
		}
	}
	const a = index[from];
	const b = index[to - 1];
	if (a === undefined || b === undefined) return null;
	const last = doc.nodeAt(b);
	return { from: a, to: b + (last && !last.isText ? last.nodeSize : 1) };
}

function paragraphText(paragraph: WordRun[]): string {
	return paragraph.map((run) => run.text).join('');
}

function shows(paragraph: WordRun[] | undefined): boolean {
	return !!paragraph?.some((run) => /\S/.test(run.text));
}

// a formula the document draws itself can sit among tinted words; a code island cannot
function drawsAsText(doc: PMNode, from: number, to: number): boolean {
	if (!doc.resolve(from).parent.isTextblock || !doc.resolve(to).parent.isTextblock) return false;
	let text = true;
	doc.nodesBetween(from, to, (node) => (text &&= node.isAtom || !isSelfRendered(node)));
	return text;
}

function escapeRegExp(word: string): string {
	return word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function shownParagraphs(words: RenderedWords): number[] {
	return words.flatMap((p, i) => (shows(p) ? [i] : []));
}

function fitWords(text: string, hit: Span, quote: RenderedWords): Span | null {
	const paragraphs = quote.map((p) => paragraphText(p).trim()).filter(Boolean);
	if (paragraphs.length === 0) return { from: hit.from, to: hit.from };
	const pattern = new RegExp(paragraphs.map((p) => p.split(/ +/).map(escapeRegExp).join('[ \\t]+')).join('[ \\t]*\\n[ \\t]*'), 'g');
	const reach = 2 * paragraphs.join('\n').length + 16;
	const start = Math.max(0, hit.from - reach);
	const near = text.slice(start, hit.to + reach);
	let best: Span | null = null;
	for (let m = pattern.exec(near); m && start + m.index <= hit.to; m = pattern.exec(near)) {
		const from = start + m.index;
		if (from + m[0].length < hit.from) continue;
		if (!best || Math.abs(from - hit.from) < Math.abs(best.from - hit.from)) best = { from, to: from + m[0].length };
	}
	return best;
}

function paragraphsFit(doc: PMNode, drawn: Span, quote: RenderedWords, restore: RenderedWords): boolean {
	const atStart = drawn.from === doc.resolve(drawn.from).start();
	const atEnd = drawn.to === doc.resolve(drawn.to).end();
	const fresh = shownParagraphs(quote);
	const [old] = shownParagraphs(restore);
	if (old !== undefined) {
		if (old > 0 && !(atStart && (fresh.length ? fresh[0] === old : quote.length > old))) return false;
		if (old < restore.length - 1 && !atEnd) return false;
	}
	const added = quote.length - restore.length;
	if (added <= 0) return true;
	let blocks = 0;
	doc.nodesBetween(drawn.from, drawn.to, (node) => {
		if (node.isTextblock) blocks++;
		return !node.isTextblock;
	});
	const headWhole = old === undefined && atStart;
	if (blocks <= 1) return (headWhole && atEnd ? 1 : 0) >= added;
	return blocks - 1 + (headWhole ? 1 : 0) + (atEnd ? 1 : 0) >= added;
}

function tagsOf(node: PMNode): string[] {
	return node.marks.flatMap((m) => MARK_TAGS.get(m.type.name) ?? []);
}

// the formatting the old words sat in: what the new words start in, less what they brought themselves
function contextTags(doc: PMNode, drawn: Span, quote: RenderedWords): string[] {
	let first: PMNode | null = null;
	doc.nodesBetween(drawn.from, drawn.to, (node) => {
		if (node.isText) first ??= node;
		return !first && !node.isAtom;
	});
	const own = quote.flat().find((run) => /\S/.test(run.text))?.tags ?? [];
	return first ? tagsOf(first).filter((tag) => !own.includes(tag)) : [];
}

function edgeTags(doc: PMNode, at: number, anchor: CommentAnchor, dialect: AnchorDialect): string[] {
	const [tail, head] = RUN_EDGE[dialect];
	const $at = doc.resolve(at);
	const before = $at.nodeBefore?.isText && !RUN_MARKUP[dialect].test(tail.exec(anchor.prefix)![0]) ? $at.nodeBefore : null;
	const after = $at.nodeAfter?.isText && !RUN_MARKUP[dialect].test(head.exec(anchor.suffix)![0]) ? $at.nodeAfter : null;
	const node = before ?? after;
	return node ? tagsOf(node) : [];
}

// a tex brace can only close one thing for sure, and a plain group closes nothing
function outerTags(context: string[], closed: string[] = []): string[] | null {
	let outer = context;
	for (const tag of closed) {
		if (tag ? !outer.includes(tag) : outer.length > 1) return null;
		outer = tag ? outer.filter((t) => t !== tag) : [];
	}
	return outer;
}

function spacedOldWords(
	doc: PMNode,
	text: string,
	fit: Span,
	drawn: Span,
	anchor: CommentAnchor,
	taken: string,
	old: WordRun[]
): WordRun[] {
	const runs = old.map((run) => ({ ...run }));
	if (!runs.length) return runs;
	const first = runs[0];
	const last = runs[runs.length - 1];
	first.text = first.text.trimStart();
	last.text = last.text.trimEnd();
	function spaceAt(at: number) {
		return /\s/.test(text[at] ?? '\n');
	}
	const afterText = drawn.from !== doc.resolve(drawn.from).start();
	const beforeText = drawn.to !== doc.resolve(drawn.to).end();
	if (afterText && !spaceAt(fit.from - 1) && (/\s$/.test(anchor.prefix) || /^\s/.test(taken))) first.text = ' ' + first.text;
	if (beforeText && !spaceAt(fit.to) && (/^\s/.test(anchor.suffix) || /\s$/.test(taken)) && !/\s$/.test(last.text)) last.text += ' ';
	return runs.filter((run) => run.text);
}

export function placeWords(doc: PMNode, flat: FlatDoc, s: SuggestionMark, hit: Span, dialect: AnchorDialect): DrawnWords | null {
	const [before, after] = EDGE_SPACE[dialect];
	const { prefix, suffix } = s.anchor;
	const edges = [s.anchor.quote, s.restore];
	const breakBefore = edges.some((words) => BLOCK_BEFORE[dialect].test(prefix + /^\s*/.exec(words)![0]));
	const breakAfter = edges.some((words) => BLOCK_AFTER[dialect].test(/\s*$/.exec(words)![0] + suffix));
	const lineStart = prefix === '' || /\n[ \t]*$/.test(prefix);
	// whether the words sit in a code span is read off the document at the hit: the 32 characters of
	// context can hold the closing backtick of a span that opened long before them
	function codeAt(at: number) {
		const node = at < flat.index.length && at >= 0 ? doc.nodeAt(flat.index[at]) : null;
		return !!node?.isText && node.marks.some((m) => m.type.name === 'code');
	}
	const inCode = dialect !== 'tex' && codeAt(hit.from) && (hit.to > hit.from || codeAt(hit.from - 1)) && !/^\s*`/.test(s.anchor.quote);
	const codeAfter = dialect !== 'tex' && suffix.includes('`');
	const $at = hit.from < flat.index.length ? doc.resolve(flat.index[hit.from]) : null;
	const blockOpen = !!$at && $at.parent.type.name === 'heading' && ($at.pos !== $at.start() || HEADING_OPEN[dialect].test(prefix));
	const alone = { lineStart, inCode, codeAfter, blockOpen };
	function inContext(words: string) {
		return renderSource(before.exec(prefix)![0] + words + after.exec(suffix)![0], dialect, { ...alone, breakBefore, breakAfter });
	}
	const termLine = dialect === 'typ' && /(?:^|\n)[ \t]*\/ [^\n]*$/.test(prefix);
	const lineBefore = prefix.slice(prefix.lastIndexOf('\n') + 1);
	const lineAfter = suffix.slice(0, suffix.includes('\n') ? suffix.indexOf('\n') : suffix.length);
	function structural(words: string) {
		if (termLine && words.includes(':')) return true;
		// a markdown table's rule row or a thematic break is a line of dashes that draws as no text
		if (dialect === 'md' && /^[\s|:-]*-[\s|:-]*$/.test(lineBefore + words + lineAfter)) return true;
		return [...JOINING[dialect]].some((c) => (prefix.endsWith(c) && words.startsWith(c)) || (words.endsWith(c) && suffix.startsWith(c)));
	}
	// a marker right after the words is a list item or heading only at the start of a line
	const markerAfter = dialect !== 'tex' && LINE_MARKER[dialect].test(suffix);
	function endsLine(words: string) {
		return /\n[ \t]*$/.test(words) || (!words && /\n[ \t]*$/.test(prefix));
	}
	const fresh = inContext(s.anchor.quote);
	const gone = inContext(s.restore);
	// a letter a chip draws is its source in the document's text: only old words can show it
	if (!fresh || !gone || fresh.chips || structural(s.anchor.quote) || structural(s.restore)) return null;
	if (markerAfter && endsLine(s.anchor.quote) !== endsLine(s.restore)) return null;
	// one edit can arrive as several suggestions; only one that rejects to balanced text on its own is drawn
	if (fresh.closed.join() !== gone.closed.join() || fresh.open.join() !== gone.open.join()) return null;
	const quote = fresh.words;
	const restore = gone.words;
	if (restore.length > quote.length) return null;
	const old = restore.filter(shows);
	if (old.length > 1 || (old.length === 0 && !quote.some(shows))) return null;
	// a formula among the old words has nothing to draw it with
	if (old[0]?.some((run) => run.text.includes(ATOM))) return null;
	const fit = fitWords(flat.text, hit, quote);
	if (!fit) return null;
	const typed = (renderedWords(s.anchor.quote, dialect, alone) ?? []).map(paragraphText).join('\n');
	function spaceAt(at: number) {
		return /[ \u00A0]/.test(flat.text[at] ?? '');
	}
	if (fit.to > fit.from && /^\s/.test(typed) && !/\s$/.test(prefix) && spaceAt(fit.from - 1)) fit.from--;
	if (fit.to > fit.from && /\s$/.test(typed) && !/^\s/.test(suffix) && spaceAt(fit.to)) fit.to++;
	// words that are only a space: the search put its point after it, and the tint belongs on it
	if (fit.to === fit.from && /^[^\S\n]+$/.test(typed) && !/\s$/.test(prefix) && spaceAt(fit.from - 1)) fit.from--;
	const drawn = pmSpan(doc, flat.text, flat.index, fit.from, fit.to);
	if (!drawn || !drawsAsText(doc, drawn.from, drawn.to) || !paragraphsFit(doc, drawn, quote, restore)) return null;
	const taken = (renderedWords(s.restore, dialect, alone) ?? []).map(paragraphText).join('\n');
	const context = drawn.to > drawn.from ? contextTags(doc, drawn, quote) : edgeTags(doc, drawn.from, s.anchor, dialect);
	const inside: WordRun[] = [];
	for (const run of old[0] ?? (/[^\S\n]/.test(taken) ? [{ text: ' ', tags: [] }] : [])) {
		const outer = outerTags(context, run.closed);
		if (!outer) return null;
		inside.push({ text: run.text, tags: [...outer.filter((tag) => !run.tags.includes(tag)), ...run.tags] });
	}
	return { ...drawn, old: spacedOldWords(doc, flat.text, fit, drawn, s.anchor, taken, inside) };
}
