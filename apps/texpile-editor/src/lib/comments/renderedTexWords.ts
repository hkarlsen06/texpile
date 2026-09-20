// LaTeX read as the words the visual editor shows, or null when it holds more than formatted text
import { readTexCharacter } from '$lib/languages/latex/texCharacters';
import { ATOM, NO_BREAK_SPACE, Words, inlineMathEnd, whitespace, type RenderEdges, type RenderedSource } from './renderedWordRuns';

const TEX_TAGS = new Map([
	['textit', 'em'],
	['emph', 'em'],
	['textbf', 'strong'],
	['texttt', 'code'],
	['underline', 'u'],
	['textsuperscript', 'sup'],
	['textsubscript', 'sub']
]);

// symbols the parser writes as text; the rest stay chips
const TEX_TEXT_SYMBOLS = new Set(['ldots', 'dots', 'textbackslash', 'textasciitilde', 'textasciicircum', 'textendash', 'textemdash']);

// {\bf ...} and friends: the switch formats the rest of its group
const TEX_SWITCHES = new Map([
	['bf', 'strong'],
	['bfseries', 'strong'],
	['it', 'em'],
	['itshape', 'em'],
	['em', 'em'],
	['sl', 'em'],
	['slshape', 'em'],
	['tt', 'code'],
	['ttfamily', 'code']
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

/** `outer`: opened before the words, so what a switch in it formats runs on past them */
type TexGroup = { tags: number; block: boolean; outer?: boolean };

// a line break is a chip, and the line end after it is not a space
function lineBreak(s: string, at: number, words: Words): number {
	words.add(ATOM);
	let i = at;
	while (i < s.length && /\s/.test(s[i])) i++;
	if (/\n[ \t\r]*\n/.test(s.slice(at, i))) words.paragraphBreak();
	return i;
}

export function texWords(s: string, edges: RenderEdges): RenderedSource | null {
	const words = new Words();
	const groups: TexGroup[] = [];
	function open(tag: string | null, block = false) {
		groups.push({ tags: tag !== null ? 1 : 0, block });
		if (tag !== null) words.tags.push(tag);
		if (block) words.paragraphBreak();
	}
	if (edges.breakBefore) words.paragraphBreak();
	if (edges.blockOpen) groups.push({ tags: 0, block: true, outer: true });
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
				const character = readTexCharacter(s, i);
				if (character) {
					words.chip(character.text);
					i = character.end;
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
			} else if (TEX_SWITCHES.has(name)) {
				const group = groups[groups.length - 1];
				if (!group || group.outer) return null;
				group.tags++;
				words.tags.push(TEX_SWITCHES.get(name)!);
				// the editor keeps a switch's group as a chip
				words.chip();
				i += /^[ \t]*(?:\n(?![ \t]*\n)[ \t]*)?/.exec(s.slice(i))![0].length;
			} else {
				const character = readTexCharacter(s, i - 1 - name.length);
				if (!character) return null;
				if (TEX_TEXT_SYMBOLS.has(name)) words.add(character.text);
				else words.chip(character.text);
				i = character.end;
			}
		} else if (c === '{' || c === '}') {
			if (c === '{') groups.push({ tags: 0, block: false });
			else if (groups.length === 0) words.closeContext('', '}');
			else {
				const group = groups.pop()!;
				words.tags.length -= group.tags;
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
