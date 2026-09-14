// the inline layer: text escaping, mark delimiters, and mark-aware run rendering
import type { Node, Mark } from 'prosemirror-model';
import { latexToTypst } from './latexToTypst';

/** a math node's typst: the stored source while its LaTeX is untouched, else MathLive's
 *  conversion, else the stored source again. never the LaTeX: a .typ cannot hold it */
export function mathTypstOf(node: Node): string {
	const latex = node.textContent;
	const typst = typeof node.attrs.typst === 'string' ? node.attrs.typst : null;
	if (typst != null && latex === node.attrs.latexOrig) return typst;
	return latexToTypst(latex) ?? typst ?? '';
}

/** inline math keeps its padding across an edit: `$ x $` mid-paragraph is display math */
function inlineMathTypst(node: Node): string {
	const t = mathTypstOf(node);
	const orig = typeof node.attrs.typst === 'string' ? node.attrs.typst : '';
	if (t === orig || !/^\s/.test(orig) || !/\s$/.test(orig)) return t;
	return ` ${t.trim()} `;
}

/** list/term/heading markers and "1." enum markers bind at line start, indentation included */
export function escLineStart(str: string): string {
	return str.replace(/^(\s*)([-+/=])/, '$1\\$2').replace(/^(\s*)(\d+)\./, '$1$2\\.');
}

function wordy(ch: string): boolean {
	return /[\p{L}\p{N}]/u.test(ch) && !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(ch);
}

/**
 * Backslash-escape Typst markup structure. `_` stays literal intraword (Typst emphasis only
 * opens at word boundaries, so snake_case is safe); `@` only starts a ref before a word char;
 * `//` would start a comment, so the first slash of a pair is escaped. `extra` lists characters
 * that are structure only in the caller's context (the colon of a term title).
 */
export function escTypst(str: string, startOfLine = false, extra = ''): string {
	let out = '';
	for (let i = 0; i < str.length; i++) {
		const ch = str[i];
		if ('\\#$`*[]<~'.includes(ch) || (extra && extra.includes(ch))) {
			out += '\\' + ch;
			continue;
		}
		if (ch === '_') {
			const intraword = i > 0 && i + 1 < str.length && wordy(str[i - 1]) && wordy(str[i + 1]);
			out += intraword ? ch : '\\_';
			continue;
		}
		if (ch === '@' && /[\p{L}\p{N}\p{M}\p{Pc}-]/u.test(str[i + 1] ?? '')) {
			out += '\\@';
			continue;
		}
		if (ch === '-' && str[i + 1] === '?') {
			out += '\\-';
			continue;
		}
		if (ch === '/' && str[i + 1] === '/') {
			out += '\\/';
			continue;
		}
		out += ch;
	}
	return startOfLine ? escLineStart(out) : out;
}

/** inline raw. typst has no two-backtick form and the three-backtick one takes a language word,
 *  so a backtick inside the text goes through the function form */
function codeSpan(text: string): string {
	return text.includes('`') ? `#raw(${typStr(text)})` : '`' + text + '`';
}

const STR_ESCAPES: Record<string, string> = { '"': '\\"', '\\': '\\\\', '\n': '\\n', '\r': '\\r', '\t': '\\t' };

/** typst string literal; the inverse of unquote. control characters take the \u{..} form */
export function typStr(value: string): string {
	let out = '"';
	for (const ch of value) {
		const code = ch.codePointAt(0)!;
		out += STR_ESCAPES[ch] ?? (code < 0x20 || code === 0x7f ? `\\u{${code.toString(16)}}` : ch);
	}
	return out + '"';
}

type MarkDelims = {
	open: string;
	close: string;
	/** emphasis family: delimiters can't touch whitespace, boundary ws moves outside. */
	expel?: boolean;
};

