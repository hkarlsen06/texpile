// suggestion words as the visual editor shows them, or null when they hold more than formatted text
import type { AnchorDialect } from './anchorNormalize';

/** `closed` names the surrounding formatting the words closed before this run: a tag, or blank for a tex brace */
export type WordRun = { text: string; tags: string[]; closed?: string[] };

export type RenderedWords = WordRun[][];

/** the words, plus what they leave the text around them to balance: the closers and openers, as their delimiters */
export type RenderedSource = { words: RenderedWords; closed: string[]; open: string[] };

const NO_BREAK_SPACE = '\u00A0';

/** what flattenDoc writes for a formula, so typed words fit around one the document draws itself */
export const ATOM = '\u{FFFC}';

const TEX_TAGS = new Map([
	['textit', 'em'],
	['emph', 'em'],
	['textbf', 'strong'],
	['texttt', 'code'],
	['underline', 'u'],
	['textsuperscript', 'sup'],
	['textsubscript', 'sub']
]);

const TEX_CHARACTERS = new Map([
	['ldots', '…'],
	['dots', '…'],
	['textbackslash', '\\'],
	['textasciitilde', '~'],
	['textasciicircum', '^']
]);

// commands the editor draws as a chip in the text
const TEX_CHIPS = new Set(['cite', 'citep', 'citet', 'parencite', 'textcite', 'autocite', 'ref', 'eqref', 'label']);

const TEX_HEADINGS = new Set(['part', 'chapter', 'section', 'subsection', 'subsubsection', 'paragraph', 'subparagraph']);

// environments whose body the editor shows as ordinary paragraphs
const TEX_BLOCK_ENVS = new Set([
	'itemize',
	'enumerate',
	'description',
	'quote',
	'quotation',
	'abstract',
	'center',
	'flushleft',
	'flushright'
]);

const TYP_TAGS = new Map([
	['strong', 'strong'],
	['emph', 'em'],
	['underline', 'u'],
	['super', 'sup'],
	['sub', 'sub'],
	['link', 'a']
]);

