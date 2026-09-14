// Deterministic ProseMirror -> Typst serializer: third sibling of latexSerializer and the
// markdown serializer. String-returning handlers per node type over the shared Ctx contract;
// doc assembly (verbatim orig substitution + per-block memo) delegated to blockAssembly.
// Convention: every block handler ends with '\n\n'; the gap a block actually gets is decided
// by blockGap from the NEXT block's typGap, in renderBlocks for nested blocks and through the
// assembly's boundary hook at the top level.
import type { Node } from 'prosemirror-model';
import { createBlockAssembly, type DocSerializeResult } from '$lib/serializer/blockAssembly';
import type { Ctx } from '$lib/serializer/types';
import { escTypst, renderInline, mathTypstOf, typStr } from './typstInline';
import { tableBody } from './tableSerializer';
export { escTypst, renderInline } from './typstInline';

function indentAfterFirstLine(text: string, indent: string): string {
	return text
		.split('\n')
		.map((l, i) => (i === 0 || l === '' ? l : indent + l))
		.join('\n');
}

// blocks that begin with a line-start token: anything may precede them on the previous line
const LINE_START_BLOCKS = new Set(['list', 'heading', 'code_block', 'term_item', 'includedoc']);
// blocks whose last line ends them: anything may follow on the next line
const LINE_END_BLOCKS = new Set(['heading', 'list', 'code_block', 'term_item', 'includedoc']);

/** a declaration island ends at its line end; a lone call does not */
function declarationRaw(node: Node): boolean {
	return /^#(set|let|show|import|include)\b/.test(node.textContent);
}

/** may `next` follow `prev` after a single line end without merging into it on reparse? a
 *  comment island counts only as prev: after a paragraph it would join that paragraph */
