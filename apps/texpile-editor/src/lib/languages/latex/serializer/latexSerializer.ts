/**
 * Deterministic ProseMirror to LaTeX serializer: each node/mark maps to fixed LaTeX, no rules
 * engine, styling delegated to the verbatim-preserved preamble. leaves reuse the schema's own
 * NodeSpec.leafText; everything else is a handler keyed by node.type.name; marks are open/close
 * pairs.
 */

import type { Node, Mark } from 'prosemirror-model';
import { serializeTable } from './tableSerializer';
import { FIG_IMG_SLOT, FIG_CAP_SLOT, FIG_LAB_SLOT } from '../parser/converter';
import { createBlockAssembly, type DocSerializeResult } from '$lib/serializer/blockAssembly';
import type { Ctx, NodeHandler } from '$lib/serializer/types';
// direct, not through the image barrel: that one pulls in svelte and the DOM
import { DEFAULT_FIGURE_FRACTION } from '$lib/editor/visual/extensions/image/figureDefaults';
import { esc, applyMarks, joinInline, markableMarks, marksKey } from './textEscapes';
import { blockMath, alignEnvironment } from './mathBlocks';
export { esc, sanitizeText, type EscMode } from './textEscapes';

export type { DocSerializeResult } from '$lib/serializer/blockAssembly';

/** A text/leaf node's content WITHOUT its own marks, for runs wrapped once by the caller. */
function serializeBare(node: Node): string {
	if (node.isText) return bareText(node);
	const leafText = node.type.spec.leafText;
	return leafText ? leafText(node) : '';
}

function prevSibling(ctx: Ctx): Node | null {
	return ctx.parent && ctx.index > 0 ? ctx.parent.child(ctx.index - 1) : null;
}

function nextSibling(ctx: Ctx): Node | null {
	return ctx.parent && ctx.index < ctx.parent.childCount - 1 ? ctx.parent.child(ctx.index + 1) : null;
}

/** Serialize a node's children, threading sibling/last-child/table context. */
export function renderChildren(node: Node, inTableCell: boolean): string {
	const children: Node[] = [];
	node.forEach((child) => children.push(child));

	// adjacent inline children with the EXACT same marks serialize as ONE wrapped run. PM auto-
	// merges identical text nodes, but atom leaves never merge, so \texttt{A\ B} parses to three
	// same-marked nodes and would serialize as three separate \texttt{} calls: pointless churn
	// that multiplies per chip.
	const pieces: string[] = [];
	let i = 0;
	while (i < children.length) {
		const marks = markableMarks(children[i]);
		let j = i + 1;
		if (marks && marks.length > 0) {
			const key = marksKey(marks);
			while (j < children.length) {
				const nextMarks = markableMarks(children[j]);
				if (!nextMarks || marksKey(nextMarks) !== key) break;
				j++;
			}
		}
		if (j === i + 1) {
			pieces.push(serializeNode(children[i], { parent: node, index: i, isLastChild: i === children.length - 1, inTableCell }));
		} else {
			let inner = '';
			for (let k = i; k < j; k++) inner += serializeBare(children[k]);
			pieces.push(applyMarks(inner, marks as readonly Mark[]));
		}
		i = j;
	}

	return joinInline(pieces);
}

/**
 * Two lists the source wrote as separate environments stay separate: the verbatim layer emits a
 * pristine neighbour with its own \begin and \end, so coalescing a regenerated one into it left
 * an unbalanced environment. Editor-made list nodes carry no source group and still coalesce.
 */
function sameSourceList(a: Node, b: Node): boolean {
	const ga = (a.attrs.orig as { group?: number | null } | null)?.group;
	const gb = (b.attrs.orig as { group?: number | null } | null)?.group;
	return ga == null || gb == null || ga === gb;
}

