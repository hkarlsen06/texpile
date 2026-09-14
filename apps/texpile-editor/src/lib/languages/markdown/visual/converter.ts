// Markdown (markdown-it tokens) -> ProseMirror, targeting the SAME schema as the LaTeX
// importer. Max-fidelity contract mirrors languages/latex/parser/converter.ts: every construct the walker
// understands becomes a rich node; anything else survives as a raw block/chip sliced verbatim
// from the source, so an unknown token type can never crash a file open or lose bytes.
//
// Verbatim capture is far simpler than the LaTeX side: block tokens carry map = [startLine,
// endLineExclusive), so orig slices come straight off a line-offset table. One markdown list of
// N items becomes N flat-list nodes sharing one group (same model as itemize), so substitution
// stays all-or-nothing and an item edit regenerates the whole list.
import type { Token } from 'markdown-it';
import { buildNode, textNodes, collapseTextNodes, type PmNode, type PmMark, realMarks } from './builders';
import { type Cap, buildLineStarts, offsetOfLine, sliceEnd, trimBlankTail, constructEnd } from './sourceSlices';
import { attrStr, dest, imageMarkdown, imageBlock } from './tokenAttrs';
import { formatLinkDest, formatLinkTitle } from './inlineSyntax';
import { createMarkdownEngine } from '../engine';

function withMarks(node: PmNode, marks: PmMark[]): PmNode {
	return marks.length > 0 ? node.mark(realMarks(marks)) : node;
}

/** attrGet returns string | number | null; normalize to a string ('' when absent). */
const MARK_TOKENS: Record<string, string> = {
	strong: 'strong',
	em: 'em',
	s: 's'
};

function convertInline(children: Token[], marks: PmMark[]): PmNode[] {
	const out: PmNode[] = [];
	for (let i = 0; i < children.length; i++) {
		const tok = children[i];
		const open = tok.type.endsWith('_open') ? tok.type.slice(0, -5) : null;
		const close = tok.type.endsWith('_close') ? tok.type.slice(0, -6) : null;
		if (open && (MARK_TOKENS[open] || open === 'link')) {
			const end = constructEnd(children, i);
			if (open === 'link' && end === i + 1) {
				// `[](u)`: a mark needs text to sit on, so an empty link stays a literal chip
				const literal = `[](${formatLinkDest(dest(tok, 'href'))}${formatLinkTitle(attrStr(tok, 'title'))})`;
				out.push(withMarks(buildNode('inline_latex', { lang: 'markdown' }, textNodes(literal)), marks));
				i = end;
				continue;
			}
			const mark: PmMark =
				open === 'link'
					? {
							type: 'link',
							attrs: {
								href: dest(tok, 'href'),
								title: attrStr(tok, 'title') || null,
								bare: tok.markup === 'autolink'
							}
						}
					: { type: MARK_TOKENS[open] };
			out.push(...convertInline(children.slice(i + 1, end), [...marks, mark]));
			i = end;
			continue;
		}
		if (close) continue; // balanced by the recursion above; stray closes are noise

		switch (tok.type) {
			case 'text':
				out.push(...textNodes(tok.content, marks));
				break;
			case 'softbreak':
				out.push(...textNodes(' ', marks)); // a source line-wrap is semantically a space
				break;
			case 'hardbreak':
				out.push(buildNode('hard_break', { lineBreak: true }));
				break;
			case 'code_inline':
				out.push(...textNodes(tok.content, [...marks, { type: 'code' }]));
				break;
			case 'math_inline':
				out.push(withMarks(buildNode('inline_math', null, textNodes(tok.content)), marks));
				break;
			case 'html_inline':
				if (/^<br\s*\/?>$/i.test(tok.content)) {
					out.push(buildNode('hard_break', { lineBreak: true, command: 'br' }));
					break;
				}
				// chip per tag (not per element): the prose between <span> and </span> stays
				// editable text instead of getting swallowed into one opaque chip
				out.push(withMarks(buildNode('inline_latex', { lang: 'html' }, textNodes(tok.content)), marks));
				break;
			case 'image':
				// image mixed into a text line: no block figure can sit here, keep it literal
				out.push(withMarks(buildNode('inline_latex', { lang: 'markdown' }, textNodes(imageMarkdown(tok))), marks));
				break;
			default:
				// unknown inline token: keep its content as a literal chip rather than dropping it
				if (tok.content) out.push(withMarks(buildNode('inline_latex', { lang: 'markdown' }, textNodes(tok.content)), marks));
		}
	}
	return collapseTextNodes(out);
}