function glueSafe(prev: Node, next: Node): boolean {
	if (LINE_START_BLOCKS.has(next.type.name) || LINE_END_BLOCKS.has(prev.type.name)) return true;
	if (next.type.name === 'raw_latex' && declarationRaw(next)) return true;
	return prev.type.name === 'raw_latex' && (declarationRaw(prev) || /^\/[/*]/.test(prev.textContent));
}

/**
 * The separator to write between two adjacent blocks. `contiguous` says the pair is still the
 * source pair (a single newline recorded on `next` is only trusted then); editor-created blocks
 * carry no record and get the natural typst form: tight lists, a blank line elsewhere.
 */
function blockGap(prev: Node, next: Node, contiguous: boolean, nested: boolean): string {
	const gap = next.attrs.typGap;
	if (gap === 'blank') return '\n\n';
	if (gap === 'newline' && contiguous && glueSafe(prev, next)) return '\n';
	if (prev.type.name === 'list' && next.type.name === 'list' && prev.attrs.kind === next.attrs.kind) return '\n';
	if (prev.type.name === 'term_item' && next.type.name === 'term_item') return '\n';
	if (nested && prev.type.name === 'paragraph' && next.type.name === 'list') return '\n';
	return '\n\n';
}

/** children from index `from` on, serialized and joined on their gaps, tail trimmed. */
function renderBlocks(parent: Node, from = 0): string {
	let out = '';
	let prev: Node | null = null;
	parent.forEach((child, _offset, i) => {
		if (i < from) return;
		const text = serializeTypNode(child, { parent, index: i, isLastChild: i === parent.childCount - 1, inTableCell: false }).replace(
			/\n+$/,
			''
		);
		if (!text) return;
		if (prev) out += blockGap(prev, child, true, true);
		out += text;
		prev = child;
	});
	return out;
}

function isEmptyParagraph(node: Node): boolean {
	if (node.type.name !== 'paragraph') return false;
	let empty = true;
	node.forEach((c) => {
		if (c.isText ? c.text?.trim() : c.type.name !== 'hard_break') empty = false;
	});
	return empty;
}

type NodeHandler = (node: Node, ctx: Ctx) => string;

const NODES: Record<string, NodeHandler> = {
	paragraph(node) {
		if (isEmptyParagraph(node)) return ''; // blank lines are semantic no-ops, as in both siblings
		return renderInline(node, true) + '\n\n';
	},

	heading(node) {
		const level = Math.min(6, Math.max(1, Number(node.attrs.level ?? 1)));
		const label = node.attrs.label ? ` <${String(node.attrs.label)}>` : '';
		if (node.attrs.numbered === false) return `#heading(level: ${level}, numbering: none)[${renderInline(node, false)}]${label}\n\n`;
		const inner = renderInline(node, false, '', true);
		// an empty heading is still a heading (it steps the counter); `=` alone is one
		return `${'='.repeat(level)}${inner ? ' ' + inner : ''}${label}\n\n`;
	},

	code_block(node) {
		const infoString = String(node.attrs.args ?? '').trim();
		const content = node.textContent;
		const runs = content.match(/`{3,}/g);
		const fence = '`'.repeat(runs ? Math.max(3, ...runs.map((r) => r.length)) + 1 : 3);
		return `${fence}${infoString}\n${content}\n${fence}\n\n`;
	},

	// raw source islands (code mode, math, terms, comments): verbatim
	raw_latex: (node) => (node.textContent ? node.textContent + '\n\n' : ''),

	includedoc: (node) => `#include ${typStr(String(node.attrs.path ?? ''))}\n\n`,

	image(node) {
		// `options` is the verbatim extra-args slice (width: 70%, fit: "cover", ...); re-emitted
		// untouched so a resize/crop written in source survives the visual editor
		const rawOpts = typeof node.attrs.options === 'string' ? node.attrs.options.trim() : '';
		let optsStr = rawOpts;
		// a drag-resize leaves snapped pixel width/maxWidth attrs (never set by the converter);
		// translate them to a percent of the text column, replacing any width: already carried.
		// wysiwym by design - the editor column stands in for the page width
		const w = Number(node.attrs.width);
		const max = Number(node.attrs.maxWidth);
		if (Number.isFinite(w) && Number.isFinite(max) && w > 0 && max > 0) {
			const pct = Math.min(100, Math.max(1, Math.round((w / max) * 100)));
			const rest = rawOpts
				.split(',')
				.map((s) => s.trim())
				.filter((s) => s && !/^width:/.test(s));
			optsStr = [`width: ${pct}%`, ...rest].join(', ');
		}
		const opts = optsStr ? `, ${optsStr}` : '';
		const img = `image(${typStr(String(node.attrs.src ?? ''))}${opts})`;
		const caption = node.attrs.showCaption !== false ? renderInline(node, true).trim() : '';
		const label = node.attrs.label ? ` <${String(node.attrs.label)}>` : '';
		// a bare #image is one the source never wrapped in a figure; keep it bare
		if (node.attrs.numbered === false && !caption && !label) return `#${img}\n\n`;
		return `#figure(${img}${caption ? `, caption: [${caption}]` : ''})${label}\n\n`;
	},

	table(node) {
		const body = tableBody(node, '', renderBlocks);
		return body ? `#${body}\n\n` : '';
	},

	// #figure(table(...), caption: [...]) <label> — the typst way to caption a table
	table_wrapper(node) {
		let table: Node | null = null;
		let captionNode: Node | null = null;
		node.forEach((c) => {
			if (c.type.name === 'table') table = c;
			else if (c.type.name === 'table_caption') captionNode = c;
		});
		if (!table) return '';
		const body = tableBody(table, '  ', renderBlocks);
		if (!body) return '';
		const cap = captionNode as Node | null;
		const caption = cap && cap.childCount > 0 ? renderInline(cap, true).trim() : '';
		const label = node.attrs.label ? ` <${String(node.attrs.label)}>` : '';
		return `#figure(\n  ${body}${caption ? `,\n  caption: [${caption}]` : ''},\n)${label}\n\n`;
	},

	block_math(node) {
		const inner = mathTypstOf(node).trim();
		if (!inner) return '';
		// the label rides after the closing dollar, where typst attaches it to the equation
		const label = node.attrs.label ? ` <${String(node.attrs.label)}>` : '';
		return `$ ${inner} $${label}\n\n`;
	},

	blockquote(node) {
		const inner = renderBlocks(node);
		if (!inner) return '';
		return `#quote(block: true)[\n  ${indentAfterFirstLine(inner, '  ')}\n]\n\n`;
	},

	horizontal_rule() {
		return '#line(length: 100%)\n\n';
	},

	term_item(node) {
		const title = node.childCount > 0 && node.child(0).type.name === 'term_title' ? node.child(0) : null;
		const desc = renderBlocks(node, title ? 1 : 0);
		// the first unescaped colon ends the term, so one in the title is escaped
		return `/ ${title ? renderInline(title, false, ':', true) : ''}: ${indentAfterFirstLine(desc, '  ')}\n\n`;
	},

	list(node) {
		const kind = String(node.attrs.kind ?? 'bullet');
		// the explicit "5." the source wrote comes back as written; otherwise '+' auto-numbers
		// and only a run starting off the natural count needs its marker (order is 1 on every
		// non-first node of a run, by the importer's contract)
		const order = Number(node.attrs.order ?? 1);
		const explicit = typeof node.attrs.typNumber === 'number' ? node.attrs.typNumber : null;
		const marker = kind === 'ordered' ? (explicit != null ? `${explicit}. ` : order !== 1 ? `${order}. ` : '+ ') : '- ';
		// continuation lines must sit past the marker to stay inside the item
		const body = indentAfterFirstLine(renderBlocks(node) || '', ' '.repeat(marker.length));
		return marker + body + '\n\n';
	}
};

/** Serialize one node to Typst. Unknown types preserve their content rather than dropping it. */
export function serializeTypNode(node: Node, ctx: Ctx): string {
	const handler = NODES[node.type.name];
	if (handler) return handler(node, ctx);
	if (node.isText) return escTypst(node.text ?? '');
	if (node.isInline) {
		// inline strays (should have come through renderInline) degrade to leafText/plain text
		const leafText = node.type.spec.leafText;
		return leafText ? leafText(node) : node.textContent;
	}
	const inner = renderBlocks(node);
	return inner ? inner + '\n\n' : '';
}

const assembly = createBlockAssembly((node, ctx) => serializeTypNode(node, ctx), {
	boundary: (prev, next, contiguous) => blockGap(prev, next, contiguous, false)
});

export function serializeToTypst(doc: Node): string {
	return serializeToTypstDetailed(doc).text;
}

export function serializeToTypstDetailed(doc: Node): DocSerializeResult {
	const result = assembly.serializeDocChildrenDetailed(doc);
	// a CRLF file stays CRLF: verbatim slices already are, regenerated text is not
	const file = doc.attrs.typFile as { eol?: string } | null;
	return file?.eol === '\r\n' ? { ...result, text: result.text.replace(/\r?\n/g, '\r\n') } : result;
}