/** the environment name the first node of this run of list nodes carries, if any */
function runEnvName(node: Node, ctx: Ctx): string | null {
	if (!ctx.parent) return typeof node.attrs.envName === 'string' ? node.attrs.envName : null;
	const kind = node.attrs.kind;
	for (let i = ctx.index; i >= 0; i--) {
		const n = ctx.parent.child(i);
		if (n.type.name !== 'list' || n.attrs.kind !== kind || (i < ctx.index && !sameSourceList(n, ctx.parent.child(i + 1)))) break;
		if (typeof n.attrs.envName === 'string' && n.attrs.envName) return n.attrs.envName;
	}
	return null;
}

// letters and digits only: the same label written as source and re-serialized from the editor
// differs by ties, dash ligatures and quote curling, so compare what survives all of those
function labelKey(s: string): string {
	return s.replace(/\\[a-zA-Z@]+\s*/g, '').replace(/[^\p{L}\p{N}]/gu, '');
}

/**
 * The label at the head of an item, and the paragraph with it removed.
 *
 * The run is identified by the item_label mark createList puts on it, not by matching text: a
 * label can span several inline nodes (`\item[A $x$ B]`), and prose that merely repeats the
 * label is not the label. `latex` is the run re-serialized, which is what an edited label has
 * to be written back as; the caller prefers the untouched source when the two still agree.
 */
function splitLeadingLabel(item: Node): { latex: string; body: Node } | null {
	if (item.type.name !== 'paragraph') return null;
	// through the LAST marked node, not the first unmarked one: an atom in the middle of a label
	// (`\item[A $x$ B]` puts inline math there) carries no marks of its own
	let last = -1;
	for (let i = 0; i < item.childCount; i++) {
		const child = item.child(i);
		if (child.marks.some((m) => m.type.name === 'item_label')) last = i;
		else if (child.isText) break;
	}
	if (last < 0) return null;
	let size = 0;
	for (let i = 0; i <= last; i++) size += item.child(i).nodeSize;
	// the label's own marks are the wrapper, not content: \item[\textbf{x}] would come back
	// doubly bold otherwise
	const bare = item.type.schema.node(
		'paragraph',
		null,
		item.content.cut(0, size).content.map((n) => n.mark(n.marks.filter((m) => m.type.name !== 'item_label' && m.type.name !== 'strong')))
	);
	let rest = item.content.cut(size);
	const next = rest.firstChild;
	if (next?.isText && next.text && /^\s+$/.test(next.text)) rest = rest.cut(next.nodeSize);
	else if (next?.isText && next.text && /^\s/.test(next.text))
		rest = rest.replaceChild(0, next.type.schema.text(next.text.replace(/^\s+/, ''), next.marks));
	return { latex: renderChildren(bare, false).trim(), body: item.copy(rest) };
}

const HEADING_CMD: Record<number, string> = {
	1: '\\section',
	2: '\\subsection',
	3: '\\subsubsection',
	4: '\\paragraph',
	5: '\\subparagraph'
};

/** Drop width=/scale=/height= entries from an \includegraphics option list (keep trim, clip, angle…). */
function stripSizeKeys(opts: string): string {
	return opts
		.split(',')
		.map((s) => s.trim())
		.filter((s) => s && !/^(width|scale|height|totalheight)\s*=/.test(s))
		.join(', ');
}

/**
 * Rebuild the \includegraphics for an image node.
 * - resized in the editor (width/maxWidth set): emit width=<frac>\textwidth, keeping other
 *   captured options (trim/clip/angle) and replacing the original size keys.
 * - options === '': the source had no brackets, emit \includegraphics{src} verbatim.
 * - options a non-empty string: emit it verbatim.
 * - options == null (editor-created, never resized): the default width.
 */
function buildIncludegraphics(node: Node): string {
	const src = String(node.attrs.src ?? '');
	const options = node.attrs.options as string | null;
	const w = Number(node.attrs.width);
	const mw = Number(node.attrs.maxWidth);
	if (Number.isFinite(w) && Number.isFinite(mw) && mw > 0) {
		const frac = Math.round((w / mw) * 100) / 100; // resize already snaps; this guards stray values
		const rest = stripSizeKeys(typeof options === 'string' ? options : '');
		const opts = [`width=${frac}\\textwidth`, rest].filter(Boolean).join(', ');
		return `\\includegraphics[${opts}]{${src}}`;
	}
	if (options === '') return `\\includegraphics{${src}}`;
	if (typeof options === 'string') return `\\includegraphics[${options}]{${src}}`;
	return `\\includegraphics[width=${DEFAULT_FIGURE_FRACTION}\\textwidth]{${src}}`;
}

