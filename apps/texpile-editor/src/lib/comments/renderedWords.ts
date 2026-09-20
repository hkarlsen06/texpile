// suggestion words as the visual editor shows them, or null when they hold more than formatted text
import type { AnchorDialect } from './anchorNormalize';
import {
	ATOM,
	NO_BREAK_SPACE,
	Words,
	inlineMathEnd,
	whitespace,
	type RenderEdges,
	type RenderedSource,
	type RenderedWords
} from './renderedWordRuns';
import { texWords } from './renderedTexWords';

export { ATOM, type RenderEdges, type RenderedSource, type RenderedWords, type WordRun } from './renderedWordRuns';

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

export function renderSource(source: string, dialect: AnchorDialect, edges: RenderEdges = {}): RenderedSource | null {
	return dialect === 'tex' ? texWords(source, edges) : delimitedWords(source, dialect, edges);
}

export function renderedWords(source: string, dialect: AnchorDialect, edges: RenderEdges = {}): RenderedWords | null {
	return renderSource(source, dialect, edges)?.words ?? null;
}
