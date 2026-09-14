// markdown inline serialization: marks, runs and emphasis delimiters
import type { Node, Mark } from 'prosemirror-model';
import { escMd, codeSpan, formatLinkDest, formatLinkTitle, formatImage } from './inlineSyntax';

type MarkDelims = {
	open: string;
	close: string;
	expel?: boolean;
};

function markDelims(mark: Mark, inTableCell: boolean): MarkDelims | null {
	const a = mark.attrs;
	switch (mark.type.name) {
		case 'link': {
			const title = formatLinkTitle(a.title == null ? '' : String(a.title), inTableCell);
			return { open: '[', close: `](${formatLinkDest(String(a.href ?? ''), inTableCell)}${title})` };
		}
		case 'strong':
			return { open: '**', close: '**', expel: true };
		case 'em':
			return { open: '*', close: '*', expel: true };
		case 's':
			return { open: '~~', close: '~~', expel: true };
		case 'u':
			return { open: '<u>', close: '</u>' };
		case 'sup':
			return { open: '<sup>', close: '</sup>' };
		case 'sub':
			return { open: '<sub>', close: '</sub>' };
		case 'textcolor':
			return { open: `<span style="color: ${String(a.color ?? 'black')}">`, close: '</span>' };
		case 'highlight':
			return { open: '<mark>', close: '</mark>' };
		default:
			return null;
	}
}

const MARK_ORDER = ['link', 'strong', 'em', 's', 'u', 'sup', 'sub', 'textcolor', 'highlight'];

function orderedMarks(marks: readonly Mark[]): Mark[] {
	return marks
		.filter((m) => m.type.name !== 'code')
		.sort((a, b) => {
			const ia = MARK_ORDER.indexOf(a.type.name);
			const ib = MARK_ORDER.indexOf(b.type.name);
			return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
		});
}

function alignMarks(active: Mark[], marks: Mark[]): Mark[] {
	const kept: Mark[] = [];
	for (const m of active) {
		if (!marks.some((x) => x.eq(m))) break;
		kept.push(m);
	}
	return [...kept, ...marks.filter((m) => !kept.some((k) => k.eq(m)))];
}

type InlineRun = {
	content: string;
	marks: Mark[];
	isText: boolean;
};

type InlineOptions = {
	startOfLine?: boolean;
	inTableCell?: boolean;
	singleLine?: boolean;
};

const HARD_BREAK = '\\\n';

function cellSafe(s: string): string {
	return s.replace(/\n/g, ' ').replace(/\|/g, '\\|');
}

function bareLinkRun(node: Node): string | null {
	const link = node.marks.find((m) => m.type.name === 'link');
	if (!link?.attrs?.bare || link.attrs.title) return null;
	const href = String(link.attrs.href ?? '');
	return node.isText && node.text === href && !/[\s<>]/.test(href) ? `<${href}>` : null;
}

function inlineMath(node: Node, inTableCell: boolean): string {
	const tex = node.textContent
		.trim()
		.replace(/\n{2,}/g, '\n')
		.replace(/(^|[^\\])\$/g, '$1\\$');
	if (!tex) return '';
	return inTableCell ? cellSafe(`$${tex}$`) : `$${tex}$`;
}

export function imageMarkdown(node: Node, inTableCell = false): string {
	let caption = '';
	node.forEach((c) => (caption += c.type.name === 'hard_break' ? ' ' : c.isText ? (c.text ?? '') : c.textContent));
	return formatImage(String(node.attrs.alt ?? ''), String(node.attrs.src ?? ''), caption.replace(/\s+/g, ' ').trim(), inTableCell);
}

function buildRuns(parent: Node, opts: InlineOptions): InlineRun[] {
	const inTableCell = opts.inTableCell ?? false;
	const singleLine = opts.singleLine ?? false;
	const runs: InlineRun[] = [];
	let atLineStart = opts.startOfLine ?? false;
	parent.forEach((node) => {
		if (node.isText) {
			const text = node.text ?? '';
			const bare = bareLinkRun(node);
			if (bare != null) {
				runs.push({ content: bare, marks: [], isText: false });
			} else if (node.marks.some((m) => m.type.name === 'code')) {
				runs.push({ content: codeSpan(text, inTableCell), marks: orderedMarks(node.marks), isText: false });
			} else {
				runs.push({ content: escMd(text, atLineStart, inTableCell), marks: orderedMarks(node.marks), isText: true });
			}
			atLineStart = false;
			return;
		}
		switch (node.type.name) {
			case 'hard_break':
				if (node.attrs?.lineBreak === false) return;
				{
					const br = singleLine || inTableCell || node.attrs?.command === 'br';
					runs.push({ content: br ? '<br>' : HARD_BREAK, marks: [], isText: false });
					atLineStart = !br;
				}
				return;
			case 'inline_math':
				runs.push({ content: inlineMath(node, inTableCell), marks: orderedMarks(node.marks), isText: false });
				break;
			case 'inline_latex':
				runs.push({ content: inTableCell ? cellSafe(node.textContent) : node.textContent, marks: orderedMarks(node.marks), isText: false });
				break;
			case 'citation':
				runs.push({ content: node.textContent ? `[@${node.textContent}]` : '', marks: [], isText: false });
				break;
			case 'ref':
				runs.push({ content: node.textContent, marks: [], isText: false });
				break;
			case 'image':
				runs.push({ content: imageMarkdown(node, inTableCell), marks: [], isText: false });
				break;
			default:
				runs.push({ content: node.isLeaf ? '' : renderInline(node, { inTableCell }), marks: orderedMarks(node.marks), isText: false });
		}
		atLineStart = false;
	});
	const kept = runs.filter((r) => r.content !== '').map((r) => (singleLine ? { ...r, content: r.content.replace(/\n/g, ' ') } : r));
	while (kept.length > 0 && kept[kept.length - 1].content === HARD_BREAK) kept.pop();
	return kept;
}