function paragraphContent(inline: Token | undefined): PmNode[] {
	return inline?.children ? convertInline(inline.children, []) : [];
}

/** GFM task marker on the item's first paragraph: strip it and lift into kind/checked attrs.
 *  `raw` is that paragraph's source, so an escaped `\[x\]` is not a box. */
function detectTask(blocks: PmNode[], raw: string): { blocks: PmNode[]; checked: boolean | null } {
	const first = blocks[0];
	if (!/^\[[ xX]\][ \t]/.test(raw) || !first || first.type.name !== 'paragraph' || first.childCount === 0) return { blocks, checked: null };
	const lead = first.child(0);
	if (!lead.isText || !lead.text) return { blocks, checked: null };
	const m = /^\[([ xX])\][ \t]/.exec(lead.text);
	if (!m) return { blocks, checked: null };
	const rest = lead.text.slice(m[0].length);
	const kids: PmNode[] = [];
	if (rest) kids.push(lead.type.schema.text(rest, lead.marks));
	for (let i = 1; i < first.childCount; i++) kids.push(first.child(i));
	const para = buildNode('paragraph', { ...first.attrs }, kids);
	return { blocks: [para, ...blocks.slice(1)], checked: m[1] !== ' ' };
}

/** markdown-it hides the paragraphs of a tight list's items; a visible one means blank lines */
function isLoose(tokens: Token[], i: number, j: number): boolean {
	const level = tokens[i].level + 2;
	for (let k = i + 1; k < j; k++) if (tokens[k].type === 'paragraph_open' && tokens[k].level === level && !tokens[k].hidden) return true;
	return false;
}

function listItems(tokens: Token[], i: number, j: number): PmNode[] {
	const open = tokens[i];
	const kind = open.type === 'ordered_list_open' ? 'ordered' : 'bullet';
	const start = kind === 'ordered' ? Number(open.attrGet('start') ?? 1) : null;
	// the delimiter as written: `-` `*` `+`, or `.` `)`; what tells two adjacent lists apart
	const marker = open.markup || null;
	const loose = isLoose(tokens, i, j);
	const items: PmNode[] = [];
	let k = i + 1;
	while (k < j) {
		if (tokens[k].type !== 'list_item_open') {
			k++;
			continue;
		}
		const e = constructEnd(tokens, k);
		const inner = convertTokens(tokens, k + 1, e);
		const raw = tokens[k + 1]?.type === 'paragraph_open' && tokens[k + 2]?.type === 'inline' ? tokens[k + 2].content : '';
		const { blocks, checked } = detectTask(inner.length > 0 ? inner : [buildNode('paragraph')], raw);
		items.push(
			buildNode(
				'list',
				{
					kind: checked != null ? 'task' : kind,
					// flat-list only reads `order` on the first node of an ordered run (CSS counter-set)
					order: kind === 'ordered' ? (items.length === 0 ? (start ?? 1) : 1) : null,
					checked,
					collapsed: false,
					preBody: null,
					marker,
					loose
				},
				blocks
			)
		);
		k = e + 1;
	}
	if (items.length === 0)
		items.push(
			buildNode('list', { kind, order: null, checked: null, collapsed: false, preBody: null, marker, loose }, [buildNode('paragraph')])
		);
	return items;
}