type ParagraphOrig = { latex?: unknown; pre?: unknown; seq?: unknown } | null | undefined;

function seqOf(node: Node | null): number | undefined {
	const seq = (node?.attrs.orig as ParagraphOrig)?.seq;
	return typeof seq === 'number' ? seq : undefined;
}

// a \par the source had stays while the same block follows, so typing never rewrites how a paragraph ends
export function dropParagraphEnd(text: string, last: Node | null, nextSeq?: number): string {
	if (last?.type.name !== 'paragraph') return text;
	const orig = last.attrs.orig as ParagraphOrig;
	const kept = typeof orig?.latex === 'string' && /\\par\s*$/.test(orig.latex) && nextSeq !== undefined && seqOf(last) === nextSeq - 1;
	return kept ? text : text.replace(/[ \t]*\\par$/, '');
}

function paragraphGap(prev: Node, next: Node, contiguous: boolean, before: string): string | null {
	const pre = (next.attrs.orig as ParagraphOrig)?.pre;
	return contiguous && prev.type.name === 'paragraph' && typeof pre === 'string' && /\\par\s*$/.test(before.slice(-16)) ? pre : null;
}

function envBody(node: Node): string {
	return dropParagraphEnd(renderChildren(node, false).replace(/^\n+|\n+$/g, ''), node.lastChild) + '\n';
}

// doc assembly (verbatim `orig` substitution + per-block memo) is format-neutral and shared
// with the markdown serializer; serializeNode hoists, so binding it here is safe.
const assembly = createBlockAssembly((node, ctx) => serializeNode(node, ctx), {
	beforeBreak: (text, last, next) => dropParagraphEnd(text, last, seqOf(next)),
	boundary: paragraphGap
});

function serializeDocChildrenDetailed(doc: Node): DocSerializeResult {
	return assembly.serializeDocChildrenDetailed(doc);
}

function serializeDocChildren(doc: Node): string {
	return serializeDocChildrenDetailed(doc).text;
}

/** The text handler's escaping, WITHOUT wrapping in the node's own marks (shared with
 * serializeBare's run merge). */
function bareText(node: Node): string {
	const isCode = node.marks.some((m) => m.type.name === 'code');
	let result = esc(node.text ?? '', 'text');
	// a pasted tab becomes one space: there's no clean tab mapping and a space is idempotent.
	// a bare " stays as-is: \texttt{"} re-parses to a code mark and compounds every save.
	result = result.replace(/\t/g, ' ');
	// Every tie became a no-break space on the way in, so a tilde still here is one someone typed
	// meaning the character - emitted bare it would compile to a tie and vanish from the PDF.
	// MUST run before the no-break space goes back to ~, or it would escape that one too. Code
	// keeps its literal bytes and never had the tie converted, so it is left alone.
	if (!isCode) result = result.replace(/~/g, '\\textasciitilde{}');
	// a no-break space (from a ~ tie) must go back to ~, not a raw U+00A0 byte (renders
	// differently without inputenc, and is unfaithful to the source either way).
	result = result.replace(/\u00A0/g, '~');
	// typographic chars become LaTeX ligatures so the .tex stays ASCII and round-trips; skipped
	// in code, where they are literal.
	if (!isCode) {
		result = result
			.replace(/\u2014/g, '---')
			.replace(/\u2013/g, '--')
			.replace(/\u201C/g, '``')
			.replace(/\u201D/g, "''")
			.replace(/\u2018/g, '`')
			.replace(/\u2019/g, "'")
			// \ldots reads back as U+2026, which had no way home and left a non-ASCII byte behind
			.replace(/\u2026/g, '\\ldots{}');
	}
	return result;
}