const MD_LINK = /^\[((?:\\.|[^[\]\\\n])*)\]\(((?:[^()\s]|\([^()\s]*\))*)(?:\s+(?:"[^"]*"|'[^']*'))?\)/;
const TYP_CALL = /^#([a-z]+)(?:\("((?:[^"\\]|\\.)*)"\))?/;

class Words {
	paragraphs: RenderedWords = [[]];
	tags: string[] = [];
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
		return { words: this.paragraphs, closed: this.closedKeys, open };
	}
}

function whitespace(s: string, i: number, words: Words, open: unknown[]): number | null {
	let j = i;
	while (j < s.length && /\s/.test(s[j])) j++;
	if (!/\n[ \t\r]*\n/.test(s.slice(i, j))) words.space();
	else if (open.length) return null;
	else words.paragraphBreak();
	return j;
}

// the closing $ of an inline formula, or -1 for display math (a doubled $, or typst's padded form)
function inlineMathEnd(s: string, open: number, padded: boolean): number {
	const close = s.indexOf('$', open + 1);
	if (s[open + 1] === '$' || close < 0) return -1;
	return padded || !/^\s|\s$/.test(s.slice(open + 1, close)) ? close : -1;
}

function groupEnd(s: string, open: number): number {
	let depth = 0;
	for (let i = open; i < s.length; i++) {
		if (s[i] === '{') depth++;
		else if (s[i] === '}' && --depth === 0) return i;
	}
	return -1;
}

// arguments written right after a command: any [..] then the {..} groups, balanced
function argsEnd(s: string, at: number, groups: number): number {
	let i = at;
	if (s[i] === '*') i++;
	while (s[i] === '[') {
		const close = s.indexOf(']', i);
		if (close < 0) return -1;
		i = close + 1;
	}
	for (let n = 0; n < groups; n++) {
		if (s[i] !== '{') return -1;
		const end = groupEnd(s, i);
		if (end < 0) return -1;
		i = end + 1;
	}
	return i;
}

type TexGroup = { tag: boolean; block: boolean };

// a line break is a chip, and the line end after it is not a space
function lineBreak(s: string, at: number, words: Words): number {
	words.add(ATOM);
	let i = at;
	while (i < s.length && /\s/.test(s[i])) i++;
	if (/\n[ \t\r]*\n/.test(s.slice(at, i))) words.paragraphBreak();
	return i;
}

function texWords(s: string, edges: RenderEdges): RenderedSource | null {
	const words = new Words();
	const groups: TexGroup[] = [];
	function open(tag: string | null, block = false) {
		groups.push({ tag: tag !== null, block });
		if (tag !== null) words.tags.push(tag);
		if (block) words.paragraphBreak();
	}
	if (edges.breakBefore) words.paragraphBreak();
	if (edges.blockOpen) groups.push({ tag: false, block: true });
	for (let i = 0; i < s.length;) {
		const c = s[i];
		if (/\s/.test(c)) {
			const next = whitespace(s, i, words, groups);
			if (next === null) return null;
			i = next;
		} else if (c === '\\') {
			const name = /^[a-zA-Z]+/.exec(s.slice(i + 1, i + 32))?.[0];
			if (!name) {
				if (s[i + 1] === '(') {
					const close = s.indexOf('\\)', i + 2);
					if (close < 0) return null;
					words.add(ATOM);
					i = close + 2;
					continue;
				}
				if (s[i + 1] === '\\' && s[i + 2] !== '[') {
					i = lineBreak(s, i + (s[i + 2] === '*' ? 3 : 2), words);
					continue;
				}
				if (!s[i + 1] || !'%$&#_{}'.includes(s[i + 1])) return null;
				words.add(s[i + 1]);
				i += 2;
				continue;
			}
			i += 1 + name.length;
			if (name === 'par') {
				if (groups.length) return null;
				words.paragraphBreak();
			} else if (TEX_CHARACTERS.has(name)) {
				words.add(TEX_CHARACTERS.get(name)!);
				if (s.startsWith('{}', i)) i += 2;
				else while (s[i] === ' ') i++;
			} else if ((name === 'url' || name === 'href') && s[i] === '{') {
				const end = groupEnd(s, i);
				if (end < 0) return null;
				if (name === 'href' && s[end + 1] === '{') {
					open('a');
					i = end + 2;
				} else {
					words.tags.push('a');
					words.add(s.slice(i + 1, end));
					words.tags.pop();
					i = end + 1;
				}
			} else if (TEX_TAGS.has(name) && s[i] === '{') {
				open(TEX_TAGS.get(name)!);
				i++;
			} else if (TEX_CHIPS.has(name)) {
				const end = argsEnd(s, i, 1);
				if (end < 0) return null;
				words.add(ATOM);
				i = end;
			} else if (name === 'newline') {
				i = lineBreak(s, i, words);
			} else if (name === 'textcolor' || name === 'hl') {
				const end = argsEnd(s, i, name === 'hl' ? 0 : 1);
				if (end < 0 || s[end] !== '{') return null;
				open(null);
				i = end + 1;
			} else if (name === 'sethlcolor') {
				const end = argsEnd(s, i, 1);
				if (end < 0) return null;
				i = end;
			} else if (TEX_HEADINGS.has(name)) {
				const end = argsEnd(s, i, 0);
				if (end < 0 || s[end] !== '{' || groups.length) return null;
				open(null, true);
				i = end + 1;
			} else if (name === 'begin' || name === 'end') {
				const env = /^\{([a-zA-Z*]+)\}/.exec(s.slice(i));
				if (!env || !TEX_BLOCK_ENVS.has(env[1]) || groups.length) return null;
				i += env[0].length;
				while (s[i] === '[') {
					const close = s.indexOf(']', i);
					if (close < 0) return null;
					i = close + 1;
				}
				words.paragraphBreak();
			} else if (name === 'item') {
				if (s[i] === '[' || groups.length) return null;
				words.paragraphBreak();
			} else return null;
		} else if (c === '{' || c === '}') {
			if (c === '{') groups.push({ tag: false, block: false });
			else if (groups.length === 0) words.closeContext('', '}');
			else {
				const group = groups.pop()!;
				if (group.tag) words.tags.pop();
				if (group.block) words.paragraphBreak();
			}
			i++;
		} else if (c === '$') {
			const close = inlineMathEnd(s, i, true);
			if (close < 0) return null;
			words.add(ATOM);
			i = close + 1;
		} else if ('%&#^_'.includes(c)) {
			return null;
		} else if (c === '-' && s[i + 1] === '-') {
			const em = s[i + 2] === '-';
			words.add(em ? '—' : '–');
			i += em ? 3 : 2;
		} else if (c === '`' || c === "'") {
			const double = s[i + 1] === c;
			words.add(c === '`' ? (double ? '“' : '‘') : double ? '”' : '’');
			i += double ? 2 : 1;
		} else {
			words.add(c === '~' ? NO_BREAK_SPACE : c);
			i++;
		}
	}
	if (edges.breakAfter) words.paragraphBreak();
	return words.done(groups.map(() => '{'));
}

function isWordCharacter(c: string | undefined): boolean {
	return c !== undefined && /[\p{L}\p{N}]/u.test(c);
}

function delimiterTag(c: string, run: number, md: boolean): string | null {
	if (c === '~') return run === 2 ? 's' : null;
	if (md) return run === 1 ? 'em' : run === 2 ? 'strong' : null;
	return run === 1 ? (c === '*' ? 'strong' : 'em') : null;
}

function isMarkup(s: string, i: number, md: boolean): boolean {
	if (md) return '[]<|$'.includes(s[i]) || /^(?:&#?\w+;|---|===)/.test(s.slice(i, i + 12));
	return '#$<@[]'.includes(s[i]) || (s[i] === '/' && (s[i + 1] === '/' || s[i + 1] === '*'));
}

function delimitedWords(s: string, dialect: 'md' | 'typ', edges: RenderEdges): RenderedSource | null {
	const md = dialect === 'md';
	// a heading, list item, term or quote marker at the start of a line: the block it opens is its
	// own paragraph in the editor
	const structure = md ? /^[ \t]*(?:[-+*>]|\d+[.)]|#{1,6})[ \t]+/ : /^[ \t]*(?:[-+/]|=+|\d+\.)[ \t]+/;
	// delimiters on their own are markup, whatever they end up pairing with
	if (/^[\s`*_~]*[`*_~][\s`*_~]*$/.test(s)) return null;
	const words = new Words();
	const open: string[] = [];
	const groups: string[] = [];
	let link: { end: number; skip: number } | null = null;
	const firstText = s.search(/\S/);
	let heading = !!edges.blockOpen;
	if (edges.breakBefore) words.paragraphBreak();
	function code(from: number): number {
		const close = s.indexOf('`', from);
		// a backtick nothing closes is literal, unless the text after the words closes it
		if (close < 0 && !edges.codeAfter && !(from === 0 && edges.inCode)) {
			words.add('`');
			return from;
		}
		words.tags.push('code');
		words.add(s.slice(from, close < 0 ? s.length : close));
		words.tags.pop();
		return close < 0 ? s.length : close + 1;
	}
	for (let i = edges.inCode ? code(0) : 0; i < s.length;) {
		if (link && i === link.end) {
			if (words.tags[words.tags.length - 1] !== 'a') return null;
			words.tags.pop();
			i = link.skip;
			link = null;
			continue;
		}
		const c = s[i];
		const startsLine = i === firstText ? edges.lineStart !== false || s.slice(0, i).includes('\n') : s[i - 1] === '\n';
		const marker = startsLine && structure.exec(s.slice(i));
		if (marker) {
			if (open.length || groups.length || link) return null;
			words.paragraphBreak();
			i += marker[0].length;
		} else if (/\s/.test(c)) {
			// a marker on the line after this whitespace keeps its indentation
			let j = i;
			while (j < s.length && /\s/.test(s[j])) j++;
			const line = s.lastIndexOf('\n', j - 1);
			if (heading && line >= i) {
				if (open.length || groups.length || link) return null;
				words.paragraphBreak();
				heading = false;
				i = j;
				continue;
			}
			const next = whitespace(line >= i && structure.test(s.slice(line + 1)) ? s.slice(0, line + 1) : s, i, words, open);
			if (next === null) return null;
			i = next;
		} else if (c === '\\') {
			const next = s[i + 1];
			if (!next || /\s/.test(next) || (!md && next === 'u' && s[i + 2] === '{')) return null;
			if (md && !/[!-/:-@[-`{-~]/.test(next)) words.add(c);
			else {
				words.add(next);
				i++;
			}
			i++;
		} else if (c === '`') {
			if (s[i + 1] === '`') return null;
			i = code(i + 1);
		} else if (c === '*' || c === '_' || (md && c === '~' && s[i + 1] === '~')) {
			let j = i;
			while (s[j] === c) j++;
			const intraword = isWordCharacter(s[i - 1]) && isWordCharacter(s[j]);
			if (intraword && md && c === '_') words.add(s.slice(i, j));
			else if (intraword && !md) return null;
			else {
				const tag = delimiterTag(c, j - i, md);
				if (!tag) return null;
				const key = s.slice(i, j);
				const opens = s[j] !== undefined && !/\s/.test(s[j]);
				const closes = i > 0 && !/\s/.test(s[i - 1]);
				if (open[open.length - 1] === key) {
					open.pop();
					words.tags.pop();
				} else if (open.includes(key)) return null;
				else if (closes && !opens) words.closeContext(tag, key);
				else if (opens) {
					open.push(key);
					words.tags.push(tag);
				} else words.add(key);
			}
			i = j;
		} else if (md && c === '[') {
			const m = MD_LINK.exec(s.slice(i));
			if (!m || s[i - 1] === '!') return null;
			link = { end: i + 1 + m[1].length, skip: i + m[0].length };
			words.tags.push('a');
			i++;
		} else if (md && c === ']' && s[i + 1] === '(') {
			const close = s.indexOf(')', i);
			if (close < 0) return null;
			words.closeContext('a', '](');
			i = close + 1;
		} else if (!md && c === '#') {
			const m = TYP_CALL.exec(s.slice(i));
			const tag = m && TYP_TAGS.get(m[1]);
			if (!tag || (m[1] === 'link') !== (m[2] !== undefined)) return null;
			i += m[0].length;
			if (s[i] === '[') {
				groups.push(tag);
				words.tags.push(tag);
				i++;
			} else if (m[2] !== undefined) {
				words.tags.push(tag);
				words.add(m[2]);
				words.tags.pop();
			} else return null;
		} else if (!md && c === ']') {
			if (groups.pop() === undefined) words.closeContext('', ']');
			else words.tags.pop();
			i++;
		} else if (c === '$') {
			const close = inlineMathEnd(s, i, md);
			if (close < 0) return null;
			words.add(ATOM);
			i = close + 1;
		} else if (isMarkup(s, i, md)) {
			return null;
		} else if (!md && c === '-' && s[i + 1] === '-') {
			const em = s[i + 2] === '-';
			words.add(em ? '—' : '–');
			i += em ? 3 : 2;
		} else if (!md && s.startsWith('...', i)) {
			words.add('…');
			i += 3;
		} else if (!md && s.startsWith('-?', i)) {
			words.add('\u00AD');
			i += 2;
		} else {
			words.add(!md && c === '~' ? NO_BREAK_SPACE : c);
			i++;
		}
	}
	if (edges.breakAfter) words.paragraphBreak();
	return words.done([...open, ...groups.map(() => '['), ...(link ? ['['] : [])]);
}

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

export function renderSource(source: string, dialect: AnchorDialect, edges: RenderEdges = {}): RenderedSource | null {
	return dialect === 'tex' ? texWords(source, edges) : delimitedWords(source, dialect, edges);
}

export function renderedWords(source: string, dialect: AnchorDialect, edges: RenderEdges = {}): RenderedWords | null {
	return renderSource(source, dialect, edges)?.words ?? null;
}
