// text escaping and inline-mark wrapping for the LaTeX serializer
import type { Node, Mark } from 'prosemirror-model';

const ESCAPE_RE = /[\\{}#%&$_^]/g;
const ESCAPE_MAP: Record<string, string> = {
	'\\': '\\textbackslash{}',
	'{': '\\{',
	'}': '\\}',
	'#': '\\#',
	'%': '\\%',
	'&': '\\&',
	$: '\\$',
	_: '\\_',
	'^': '\\textasciicircum{}'
};

/** text-mode escaping, single pass (runs per text node on every serialization). */
export function sanitizeText(text: string): string {
	return text.replace(ESCAPE_RE, (ch) => ESCAPE_MAP[ch]);
}

export function joinInline(pieces: string[]): string {
	let out = '';
	for (const piece of pieces) {
		// if the previous chunk ends in a control word and this one starts with a letter, direct
		// concatenation FUSES them into an undefined command (\answerYes + See = \answerYesSee;
		// happens when a separating construct didn't survive conversion). a single space restores
		// the boundary and is render-neutral: TeX eats whitespace after a control word. purely
		// lexical, runs on serialized output where no AST exists. only the tail needs testing (an
		// end-anchored regex on the whole accumulator is quadratic across pieces); 256 chars is
		// far past any real control-word length.
		if (piece && /\\[a-zA-Z@]+$/.test(out.slice(-256)) && /^[a-zA-Z]/.test(piece)) out += ' ';
		// A comment owns a WHOLE line, both ends: emitted mid-line it would swallow the rest of the
		// line, and it arrived from source on its own line (a raw '%' can only open a comment chip;
		// escaped text starts with \%). With serializeNode closing the line after the chip, comment
		// chips are a round-trip fixed point instead of degrading into strippable trailing comments.
		if (piece.startsWith('%') && out && !out.endsWith('\n')) out += '\n';
		out += piece;
	}
	return out;
}

export type EscMode = 'text' | 'href' | 'math' | 'verbatim' | 'raw';

/** The single escaper. Only `text` mutates; href/math/verbatim/raw pass through. */
export function esc(value: string, mode: EscMode = 'text'): string {
	return mode === 'text' ? sanitizeText(value) : value;
}

// em is \textit unless the file said \emph; highlight is soul's \hl. href is NOT escaped.
const MARKS: Record<string, (attrs: Record<string, unknown>) => { open: string; close: string }> = {
	strong: () => ({ open: '\\textbf{', close: '}' }),
	em: (a) => (a.cmd === 'emph' ? { open: '\\emph{', close: '}' } : { open: '\\textit{', close: '}' }),
	u: () => ({ open: '\\underline{', close: '}' }),
	sup: () => ({ open: '\\textsuperscript{', close: '}' }),
	sub: () => ({ open: '\\textsubscript{', close: '}' }),
	code: () => ({ open: '\\texttt{', close: '}' }),
	link: (a) => ({ open: `\\href{${String(a.href ?? '')}}{`, close: '}' }),
	textcolor: (a) => ({
		open: `\\textcolor${typeof a.model === 'string' && a.model ? `[${a.model}]` : ''}{${esc(String(a.color ?? 'black'))}}{`,
		close: '}'
	}),
	highlight: (a) => (a.color == null ? { open: '\\hl{', close: '}' } : { open: `{\\sethlcolor{${esc(String(a.color))}}\\hl{`, close: '}}' })
};

/**
 * a bare \url{href} parses to a link whose text IS the href; if unedited, round-trip \url back
 * instead of widening to \href{href}{href} (a visible styling change under most hyperref setups).
 * compares against the esc()'d href: `text` is already text-escaped, but \url's own argument must
 * stay RAW. Returns the call, or null when the text no longer says the href
 */
export type BareUrl = (text: string, href: string) => string | null;

const plainBareUrl: BareUrl = (text, href) => (text === esc(href, 'text') ? `\\url{${href}}` : null);

let bareUrl: BareUrl = plainBareUrl;

/** the source map's shadow run stands in for the text; it decides the same way on what the text stood for */
export function setBareUrl(fn: BareUrl | null): void {
	bareUrl = fn ?? plainBareUrl;
}

/** Wrap `result` in each mark's open/close pair, inner to outer. shared with non-text leaves
 * that carry marks (an unknown macro chip under \textbf has no text node to carry the bold). */
export function applyMarks(text: string, marks: readonly Mark[]): string {
	let result = text;
	for (const mark of marks) {
		if (mark.type.name === 'link' && mark.attrs?.bare) {
			const url = bareUrl(result, String(mark.attrs.href ?? ''));
			if (url !== null) {
				result = url;
				continue;
			}
		}
		const make = MARKS[mark.type.name];
		if (!make) continue;
		const { open, close } = make(mark.attrs ?? {});
		result = open + result + close;
	}
	return result;
}

/** The marks a node's own handler wraps around it (text, and leaf atoms borrowing a mark);
 * null for anything else, which renderChildren's run-merge leaves untouched. */
export function markableMarks(node: Node): readonly Mark[] | null {
	return node.isText || node.type.spec.leafText ? node.marks : null;
}

/** Order-sensitive on purpose: same set in a different order must NOT merge
 * (\textbf{\texttt{X}} vs \texttt{\textbf{X}} are different commands), so require exact match. */
export function marksKey(marks: readonly Mark[]): string {
	return marks.map((m) => `${m.type.name}:${JSON.stringify(m.attrs)}`).join('|');
}