const NODES: Record<string, NodeHandler> = {
	doc: (node) => serializeDocChildren(node),

	paragraph(node, ctx) {
		// an empty paragraph emits nothing: blank lines are semantic no-ops (WYSIWYM). a user who
		// wants real space types \vspace/\bigskip, which round-trips as a raw chip.
		if (isEmptyParagraph(node)) return '';
		// a \label on its own line is an anchor, not prose: it has no paragraph to end, so \par
		// here would add a token the source never had, on every save, after every section label
		if (isLabelOnlyParagraph(node) && !ctx.inTableCell) {
			return (prevSibling(ctx)?.type.name === 'heading' ? '' : '\n') + renderChildren(node, false).trim() + '\n';
		}
		const rawContent = renderChildren(node, ctx.inTableCell);
		if (ctx.inTableCell) return rawContent; // no \par inside table cells

		// trim edge whitespace: the parser re-absorbs a space before \par, so it would
		// accumulate one per save.
		const trimmed = rawContent.replace(/^\s+|\s+$/g, '');
		const content = /(^|[^\\])(\\\\)*%[^\n]*$/.test(trimmed) ? trimmed + '\n' : trimmed;
		// first-line indent override (Tab cycles it): 'auto' emits nothing
		const indent = node.attrs.indent === 'indent' ? '\\indent ' : node.attrs.indent === 'noindent' ? '\\noindent ' : '';
		const prev = prevSibling(ctx);
		const next = nextSibling(ctx);
		// a display the source kept inside this paragraph: no \par before it and no blank line
		// after it, or the continuation becomes a new, indented paragraph with space above
		const runsIntoDisplay = next?.type.name === 'block_math' && next.attrs.inParagraph === true;
		const continuesDisplay = prev?.type.name === 'block_math' && prev.attrs.continuesAfter === true;
		const before = prev?.type.name === 'heading' || continuesDisplay ? '' : '\n';
		const after = next?.type.name === 'heading' ? '\n' : '';
		if (runsIntoDisplay) return before + indent + content + '\n';
		return before + indent + content + ' \\par\n' + after;
	},

	heading(node) {
		if (node.childCount === 0) return '';
		const text = renderChildren(node, false);
		// \chapter and \part have no level of their own in the editor; the source command is kept
		const cmd =
			typeof node.attrs.command === 'string' && node.attrs.command
				? `\\${node.attrs.command}`
				: (HEADING_CMD[Number(node.attrs.level ?? 1)] ?? '\\section');
		const star = node.attrs.numbered === false ? '*' : '';
		// a `]` inside the short title would close the optional argument early; bracing the whole
		// argument is how LaTeX carries one
		const shortTitle = typeof node.attrs.shortTitle === 'string' ? node.attrs.shortTitle : '';
		const short = shortTitle ? `[${shortTitle.includes(']') ? `{${shortTitle}}` : shortTitle}]` : '';
		return `${cmd}${star}${short}{${text}}\n`;
	},

	text(node) {
		return applyMarks(bareText(node), node.marks);
	},

	hard_break(node, ctx) {
		// legacy lineBreak:false (a blank-line gap) is a semantic no-op: emit nothing
		if (node.attrs?.lineBreak === false) return '';
		const suffix = typeof node.attrs?.suffix === 'string' ? node.attrs.suffix : '';
		if (node.attrs?.command === 'newline' || (ctx.inTableCell && !suffix)) return '\\newline\n';
		return `\\\\${suffix}\n`;
	},

	block_math(node) {
		const content = node.textContent;
		const numbered = Boolean(node.attrs.numbered ?? false);
		const label = (node.attrs.label as string) || '';
		const environment = (node.attrs.environment as string | null) ?? null;
		const lineLabels = (node.attrs.lineLabels as string[]) ?? [];
		if (environment) {
			return alignEnvironment(content, { environment, lineLabels, label: label || undefined, numbered });
		}
		return blockMath(content, { numbered, label: label || undefined, starredEnv: node.attrs.starredEnv === true });
	},

	// verbatim, no escaping. env/args remember the source environment and options so
	// \begin{lstlisting}[language=Python] round-trips as itself (losing the options silently
	// drops \lstset styling).
	code_block: (node) => {
		const env = String(node.attrs.env ?? 'verbatim');
		const args = String(node.attrs.args ?? '');
		return `\\begin{${env}}${args}\n${node.textContent}\n\\end{${env}}\n\n`;
	},

	blockquote: (node) => {
		const env = node.attrs.env === 'quotation' ? 'quotation' : 'quote';
		return `\\begin{${env}}\n${envBody(node)}\\end{${env}}\n`;
	},

	raw_latex: (node) => node.textContent + '\n',

	// emit the exact include command captured at parse time, path verbatim
	includedoc: (node) => `\\${String(node.attrs.command ?? 'input')}{${String(node.attrs.path ?? '')}}\n`,

	environment: (node) => {
		const name = String(node.attrs.name ?? 'environment');
		const args = String(node.attrs.args ?? ''); // verbatim \begin{name}<args> (e.g. "{0.5\textwidth}")
		return `\\begin{${name}}${args}\n${renderChildren(node, false)}\\end{${name}}\n`;
	},

	// sourceForm remembers which shape the file used. the command form only fits a single-
	// paragraph abstract (its arg is inline); multi-paragraph auto-promotes to the env form.
	abstract: (node) => {
		const sourceForm = String(node.attrs.sourceForm ?? 'env');
		if (sourceForm === 'macro' && node.childCount === 1 && node.firstChild?.type.name === 'paragraph') {
			return `\\abstract{${renderChildren(node.firstChild, false).trimEnd()}}\n`;
		}
		return `\\begin{abstract}\n${envBody(node)}\\end{abstract}\n`;
	},

	horizontal_rule: () => '\\par\\noindent\\rule{\\linewidth}{0.4pt}\n',

	// pre/post notes are NOT text-escaped: they come from getTextContent, which falls back to a
	// macro's raw source (a \eg shorthand pre-note), and escaping would mangle it into
	// \textbackslash{}eg. a 'string' AST node never contains an unescaped special to begin with.
	citation(node) {
		const key = node.textContent;
		const variant = String(node.attrs.variant ?? 'cite');
		const pre = node.attrs.prenote ? String(node.attrs.prenote) : '';
		const post = node.attrs.postnote ? String(node.attrs.postnote) : '';
		const NO_NOTES = new Set(['supercite', 'citeauthor', 'citeyear']); // don't take [pre][post]
		if (NO_NOTES.has(variant) || (!pre && !post)) return `\\${variant}{${key}}`;
		// one bracket is the postnote for natbib, biblatex and plain \cite alike; only a prenote
		// needs the two-bracket form, which plain LaTeX's \cite does not understand
		if (!pre) return `\\${variant}[${post}]{${key}}`;
		return `\\${variant}[${pre}][${post}]{${key}}`;
	},

	// preserve the original reference command so the output matches the user's preamble
	ref: (node) => `\\${String(node.attrs.command ?? 'ref')}{${node.textContent}}`,

	// back exactly where it stood: a \label names whichever counter was last incremented, so its
	// position IS its meaning, and moving it would silently repoint it
	label: (node) => `\\label{${String(node.attrs.name ?? '')}}`,

	image(node) {
		const numbered = node.attrs.numbered !== false;
		const showCaption = node.attrs.showCaption !== false;
		const graphics = buildIncludegraphics(node);
		const capContent = renderChildren(node, false);
		// verbatim short-caption \caption[short]{long}; see the captionOpt attr in schema.ts
		const capOpt = typeof node.attrs.captionOpt === 'string' && node.attrs.captionOpt ? `[${node.attrs.captionOpt}]` : '';
		const caption = showCaption ? `\\caption${numbered ? '' : '*'}${capOpt}{${capContent}}` : '';
		const labelText = numbered && showCaption ? String(node.attrs.label ?? '') : '';
		const label = labelText ? `\\label{${labelText}}` : '';

		// imported figure: substitute the editable bits back into the verbatim float template so
		// all surrounding scaffolding (centerline, vspace, captionsetup, placement) is preserved.
		const template = node.attrs.figureTemplate as string | null;
		if (typeof template === 'string' && template) {
			let out = template.split(FIG_IMG_SLOT).join(graphics).split(FIG_CAP_SLOT).join(caption).split(FIG_LAB_SLOT).join(label);
			// a caption added in the editor to a figure that had none has no slot to fill; drop
			// it in just before \end{figure}.
			if (showCaption && capContent && !template.includes(FIG_CAP_SLOT)) {
				out = out.replace(/(\n?)(\\end\{figure\*?\})\s*$/, `\n${caption}\n$2`);
			}
			return out.replace(/\s*$/, '') + '\n';
		}

		// a \includegraphics that was standalone in the source round-trips bare: synthesizing a
		// \begin{figure} is often a compile error (nested floats), and this image never had a
		// \caption/\label to begin with. see the bareOriginal attr in schema.ts. A caption typed
		// in the editor since needs a float to live in, so that one does get the figure below
		if (node.attrs.bareOriginal && !(showCaption && capContent.trim())) return graphics + '\n';

		// editor-created image: a standard centered figure
		const env = node.attrs.spanning === true ? 'figure*' : 'figure';
		const captionLine = caption ? caption + '\n' : '';
		const labelLine = label ? label + '\n' : '';
		return `\\begin{${env}}[h]\n\\centering\n${graphics}\n${captionLine}${labelLine}\\end{${env}}\n`;
	},

	// prosemirror-flat-list: each `list` node is ONE item; same-kind siblings coalesce.
	list(node, ctx) {
		const kind = String(node.attrs.kind ?? 'bullet');
		const prev = prevSibling(ctx);
		const next = nextSibling(ctx);
		const prevSame = prev?.type.name === 'list' && prev.attrs.kind === kind && sameSourceList(prev, node);
		const nextSame = next?.type.name === 'list' && next.attrs.kind === kind && sameSourceList(node, next);
		// a description environment is remembered on the run's first node; the rest inherit it
		const envName = runEnvName(node, ctx);
		const env = envName ?? (kind === 'ordered' ? 'enumerate' : 'itemize');
		// \item[label]: the editor shows it as leading bold text, so it is taken back out of the
		// body before the bracket is rewritten. The SOURCE label is preferred while the run still
		// says the same thing, since re-serializing turns a tie into a no-break space and a `--`
		// into a dash; once the run says something else, the user edited the label and that wins
		const itemLabel = typeof node.attrs.itemLabel === 'string' ? node.attrs.itemLabel : null;
		const labelled = node.childCount > 0 ? splitLeadingLabel(node.child(0)) : null;
		const sourceHolds = itemLabel != null && labelled != null && labelKey(labelled.latex) === labelKey(itemLabel);
		const label = labelled ? (sourceHolds ? itemLabel : labelled.latex) : itemLabel === '' ? '' : null;
		const itemCmd = label == null ? '\\item' : `\\item[${label}]`;

		const parts: string[] = [];
		node.forEach((item, _offset, i) => {
			const shown = i === 0 && labelled ? labelled.body : item;
			const inner = serializeNode(shown, { parent: node, index: i, isLastChild: i === node.childCount - 1, inTableCell: ctx.inTableCell });
			if (item.type.name === 'list') {
				// only the FIRST of a run of same-kind sub-lists opens \item[]; the rest coalesce
				// into the same nested env (prevSame means no \begin), and another \item[] would
				// re-parse as an extra empty item and double every save.
				const prevChild = i > 0 ? node.child(i - 1) : null;
				const continues = prevChild?.type.name === 'list' && prevChild.attrs.kind === item.attrs.kind;
				parts.push(continues ? `\n${inner}` : `\\item[] ${inner}`);
			} else if (i === 0) {
				const alone = labelled && !inner.trim() && node.childCount > 1 && node.child(1).type.name !== 'list';
				parts.push(alone ? `${itemCmd} \\par` : `${itemCmd} ${inner}`);
			} else parts.push('\n' + inner); // continuation block within the same item
		});

		let out = '';
		if (!prevSame) {
			// enumitem-style options the source gave the environment; see createList
			const envArgs = typeof node.attrs.envArgs === 'string' ? node.attrs.envArgs : '';
			out += `\n\\begin{${env}}${envArgs}\n`;
			// raw setup content that preceded the first \item in the source; see createList
			const preBody = typeof node.attrs.preBody === 'string' ? node.attrs.preBody : '';
			if (preBody) out += preBody + '\n';
		}
		out += parts.join('');
		if (!nextSame) out += `\n\\end{${env}}\n`;
		return out;
	},

	// table family lives in tableSerializer.ts
	table_wrapper: (node) => serializeTable(node, serializeNode),
	table: (node) => serializeTable(node, serializeNode),
	table_caption: (node) => serializeTable(node, serializeNode),
	table_notes: (node) => serializeTable(node, serializeNode),
	table_row: (node) => serializeTable(node, serializeNode),
	table_cell: (node) => serializeTable(node, serializeNode),
	table_header: (node) => serializeTable(node, serializeNode)
};