function tableNode(tokens: Token[], i: number, j: number): PmNode {
	const rows: PmNode[] = [];
	const aligns: string[] = [];
	let inHead = false;
	let cells: PmNode[] = [];
	for (let k = i + 1; k < j; k++) {
		const tok = tokens[k];
		switch (tok.type) {
			case 'thead_open':
				inHead = true;
				break;
			case 'thead_close':
				inHead = false;
				break;
			case 'tr_open':
				cells = [];
				break;
			case 'tr_close':
				rows.push(buildNode('table_row', { topRules: '' }, cells));
				break;
			case 'th_open':
			case 'td_open': {
				const e = constructEnd(tokens, k);
				const inline = tokens.slice(k + 1, e).find((t) => t.type === 'inline');
				const style = attrStr(tok, 'style');
				if (inHead) {
					const align = style.includes('right') ? '---:' : style.includes('center') ? ':--:' : style.includes('left') ? ':---' : '---';
					aligns.push(align);
				}
				cells.push(buildNode(inHead ? 'table_header' : 'table_cell', null, [buildNode('paragraph', null, paragraphContent(inline))]));
				k = e;
				break;
			}
		}
	}
	// the delimiter row isn't tokenized; rebuild it from cell alignment so regeneration keeps it
	return buildNode('table', { env: null, colspec: aligns.join('|') || null }, rows);
}

function fenceNode(tok: Token): PmNode {
	const infoString = (tok.info ?? '').trim();
	const content = tok.content.replace(/\n$/, '');
	// no infoString string means NO language: highlighting a bare fence as Markdown painted noise over
	// plain text, and the settings chip claimed a language the source never recorded
	return buildNode(
		'code_block',
		{ lang: infoString, env: tok.type === 'fence' ? 'fence' : 'indented', args: infoString },
		textNodes(content)
	);
}

/** one construct starting at tokens[i] (ending at j inclusive) -> block nodes. */
function convertConstruct(tokens: Token[], i: number, j: number, cap: Cap | null): PmNode[] {
	const tok = tokens[i];
	switch (tok.type) {
		case 'paragraph_open': {
			const inline = tokens[i + 1]?.type === 'inline' ? tokens[i + 1] : undefined;
			// a paragraph that IS one image becomes a block figure
			if (inline?.children?.length === 1 && inline.children[0].type === 'image') return [imageBlock(inline.children[0])];
			return [buildNode('paragraph', { indent: 'auto' }, paragraphContent(inline))];
		}
		case 'heading_open': {
			const inline = tokens[i + 1]?.type === 'inline' ? tokens[i + 1] : undefined;
			return [buildNode('heading', { level: Number(tok.tag.slice(1)) || 1, numbered: true }, paragraphContent(inline))];
		}
		case 'blockquote_open':
			return [buildNode('blockquote', null, ensureBlocks(convertTokens(tokens, i + 1, j)))];
		case 'bullet_list_open':
		case 'ordered_list_open':
			return listItems(tokens, i, j);
		case 'table_open':
			return [tableNode(tokens, i, j)];
		case 'fence':
		case 'code_block':
			return [fenceNode(tok)];
		case 'hr':
			return [buildNode('horizontal_rule')];
		case 'html_block':
			return [buildNode('raw_latex', { lang: 'html' }, textNodes(tok.content.replace(/\n$/, '')))];
		case 'math_block':
			return [buildNode('block_math', { label: null, numbered: false, environment: null, lineLabels: [] }, textNodes(tok.content.trim()))];
		// link reference and footnote definitions are invisible to the reader but load-bearing
		// for the file: blocks of their own, verbatim, never a neighbour's gap
		case 'reference_definition':
		case 'footnote_definition':
			return rawBlock(tok, cap);
		default:
			// unknown block construct: preserve its exact source lines as a raw markdown block
			return rawBlock(tok, cap);
	}
}