// typst named colors (shared with the converter's accept list); cyan/magenta are CSS-only names
// the dropdowns can produce, mapped to their rgb forms
const TYP_COLOR_IDENTS = new Set([
	'black',
	'gray',
	'silver',
	'white',
	'navy',
	'blue',
	'aqua',
	'teal',
	'purple',
	'fuchsia',
	'maroon',
	'red',
	'orange',
	'yellow',
	'olive',
	'green',
	'lime'
]);
const CSS_ONLY_COLORS: Record<string, string> = { cyan: '#00ffff', magenta: '#ff00ff' };

/** a mark's CSS color -> a typst color expression, or null when unrepresentable. */
function typColor(css: string): string | null {
	const v = css.trim().toLowerCase();
	if (TYP_COLOR_IDENTS.has(v)) return v;
	const hex = CSS_ONLY_COLORS[v] ?? (/^#[0-9a-f]{3,8}$/.test(v) ? v : null);
	return hex ? `rgb(${JSON.stringify(hex)})` : null;
}

const MARK_DELIMS: Record<string, (attrs: Record<string, unknown>) => MarkDelims> = {
	link: (a) => ({ open: `#link(${typStr(String(a.href ?? ''))})[`, close: ']' }),
	strong: () => ({ open: '*', close: '*', expel: true }),
	em: () => ({ open: '_', close: '_', expel: true }),
	u: () => ({ open: '#underline[', close: ']' }),
	sup: () => ({ open: '#super[', close: ']' }),
	sub: () => ({ open: '#sub[', close: ']' }),
	// an unrepresentable color (a pasted CSS value typst has no name for) drops the wrapper but
	// keeps the content - the color was never expressible in the file
	highlight: (a) => {
		const c = String(a.color ?? 'yellow')
			.trim()
			.toLowerCase();
		if (c === 'yellow') return { open: '#highlight[', close: ']' };
		const t = typColor(c);
		return t ? { open: `#highlight(fill: ${t})[`, close: ']' } : { open: '', close: '' };
	},
	textcolor: (a) => {
		const t = typColor(String(a.color ?? ''));
		return t ? { open: `#text(fill: ${t})[`, close: ']' } : { open: '', close: '' };
	}
};

// canonical nesting order (outermost first); code is innermost and handled inside run content
const MARK_ORDER = ['textcolor', 'highlight', 'u', 'sup', 'sub', 'link', 'strong', 'em'];

function orderedMarks(marks: readonly Mark[]): Mark[] {
	return marks
		.filter((m) => m.type.name !== 'code')
		.sort((a, b) => {
			const ia = MARK_ORDER.indexOf(a.type.name);
			const ib = MARK_ORDER.indexOf(b.type.name);
			return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
		});
}

type InlineRun = {
	content: string;
	marks: Mark[];
	/** 'text' is plain prose (escaped, whitespace expelling applies); 'comment' a `//` chip that
	 *  owns the rest of its line; 'ref' an @target atom */
	kind: 'text' | 'comment' | 'ref' | 'break' | 'other';
};

function buildRuns(parent: Node, startOfLine: boolean, extra: string, singleLine: boolean): InlineRun[] {
	const runs: InlineRun[] = [];
	let atLineStart = startOfLine;
	parent.forEach((node) => {
		if (node.isText) {
			const text = node.text ?? '';
			if (node.marks.some((m) => m.type.name === 'code')) {
				runs.push({ content: codeSpan(text), marks: orderedMarks(node.marks), kind: 'other' });
			} else {
				// a space typed after a hard break stays on the break's line (typst drops
				// indentation after a line end, so `\` + newline + space would lose it)
				const prev = runs[runs.length - 1];
				const marks = orderedMarks(node.marks);
				if (prev?.kind === 'break' && /^[ \t]/.test(text) && marks.length === 0) prev.content = '\\';
				runs.push({ content: escTypst(text, atLineStart, extra), marks, kind: 'text' });
			}
			atLineStart = false;
			return;
		}
		switch (node.type.name) {
			case 'hard_break':
				if (node.attrs?.lineBreak === false) return; // legacy no-op break
				runs.push({ content: singleLine ? '\\ ' : '\\\n', marks: [], kind: 'break' });
				atLineStart = !singleLine;
				return;
			case 'inline_latex': {
				const text = node.textContent;
				runs.push({ content: text, marks: orderedMarks(node.marks), kind: text.startsWith('//') ? 'comment' : 'other' });
				break;
			}
			case 'typ_ref':
				runs.push({ content: `@${String(node.attrs.target ?? '')}`, marks: orderedMarks(node.marks), kind: 'ref' });
				break;
			case 'inline_math': {
				const t = inlineMathTypst(node);
				runs.push({ content: t.trim() ? `$${t}$` : '', marks: orderedMarks(node.marks), kind: 'other' });
				break;
			}
			default:
				runs.push({ content: node.isLeaf ? '' : renderInline(node, false), marks: orderedMarks(node.marks), kind: 'other' });
		}
		atLineStart = false;
	});
	return runs.filter((r) => r.content !== '');
}

function commonPrefixLen(a: readonly Mark[], b: readonly Mark[]): number {
	let n = 0;
	while (n < a.length && n < b.length && a[n].eq(b[n])) n++;
	return n;
}

/** typst's in_word test: `*` and `_` are literal between two alphanumerics */
function isAlnum(ch: string | undefined): boolean {
	return ch != null && /[\p{L}\p{N}]/u.test(ch);
}

/** the run index where the mark at position `k` of run `r` closes */
function spanEnd(runs: InlineRun[], r: number, k: number): number {
	let j = r;
	while (j + 1 < runs.length && commonPrefixLen(runs[j].marks, runs[j + 1].marks) > k) j++;
	return j;
}

/** the character emitted right after the mark at position `k` closes behind run `end`; '' when
 *  a delimiter comes first */
function charAfterSpan(runs: InlineRun[], end: number, k: number): string {
	const next = runs[end + 1];
	if (!next) return '';
	const keep = commonPrefixLen(runs[end].marks, next.marks);
	if (k !== keep || next.marks.length > keep) return '';
	return next.content[0] ?? '';
}

/** would this text extend a ref marker it follows? typst eats [A-Za-z0-9_:.-] after `@`,
 *  giving back only trailing `.`/`:` */
function extendsRef(s: string): boolean {
	return /^[\p{L}\p{N}_-]/u.test(s) || /^[.:]+[\p{L}\p{N}_-]/u.test(s);
}

function extendsUrl(s: string): boolean {
	const on = /^[0-9A-Za-z#$%&*+\-/=@_~[(]/;
	return on.test(s) || on.test(s.replace(/^[!,.:;?']+/, ''));
}

function continuesCode(code: string, s: string): boolean {
	if (/^[([;]/.test(s) || /^\.[\p{L}_]/u.test(s)) return true;
	return /[\p{L}\p{N}_-]$/u.test(code) && /^[\p{L}\p{N}\p{M}_-]/u.test(s);
}

type ActiveMark = { mark: Mark; close: string; expel: boolean };

/** minimal open/close mark transitions over same-mark runs, expelling boundary whitespace out
 *  of emphasis delimiters (`* bold*` never parses back as strong). */
export function renderInline(parent: Node, startOfLine = true, extra = '', singleLine = false): string {
	const runs = buildRuns(parent, startOfLine, extra, singleLine);
	let out = '';
	let active: ActiveMark[] = [];
	// where the last @ref was written, while the next emission may still extend it
	let refAt = -1;
	let refTarget = '';
	let urlEnd = -1;
	let codeEnd = -1;
	let code = '';
	// a // comment owns the rest of its line: the next emission starts a new one
	let lineEnd = false;

	function emit(s: string, text = false) {
		if (!s) return;
		let piece = s;
		if (refAt >= 0) {
			if (extendsRef(piece)) out = out.slice(0, refAt) + `#ref(<${refTarget}>)`;
			refAt = -1;
		}
		const escapable = text && !piece.startsWith('u{');
		if (urlEnd === out.length && extendsUrl(piece)) {
			if (escapable) piece = '\\' + piece;
			else {
				const start = out.search(/https?:\/\/\S*$/);
				out = out.slice(0, start) + `#link(${typStr(out.slice(start))})`;
			}
		}
		urlEnd = -1;
		if (escapable && codeEnd === out.length && continuesCode(code, piece)) piece = '\\' + piece;
		codeEnd = -1;
		if (/^[/*]/.test(piece) && /(^|[^\\])(\\\\)*\/$/.test(out)) out = out.slice(0, -1) + '\\/';
		out += piece;
	}

	function emitCloses(closing: ActiveMark[], allowSteal: boolean) {
		let stolen = '';
		if (allowSteal && closing.some((a) => a.expel)) {
			const ws = out.match(/(\s+)$/);
			if (ws && ws[1].length < out.length) {
				out = out.slice(0, -ws[1].length);
				stolen = ws[1];
			}
		}
		for (const a of closing) emit(a.close);
		emit(stolen);
	}

	for (let r = 0; r < runs.length; r++) {
		const run = runs[r];
		let content = run.content;
		let newLine = false;
		if (lineEnd) {
			emit('\n');
			lineEnd = false;
			newLine = true;
			if (run.kind === 'text') content = escLineStart(content.replace(/^[ \t]+/, ''));
		}
		const keep = commonPrefixLen(
			active.map((a) => a.mark),
			run.marks
		);
		emitCloses(active.slice(keep).reverse(), !newLine);
		active = active.slice(0, keep);
		let bracketBody = false;
		for (let k = keep; k < run.marks.length; k++) {
			const m = run.marks[k];
			const d = MARK_DELIMS[m.type.name]?.(m.attrs);
			if (!d) {
				active.push({ mark: m, close: '', expel: false });
				continue;
			}
			if (!d.expel) {
				emit(d.open);
				active.push({ mark: m, close: d.close, expel: false });
				bracketBody = d.open.endsWith('[');
				continue;
			}
			const end = spanEnd(runs, r, k);
			// emphasis over nothing but whitespace has no delimiters: `__` would be literal
			if (runs.slice(r, end + 1).every((x) => x.kind === 'text' && x.content.trim() === '')) {
				active.push({ mark: m, close: '', expel: false });
				continue;
			}
			// `*` and `_` are literal between two alphanumerics, so an intraword boundary on
			// either side takes the function form
			const intraword =
				(isAlnum(out[out.length - 1]) && isAlnum(content[0])) ||
				(isAlnum(runs[end].content[runs[end].content.length - 1]) && isAlnum(charAfterSpan(runs, end, k)));
			if (intraword) {
				emit(m.type.name === 'strong' ? '#strong[' : '#emph[');
				active.push({ mark: m, close: ']', expel: false });
				bracketBody = true;
				continue;
			}
			if (run.kind === 'text') {
				const lead = content.match(/^\s+/);
				if (lead && lead[0].length < content.length) {
					emit(lead[0]);
					content = content.slice(lead[0].length);
				}
			}
			emit(d.open);
			active.push({ mark: m, close: d.close, expel: true });
			bracketBody = false;
		}
		// a `[` body starts fresh markup, where a marker binds like at a line start
		if (bracketBody && run.kind === 'text') content = escLineStart(content);
		emit(content, run.kind === 'text');
		if (run.kind === 'other' && /^https?:\/\/\S+$/.test(content)) urlEnd = out.length;
		if (run.kind === 'other' && content.startsWith('#')) {
			codeEnd = out.length;
			code = content;
		}
		if (run.kind === 'ref') {
			refAt = out.length - content.length;
			refTarget = content.slice(1);
		}
		if (run.kind === 'comment') lineEnd = true;
	}
	if (lineEnd && active.some((a) => a.close)) emit('\n');
	emitCloses([...active].reverse(), !lineEnd);
	return out;
}