/** Serialize one node. Leaves use the schema's own leafText; unknowns preserve content. */
export function serializeNode(node: Node, ctx: Ctx): string {
	// leafText atoms (inline_math, inline_latex) CAN carry marks (converter.ts attaches one when
	// an unknown macro sits inside \textbf, since there's no text node inside to carry it), so
	// wrap them the same way `text` does.
	const leafText = node.type.spec.leafText;
	if (leafText && !node.isText) {
		const text = applyMarks(leafText(node), node.marks);
		// A comment chip owns the rest of its line: % consumes to the newline, so one is restored
		// here or the prose after the chip would be commented out. The chip's own text stays
		// single-line for display (a baked-in newline rendered as an empty second chip line).
		if (node.type.name === 'inline_latex' && text.startsWith('%') && !text.endsWith('\n')) return text + '\n';
		return text;
	}

	const handler = NODES[node.type.name];
	if (handler) return handler(node, ctx);

	// unknown node: preserve content rather than dropping it
	return node.isText ? esc(node.text ?? '', 'text') : renderChildren(node, ctx.inTableCell);
}

/**
 * Serialize a ProseMirror doc to a LaTeX body. trimming happens INSIDE
 * serializeDocChildrenDetailed (only at unprotected edges); an outer .trim() here would strip a
 * preserved boundary right back off.
 */