/** the construct's exact source lines (top level), else the content its rule recorded */
function rawBlock(tok: Token, cap: Cap | null): PmNode[] {
	if (cap && tok.map) {
		const min = offsetOfLine(cap, tok.map[0]);
		const end = trimBlankTail(cap.source, min, sliceEnd(cap, tok.map[1]));
		if (end > min) return [buildNode('raw_latex', { lang: 'markdown' }, textNodes(cap.source.slice(min, end)))];
	}
	return tok.content ? [buildNode('raw_latex', { lang: 'markdown' }, textNodes(tok.content.replace(/\n$/, '')))] : [];
}

function ensureBlocks(blocks: PmNode[]): PmNode[] {
	return blocks.length > 0 ? blocks : [buildNode('paragraph')];
}

/** nested walker (blockquote bodies, list items): no orig stamping below the top level. */
function convertTokens(tokens: Token[], from: number, to: number): PmNode[] {
	const out: PmNode[] = [];
	let i = from;
	while (i < to) {
		const j = constructEnd(tokens, i);
		out.push(...convertConstruct(tokens, i, Math.min(j, to), null));
		i = j + 1;
	}
	return out;
}

/** Recreate `node` with an `orig` attr; types that don't declare it pass through unchanged. */
function withOrig(node: PmNode, orig: Record<string, unknown>): PmNode {
	if (!node.type.spec.attrs || !('orig' in node.type.spec.attrs)) return node;
	return node.type.create({ ...node.attrs, orig }, node.content, node.marks);
}

export type MarkdownParseResult = {
	doc: PmNode;
};

export function markdownToProseMirror(source: string): MarkdownParseResult {
	const md = createMarkdownEngine();
	const tokens = md.parse(source, {}) as Token[];
	const cap: Cap = { source, lineStarts: buildLineStarts(source), seq: 0, prevEnd: 0, group: 0 };

	const result: PmNode[] = [];
	let i = 0;
	while (i < tokens.length) {
		const j = constructEnd(tokens, i);
		const blocks = convertConstruct(tokens, i, j, cap);
		const map = tokens[i].map;
		// stamp-and-push, the LaTeX converter's pushBlocks contract: every block gets a seq;
		// only a trustworthy span gets the slice. multi-block constructs (a list) share it
		// under a group id so substitution is all-or-nothing.
		const min = map ? offsetOfLine(cap, map[0]) : NaN;
		const end = map ? trimBlankTail(source, min, sliceEnd(cap, map[1])) : NaN;
		const spanOk = map != null && Number.isFinite(min) && min >= cap.prevEnd && end <= source.length && min < end;
		const slice = spanOk ? source.slice(min, end) : null;
		const pre = spanOk ? source.slice(cap.prevEnd, min) : null;
		const group = spanOk && blocks.length > 1 ? cap.group++ : null;
		for (let b = 0; b < blocks.length; b++) {
			const seq = cap.seq++;
			if (slice == null) {
				result.push(withOrig(blocks[b], { seq }));
				continue;
			}
			const orig: Record<string, unknown> = { latex: slice, pre: b === 0 ? pre : '', seq, norm: null, start: min };
			if (group != null) {
				orig.group = group;
				orig.groupIndex = b;
				orig.groupSize = blocks.length;
			}
			result.push(withOrig(blocks[b], orig));
		}
		if (spanOk) cap.prevEnd = Math.max(cap.prevEnd, end);
		i = j + 1;
	}

	// trailing bytes past the last block (usually just "\n") belong to no node; stash them on
	// the doc so a pristine save reproduces the file's exact tail. an EMPTY tail is stashed
	// too: it protects a missing final newline from being "fixed" on a no-edit save
	const docAttrs: Record<string, unknown> = {
		docTail: result.length > 0 ? { text: source.slice(cap.prevEnd), afterSeq: cap.seq - 1 } : null,
		// a file that is CRLF throughout gets its regenerated blocks written the same way
		eol: source.includes('\r\n') && !/(^|[^\r])\n/.test(source) ? '\r\n' : null
	};
	return { doc: buildNode('doc', docAttrs, ensureBlocks(result)) };
}