const WORD_CHAR = /[\p{L}\p{N}]/u;
const PUNCT = /[\p{P}\p{S}]/u;
const PUNCT_TAIL = /(?:\\?[\p{P}\p{S}])+$/u;
const PUNCT_HEAD = /^(?:\\?[\p{P}\p{S}])+/u;

function dropUnwritableEmphasis(runs: InlineRun[], inTableCell: boolean): InlineRun[] {
	const out = runs.map((r) => ({ ...r, marks: [...r.marks] }));
	function loose(c: string) {
		return c === '' || /\s/.test(c) || PUNCT.test(c);
	}
	for (let i = 0; i < out.length; i++) {
		for (const m of out[i].marks) {
			if (!markDelims(m, inTableCell)?.expel || (i > 0 && out[i - 1].marks.some((x) => x.eq(m)))) continue;
			let j = i;
			while (j + 1 < out.length && out[j + 1].marks.some((x) => x.eq(m))) j++;
			const text = out
				.slice(i, j + 1)
				.map((r) => r.content)
				.join('');
			if (WORD_CHAR.test(text)) continue;
			const first = text.charAt(0);
			const last = text.charAt(text.length - 1);
			const before = i > 0 ? out[i - 1].content.slice(-1) : '';
			const after = j + 1 < out.length ? out[j + 1].content.charAt(0) : '';
			const opens = first !== '' && !/\s/.test(first) && (!PUNCT.test(first) || loose(before));
			const closes = last !== '' && !/\s/.test(last) && (!PUNCT.test(last) || loose(after));
			if (opens && closes) continue;
			for (let k = i; k <= j; k++) out[k].marks = out[k].marks.filter((x) => !x.eq(m));
		}
	}
	return out;
}

export function renderInline(parent: Node, opts: InlineOptions = {}): string {
	const inTableCell = opts.inTableCell ?? false;
	const runs = dropUnwritableEmphasis(buildRuns(parent, opts), inTableCell);
	let out = '';
	let active: Mark[] = [];
	let textStart = -1;

	function expels(marks: Mark[]): boolean {
		return marks.some((m) => markDelims(m, inTableCell)?.expel);
	}

	function emitCloses(closing: Mark[], next: string) {
		let stolen = '';
		while (expels(closing)) {
			const ws = out.match(/\s+$/);
			if (ws && ws[0].length < out.length) {
				out = out.slice(0, -ws[0].length);
				stolen = ws[0] + stolen;
				continue;
			}
			const tail = textStart >= 0 && WORD_CHAR.test((stolen || next).charAt(0)) ? out.slice(textStart).match(PUNCT_TAIL) : null;
			if (tail && tail[0].length < out.length - textStart) {
				out = out.slice(0, -tail[0].length);
				stolen = tail[0] + stolen;
				continue;
			}
			break;
		}
		for (const m of closing) {
			const d = markDelims(m, inTableCell);
			if (d) out += d.close;
		}
		out += stolen;
	}

	let dropped: Mark[] = [];
	for (const run of runs) {
		dropped = dropped.filter((m) => run.marks.some((x) => x.eq(m)));
		let marks = alignMarks(
			active,
			run.marks.filter((m) => !dropped.some((x) => x.eq(m)))
		);
		let keep = 0;
		while (keep < active.length && keep < marks.length && active[keep].eq(marks[keep])) keep++;
		const closing = active.slice(keep).reverse();
		let content = run.content;
		const opensEmphasis = marks.slice(keep).filter((m) => markDelims(m, inTableCell)?.expel);
		const intraword = expels(closing) && WORD_CHAR.test(out.charAt(out.length - 1)) && WORD_CHAR.test(content.charAt(0));
		if (opensEmphasis.length && ((run.isText && !content.trim()) || intraword)) {
			if (intraword) dropped.push(...opensEmphasis);
			marks = marks.filter((m, i) => i < keep || !opensEmphasis.includes(m));
		}
		emitCloses(closing, content);
		const opening = marks.slice(keep);
		while (run.isText && expels(opening)) {
			const lead = content.match(/^\s+/);
			if (lead && lead[0].length < content.length) {
				out += lead[0];
				content = content.slice(lead[0].length);
				continue;
			}
			const head = WORD_CHAR.test(out.charAt(out.length - 1)) ? content.match(PUNCT_HEAD) : null;
			if (head && head[0].length < content.length) {
				out += head[0];
				content = content.slice(head[0].length);
				continue;
			}
			break;
		}
		for (const m of opening) {
			const d = markDelims(m, inTableCell);
			if (m.type.name === 'link' && /(^|[^\\])(\\\\)*!$/.test(out)) out = out.slice(0, -1) + '\\!';
			if (d) out += d.open;
		}
		textStart = run.isText ? out.length : -1;
		out += content;
		active = marks;
	}
	emitCloses([...active].reverse(), '');
	return out;
}