export function serializeToLatex(doc: Node): string {
	return serializeDocChildrenDetailed(doc).text;
}

/**
 * Like serializeToLatex, but also reports whether each edge is a verbatim-preserved original
 * boundary: latexRoundtrip.ts must NOT insert its own separator around a protected edge (the
 * body already carries the exact original bytes), only around a regenerated one.
 */
export function serializeToLatexDetailed(doc: Node): DocSerializeResult {
	return serializeDocChildrenDetailed(doc);
}

/** Nothing but labels (and whitespace) - the paragraph the importer makes for a \label sitting on
 *  its own line under a heading. */
function isLabelOnlyParagraph(node: Node): boolean {
	let sawLabel = false;
	let sawOther = false;
	node.forEach((c) => {
		if (c.type.name === 'label') sawLabel = true;
		else if (c.isText) sawOther ||= (c.text ?? '').trim() !== '';
		else sawOther = true;
	});
	return sawLabel && !sawOther;
}

function isEmptyParagraph(node: Node): boolean {
	if (node.childCount === 0) return true;
	let empty = true;
	node.forEach((c) => {
		if (c.isText) {
			if (c.text && c.text.trim() !== '') empty = false;
		} else if (c.type.name !== 'hard_break') {
			empty = false;
		}
	});
	return empty;
}
