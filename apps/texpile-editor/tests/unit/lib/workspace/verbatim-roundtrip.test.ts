import { describe, it, expect } from 'vitest';
import { Fragment, type Node } from 'prosemirror-model';
import { Transform } from 'prosemirror-transform';
import { schema } from '$lib/languages/latex/schema/latexPMSchema';
import { parseBodyOf, parseLatexFile, serializeLatexFile, serializeLatexFileDetailed } from '../../../../src/lib/workspace/latexRoundtrip';
import { pmToSource, rememberParseMap, withoutOrigins } from '$lib/editor/visual/sourceSpans';
import { padTables } from '$lib/editor/visual/padTables';

// verbatim source preservation: untouched blocks round-trip byte-for-byte through the parse's
// origins (the source map's block runs, kept by node; the serializer re-emits a block's bytes only
// while the block is still the parse's own, or equal to it). the oracle for that contract: a
// no-edit save is byte-identical, an edit's blast radius is one block (or one source group), and
// stale bytes can never overwrite an edit or resurrect a deletion.

const PREAMBLE = `\\documentclass{article}
\\usepackage{amsmath}
\\begin{document}`;

// deliberately gnarly body: hard-wrapped prose, irregular spacing, sameline + standalone
// comments, a heading with no blank line before the next paragraph, a double blank line,
// tab-indented list items, a math environment with a tab, a verbatim tabular, an unknown
// environment with args, and raw spacing chips. none of this survives the deterministic
// serializer; all of it must survive verbatim.
const BODY = `Intro paragraph wrapped
across two lines with   odd
spacing and a chip \\vspace{2pt} inline.

\\section{One}
Text right after the heading line, plus math $x+y$.


Double blank line above this paragraph.

% a standalone comment
\\begin{itemize}
	\\item First item
	\\item Second item with \\textbf{bold}
\\end{itemize}

\\begin{equation}
	E = mc^2
\\end{equation}

\\begin{tabular}{ll}
a & b \\\\
\\end{tabular}

\\begin{customenv}[opt]
Some content.
\\end{customenv}

Final paragraph.`;

const FILE = `${PREAMBLE}\n${BODY}\n\\end{document}\n`;

function reserialize(file: string, doc?: Node): string {
	const parsed = parseLatexFile(file);
	return serializeLatexFile(parsed, doc ?? parsed.doc);
}

function replaceChild(doc: Node, index: number, node: Node | null): Node {
	const kids: Node[] = [];
	for (let i = 0; i < doc.childCount; i++) {
		if (i === index) {
			if (node) kids.push(node);
		} else {
			kids.push(doc.child(i));
		}
	}
	return doc.copy(Fragment.fromArray(kids));
}

function posOf(doc: Node, needle: string): number {
	let found = -1;
	doc.descendants((n, pos) => {
		if (found >= 0) return false;
		if (n.isText) {
			const i = n.text!.indexOf(needle);
			if (i >= 0) found = pos + i;
		}
		return found < 0;
	});
	if (found < 0) throw new Error(`no text ${needle}`);
	return found;
}

function childIndexWithText(doc: Node, text: string): number {
	for (let i = 0; i < doc.childCount; i++) {
		if (doc.child(i).textContent.includes(text)) return i;
	}
	return -1;
}

describe('verbatim round-trip (no edits)', () => {
	it('parses to a schema-valid doc (doc.check())', () => {
		// lenient builders (NodeType.create) let a content-model violation through silently;
		// such a doc loads fine but freezes the editor on the first structural edit
		expect(() => parseLatexFile(FILE).doc.check()).not.toThrow();
	});

	it('is byte-identical for the whole file', () => {
		expect(reserialize(FILE)).toBe(FILE);
	});

	it('is byte-identical after a worker-style toJSON/fromJSON round-trip', () => {
		const parsed = parseLatexFile(FILE);
		const rehydrated = schema.nodeFromJSON(parsed.doc.toJSON());
		// the map crosses as data and the client registers it against the nodes it rebuilt
		rememberParseMap(rehydrated, parsed.map, parseBodyOf(parsed, FILE));
		expect(serializeLatexFile(parsed, rehydrated)).toBe(FILE);
	});

	it('knows every placed block by the file bytes it came from, in document order', () => {
		// the block runs of the map power positional consumers (the mode-switch scroll sync) and
		// the origins the serializer writes untouched blocks back from: the file at that range must
		// be the block's bytes, and ranges must be non-decreasing in document order
		const parsed = parseLatexFile(FILE);
		let last = -1;
		let checked = 0;
		for (const o of parsed.origins.origins) {
			if (o.text === undefined) continue;
			expect(FILE.slice(o.srcFrom!, o.srcTo!)).toBe(o.text);
			expect(o.srcFrom!).toBeGreaterThanOrEqual(last); // non-decreasing in document order
			last = o.srcFrom!;
			checked++;
		}
		expect(checked).toBeGreaterThan(5); // the gnarly body has many placed blocks
		expect(parsed.origins.origins.length).toBe(parsed.doc.childCount);
	});

	it('writes a document that forgot its source out afresh, and still to a fixed point', () => {
		const parsed = parseLatexFile(FILE);
		const once = serializeLatexFile(parsed, withoutOrigins(parsed.doc));
		expect(once).not.toBe(FILE); // the gnarly spacing does not survive the deterministic rules
		expect(reserialize(once)).toBe(once);
	});

	it('is byte-identical for a fragment file (no document wrapper)', () => {
		const fragment = 'A fragment paragraph\nwrapped by hand.\n\n\\begin{itemize}\n\t\\item one\n\\end{itemize}\n';
		expect(reserialize(fragment)).toBe(fragment);
	});

	it('preserves legacy \\vspace{\\baselineskip} lines verbatim', () => {
		const file = `${PREAMBLE}\nBefore.\n\n\\vspace{\\baselineskip}\n\nAfter.\n\\end{document}\n`;
		expect(reserialize(file)).toBe(file);
	});
});

describe('edit blast radius is one block', () => {
	it('regenerates only the edited paragraph; neighbours stay byte-identical', () => {
		const parsed = parseLatexFile(FILE);
		const idx = childIndexWithText(parsed.doc, 'Double blank line');
		expect(idx).toBeGreaterThan(-1);
		const child = parsed.doc.child(idx);
		// mimic a ProseMirror edit: same type, attrs copied (stale orig included), new content
		const edited = child.type.create(child.attrs, schema.text('Edited text.'));
		const out = serializeLatexFile(parsed, replaceChild(parsed.doc, idx, edited));

		// the edit landed (normalized form), the stale slice did not win
		expect(out).toContain('Edited text.');
		expect(out).not.toContain('Double blank line above this paragraph.');
		// untouched gnarly regions are still byte-exact
		expect(out).toContain('Intro paragraph wrapped\nacross two lines with   odd\nspacing');
		expect(out).toContain('\\section{One}\nText right after the heading line, plus math $x+y$.');
		expect(out).toContain('\\begin{itemize}\n\t\\item First item\n\t\\item Second item with \\textbf{bold}\n\\end{itemize}');
		expect(out).toContain('\\begin{equation}\n\tE = mc^2\n\\end{equation}');
		expect(out).toContain('% a standalone comment');
	});

	it('a block typed in and put back as it was is still written as its bytes', () => {
		// a letter typed and deleted leaves a new node with the old content; an undo does the same
		const parsed = parseLatexFile(FILE);
		const idx = childIndexWithText(parsed.doc, 'Double blank line');
		const child = parsed.doc.child(idx);
		const same = child.type.create(child.attrs, child.content, child.marks);
		expect(same).not.toBe(child);
		expect(serializeLatexFile(parsed, replaceChild(parsed.doc, idx, same))).toBe(FILE);
	});

	it('keeps the gap the file had before an edited first block and after an edited last block', () => {
		const file = `${PREAMBLE}\n\n\nFirst.\n\nSecond.\n\n\n\\end{document}\n`;
		const parsed = parseLatexFile(file);
		const typed = (i: number, words: string) =>
			replaceChild(parsed.doc, i, parsed.doc.child(i).type.create(parsed.doc.child(i).attrs, schema.text(words)));
		expect(serializeLatexFile(parsed, typed(0, 'First, typed.'))).toBe(`${PREAMBLE}\n\n\nFirst, typed.\n\nSecond.\n\n\n\\end{document}\n`);
		expect(serializeLatexFile(parsed, typed(1, 'Second, typed.'))).toBe(`${PREAMBLE}\n\n\nFirst.\n\nSecond, typed.\n\n\n\\end{document}\n`);
	});

	it('reaches a fixed point after an edit', () => {
		const parsed = parseLatexFile(FILE);
		const idx = childIndexWithText(parsed.doc, 'Final paragraph');
		const child = parsed.doc.child(idx);
		const edited = child.type.create(child.attrs, schema.text('Changed ending.'));
		const once = serializeLatexFile(parsed, replaceChild(parsed.doc, idx, edited));
		const twice = reserialize(once);
		expect(twice).toBe(once);
	});

	it('adds no \\par where a blank line or an \\end already ends the edited paragraph', () => {
		const file = `${PREAMBLE}\n\\begin{abstract}\nWe prove it works.\n\\end{abstract}\n\nMiddle paragraph.\n\n\\section{Two}\nLast paragraph.\n\\end{document}\n`;
		const parsed = parseLatexFile(file);
		const retext = (doc: Node, from: string, to: string): Node => {
			const kids: Node[] = [];
			doc.forEach((c) => kids.push(c.isText ? schema.text(c.text!.replace(from, to), c.marks) : retext(c, from, to)));
			return doc.copy(Fragment.fromArray(kids));
		};
		for (const [from, to] of [
			['We prove', 'We show'],
			['Middle', 'Centre'],
			['Last', 'Final']
		]) {
			const out = serializeLatexFile(parsed, retext(parsed.doc, from, to));
			expect(out).toContain(to);
			expect(out).not.toContain('\\par');
		}
		const fresh = schema.nodes.doc.create(null, [
			schema.nodes.paragraph.create(null, schema.text('One.')),
			schema.nodes.raw_latex.create(null, schema.text('\\vspace{1em}')),
			schema.nodes.paragraph.create(null, schema.text('Two.')),
			schema.nodes.paragraph.create(null, schema.text('Three.'))
		]);
		expect(serializeLatexFile(parsed, fresh)).toContain('One. \\par\n\\vspace{1em}\n\nTwo.\n\nThree.\n\\end{document}');
	});

	it('keeps the \\par a paragraph had while it still ends before the same block', () => {
		const file = `${PREAMBLE}\nFirst ends here. \\par\nSecond follows.\n\nLast one. \\par\n\\end{document}\n`;
		const parsed = parseLatexFile(file);
		const typed = (i: number, words: string) =>
			replaceChild(parsed.doc, i, parsed.doc.child(i).type.create(parsed.doc.child(i).attrs, schema.text(words)));
		expect(serializeLatexFile(parsed, typed(0, 'First ends here, typed.'))).toContain(
			'First ends here, typed. \\par\nSecond follows.\n\nLast one. \\par\n'
		);
		expect(serializeLatexFile(parsed, typed(1, 'Second follows, typed.'))).toContain(
			'First ends here. \\par\nSecond follows, typed.\n\nLast one. \\par\n'
		);
		expect(serializeLatexFile(parsed, typed(2, 'Last one, typed.'))).toContain(
			'Second follows.\n\nLast one, typed. \\par\n\\end{document}'
		);
		const joined = parsed.doc.copy(
			Fragment.fromArray([
				parsed.doc.child(0).type.create(parsed.doc.child(0).attrs, schema.text('First ends Second follows.')),
				parsed.doc.child(2)
			])
		);
		expect(serializeLatexFile(parsed, joined)).toContain('First ends Second follows.\n\nLast one. \\par');
	});

	it('an inserted-then-empty paragraph is a no-op (pristine neighbours re-join)', () => {
		const parsed = parseLatexFile(FILE);
		const idx = childIndexWithText(parsed.doc, 'Double blank line');
		const kids: Node[] = [];
		for (let i = 0; i < parsed.doc.childCount; i++) {
			kids.push(parsed.doc.child(i));
			if (i === idx) kids.push(schema.nodes.paragraph.create());
		}
		const out = serializeLatexFile(parsed, parsed.doc.copy(Fragment.fromArray(kids)));
		expect(out).toBe(FILE);
	});
});

describe('group (one source construct -> many blocks) is all-or-nothing', () => {
	function listIndices(doc: Node): number[] {
		const idx: number[] = [];
		for (let i = 0; i < doc.childCount; i++) if (doc.child(i).type.name === 'list') idx.push(i);
		return idx;
	}

	it('a deleted item is NOT resurrected by the shared slice', () => {
		const parsed = parseLatexFile(FILE);
		const lists = listIndices(parsed.doc);
		expect(lists.length).toBe(2);
		const out = serializeLatexFile(parsed, replaceChild(parsed.doc, lists[1], null));
		expect(out).not.toContain('Second item');
		// regenerated form: item text present, exactly one \item and one coherent env
		expect(out).toContain('First item');
		expect(out.match(/\\item/g)?.length).toBe(1);
		expect(out.match(/\\begin\{itemize\}/g)?.length).toBe(1);
		expect(out.match(/\\end\{itemize\}/g)?.length).toBe(1);
	});

	it('editing one item regenerates the whole environment coherently', () => {
		const parsed = parseLatexFile(FILE);
		const lists = listIndices(parsed.doc);
		const item = parsed.doc.child(lists[1]);
		const editedPara = schema.nodes.paragraph.create(null, schema.text('replacement item'));
		const edited = item.type.create(item.attrs, editedPara);
		const out = serializeLatexFile(parsed, replaceChild(parsed.doc, lists[1], edited));
		expect(out).toContain('replacement item');
		expect(out).not.toContain('Second item');
		expect(out.match(/\\begin\{itemize\}/g)?.length).toBe(1);
		expect(out.match(/\\end\{itemize\}/g)?.length).toBe(1);
		// the sibling paragraph above the list is still byte-exact
		expect(out).toContain('Double blank line above this paragraph.');
	});
});

describe('a container written out afresh keeps its untouched children as their bytes', () => {
	const ENV = `${PREAMBLE}
\\begin{quote}
First quoted paragraph, wrapped
by hand   with odd spacing.

Second quoted paragraph, also
wrapped by hand.
\\end{quote}

\\begin{itemize}
	\\item First item wrapped
	across lines
	\\item Second item with \\textbf{bold}
\\end{itemize}

Closing paragraph.
\\end{document}
`;

	/** the container with child `i` retyped, everything else the same nodes */
	function retypeChild(parsed: ReturnType<typeof parseLatexFile>, containerIndex: number, i: number, words: string): Node {
		const container = parsed.doc.child(containerIndex);
		const kids: Node[] = [];
		container.forEach((c, _o, k) => kids.push(k === i ? c.type.create(c.attrs, schema.text(words), c.marks) : c));
		return replaceChild(parsed.doc, containerIndex, container.type.create(container.attrs, Fragment.fromArray(kids), container.marks));
	}

	it('is byte-identical untouched', () => {
		expect(reserialize(ENV)).toBe(ENV);
	});

	it('an edited paragraph in an environment leaves its sibling wrapped as the file had it', () => {
		const parsed = parseLatexFile(ENV);
		const out = serializeLatexFile(parsed, retypeChild(parsed, 0, 1, 'Second, typed.'));
		expect(out).toContain('\\begin{quote}\nFirst quoted paragraph, wrapped\nby hand   with odd spacing.\n\nSecond, typed.');
		expect(out).toContain(
			'\\end{quote}\n\n\\begin{itemize}\n\t\\item First item wrapped\n\tacross lines\n\t\\item Second item with \\textbf{bold}\n\\end{itemize}'
		);
		expect(reserialize(out)).toBe(out);
	});

	it('an edited list item leaves the other item as the file had it', () => {
		const parsed = parseLatexFile(ENV);
		const lists = [];
		for (let i = 0; i < parsed.doc.childCount; i++) if (parsed.doc.child(i).type.name === 'list') lists.push(i);
		const out = serializeLatexFile(parsed, retypeChild(parsed, lists[1], 0, 'Second, typed.'));
		expect(out).toContain('\\item First item wrapped\n\tacross lines\n');
		expect(out).toContain('\\item Second, typed.');
		expect(out).not.toContain('Second item with');
		expect(out).toContain('First quoted paragraph, wrapped\nby hand   with odd spacing.');
		expect(reserialize(out)).toBe(out);
	});

	it('keeps the frame of a container whose child changed: indentation, blank lines, \\item gaps', () => {
		const file = `${PREAMBLE}
\\begin{proof}
  First step, wrapped
  by hand.

  Second step.
  \\end{proof}

\\begin{enumerate}
  \\item one
  \\item two wrapped
    across lines
  \\item three
\\end{enumerate}
\\end{document}
`;
		const parsed = parseLatexFile(file);
		const proof = serializeLatexFile(parsed, retypeChild(parsed, 0, 1, 'Second, typed.'));
		expect(proof).toContain('\\begin{proof}\n  First step, wrapped\n  by hand.\n\n  Second, typed.\n  \\end{proof}\n\n\\begin{enumerate}');
		expect(reserialize(proof)).toBe(proof);
		let lists = 0;
		for (let i = 0; i < parsed.doc.childCount; i++) if (parsed.doc.child(i).type.name === 'list') lists++;
		expect(lists).toBe(3);
		const items = serializeLatexFile(parsed, retypeChild(parsed, 2, 0, 'two, typed.'));
		expect(items).toContain('\\begin{enumerate}\n  \\item one\n  \\item two, typed.\n  \\item three\n\\end{enumerate}');
		expect(reserialize(items)).toBe(items);
	});

	it('maps the untouched child of a regenerated environment to where its bytes landed', () => {
		const parsed = parseLatexFile(ENV);
		const edited = retypeChild(parsed, 0, 1, 'Second, typed.');
		const { text, map } = serializeLatexFileDetailed(parsed, edited);
		const pm = posOf(edited, 'odd spacing');
		const off = pmToSource(map.leaves, pm);
		expect(off).not.toBeNull();
		expect(text.slice(off!, off! + 11)).toBe('odd spacing');
	});
});

describe('a block that changed in its text alone keeps everything but the leaves that changed', () => {
	const FILE2 = `${PREAMBLE}
Intro paragraph wrapped
across two lines with   odd
spacing and math \\(x+y\\) inline.

Second with \\textbf{bold words}
wrapped too, 50\\% sure.
\\end{document}
`;

	/** the block at `i` with its `k`-th inline text leaf given `text` */
	function retypeLeaf(doc: Node, i: number, k: number, text: string): Node {
		const block = doc.child(i);
		const kids: Node[] = [];
		let seen = 0;
		block.forEach((c) => {
			if (c.isText && seen++ === k) kids.push(schema.text(text, c.marks));
			else kids.push(c);
		});
		return replaceChild(doc, i, block.type.create(block.attrs, Fragment.fromArray(kids), block.marks));
	}

	it('a word typed into a hand-wrapped paragraph keeps the wrapping around it', () => {
		const parsed = parseLatexFile(FILE2);
		const out = serializeLatexFile(
			parsed,
			retypeLeaf(parsed.doc, 0, 0, 'Intro paragraph, typed, wrapped\nacross two lines with   odd\nspacing and math ')
		);
		expect(out).toBe(FILE2.replace('Intro paragraph wrapped', 'Intro paragraph, typed, wrapped'));
		expect(reserialize(out)).toBe(out);
	});

	it('escapes what is typed, and keeps the escaped bytes it did not touch', () => {
		const parsed = parseLatexFile(FILE2);
		const out = serializeLatexFile(parsed, retypeLeaf(parsed.doc, 1, 0, 'Second & third with '));
		expect(out).toContain('Second \\& third with \\textbf{bold words}\nwrapped too, 50\\% sure.');
		expect(reserialize(out)).toBe(out);
	});

	it('an edited formula keeps its delimiters and the prose around it', () => {
		const parsed = parseLatexFile(FILE2);
		const block = parsed.doc.child(0);
		const kids: Node[] = [];
		block.forEach((c) => kids.push(c.type.name === 'inline_math' ? c.type.create(c.attrs, schema.text('x+y+z'), c.marks) : c));
		const out = serializeLatexFile(
			parsed,
			replaceChild(parsed.doc, 0, block.type.create(block.attrs, Fragment.fromArray(kids), block.marks))
		);
		expect(out).toBe(FILE2.replace('\\(x+y\\)', '\\(x+y+z\\)'));
	});

	it('maps the leaves of a spliced block, the untouched ones to their old bytes', () => {
		const parsed = parseLatexFile(FILE2);
		const edited = retypeLeaf(parsed.doc, 0, 0, 'Intro paragraph, typed, wrapped\nacross two lines with   odd\nspacing and math ');
		const { text, map } = serializeLatexFileDetailed(parsed, edited);
		const pm = posOf(edited, 'inline');
		const off = pmToSource(map.leaves, pm);
		expect(off).not.toBeNull();
		expect(text.slice(off!, off! + 6)).toBe('inline');
		const typed = posOf(edited, 'typed');
		expect(pmToSource(map.leaves, typed)).not.toBeNull();
	});
});

describe('a block whose inline content changed keeps the bytes on either side of the change', () => {
	const FILE3 = `${PREAMBLE}
Leading words wrapped
across lines, then \\emph{stressed ones} and a tail
that goes on   for a while.
\\end{document}
`;

	it('a word made bold in the middle keeps the wrapping before and after it', () => {
		const parsed = parseLatexFile(FILE3);
		const block = parsed.doc.child(0);
		// bold the word "then" inside the first text leaf: the leaf splits in three
		const kids: Node[] = [];
		block.forEach((c, _o, i) => {
			if (i !== 0) return kids.push(c);
			const t = c.text!;
			const at = t.indexOf('then');
			kids.push(schema.text(t.slice(0, at)), schema.text('then', [schema.marks.strong.create()]), schema.text(t.slice(at + 4)));
		});
		const out = serializeLatexFile(
			parsed,
			replaceChild(parsed.doc, 0, block.type.create(block.attrs, Fragment.fromArray(kids), block.marks))
		);
		expect(out).toBe(FILE3.replace('across lines, then \\emph{stressed ones}', 'across lines, \\textbf{then} \\emph{stressed ones}'));
		expect(reserialize(out)).toBe(out);
	});

	it('a formula put into prose keeps the hand wrapping around it', () => {
		const parsed = parseLatexFile(FILE3);
		const block = parsed.doc.child(0);
		const kids: Node[] = [];
		block.forEach((c, _o, i) => {
			if (i !== 2) return kids.push(c);
			const t = c.text!;
			const at = t.indexOf('tail');
			kids.push(schema.text(t.slice(0, at)), schema.nodes.inline_math.create(null, schema.text('x^2')), schema.text(' ' + t.slice(at)));
		});
		const out = serializeLatexFile(
			parsed,
			replaceChild(parsed.doc, 0, block.type.create(block.attrs, Fragment.fromArray(kids), block.marks))
		);
		expect(out).toContain('across lines, then \\emph{stressed ones} and a $x^2$ tail\nthat goes on   for a while.');
		expect(reserialize(out)).toBe(out);
	});

	it('a caption typed into a figure that had none regenerates the figure, not just the caption', () => {
		const FILE4 = `${PREAMBLE}
Before.

\\begin{figure}[h]
    \\centering
    \\includegraphics{images/a.png}
\\end{figure}

After.
\\end{document}
`;
		const parsed = parseLatexFile(FILE4);
		const figure = parsed.doc.child(1);
		expect(figure.type.name).toBe('image');
		expect(figure.childCount).toBe(0);
		// the figure's bytes are all frame: nothing in them says where a caption would go
		const captioned = figure.type.create(figure.attrs, Fragment.fromArray([schema.text('A caption')]), figure.marks);
		const out = serializeLatexFile(parsed, replaceChild(parsed.doc, 1, captioned));
		expect(out).toContain('\\includegraphics{images/a.png}');
		expect(out).toContain('A caption');
		expect(out).toContain('Before.\n\n');
		expect(out).toContain('\n\nAfter.');
		expect(parseLatexFile(out).doc.child(1).type.name).toBe('image');
	});

	it('maps the kept leaves and the fresh stretch of a segment-spliced block', () => {
		const parsed = parseLatexFile(FILE3);
		const block = parsed.doc.child(0);
		const kids: Node[] = [];
		block.forEach((c, _o, i) => {
			if (i !== 0) return kids.push(c);
			const t = c.text!;
			const at = t.indexOf('then');
			kids.push(schema.text(t.slice(0, at)), schema.text('then', [schema.marks.strong.create()]), schema.text(t.slice(at + 4)));
		});
		const edited = replaceChild(parsed.doc, 0, block.type.create(block.attrs, Fragment.fromArray(kids), block.marks));
		const { text, map } = serializeLatexFileDetailed(parsed, edited);
		// one character in, since a word's first position is a boundary two runs share
		for (const word of ['Leading', 'then', 'stressed', 'while']) {
			const off = pmToSource(map.leaves, posOf(edited, word) + 1);
			expect(off).not.toBeNull();
			expect(text.slice(off! - 1, off! - 1 + word.length)).toBe(word);
		}
	});
});

describe('a leaf typed into keeps the bytes of the characters that did not change', () => {
	const FILE7 = `${PREAMBLE}
One long leaf wrapped
by hand across
three lines, with an accent caf\\'e and a dash -- in it.
\\end{document}
`;

	// the paragraph is a leaf, the accent as a chip, and a leaf holding the dash as one character
	function edit(doc: Node, leaf: number, fn: (t: string) => string): Node {
		const block = doc.child(0);
		const kids: Node[] = [];
		block.forEach((c, _o, i) => kids.push(i === leaf ? schema.text(fn(c.text!), c.marks) : c));
		return replaceChild(doc, 0, block.type.create(block.attrs, Fragment.fromArray(kids), block.marks));
	}

	it('a word typed at the start keeps every wrap after it', () => {
		const parsed = parseLatexFile(FILE7);
		expect(parsed.doc.child(0).childCount).toBe(3);
		const out = serializeLatexFile(
			parsed,
			edit(parsed.doc, 0, (t) => 'EDITED ' + t)
		);
		expect(out).toBe(FILE7.replace('One long', 'EDITED One long'));
		expect(reserialize(out)).toBe(out);
	});

	it('a word typed at the end keeps every wrap before it', () => {
		const parsed = parseLatexFile(FILE7);
		const out = serializeLatexFile(
			parsed,
			edit(parsed.doc, 2, (t) => t + ' More.')
		);
		expect(out).toBe(FILE7.replace('in it.', 'in it. More.'));
	});

	it('a word retyped in the middle keeps the wraps on both sides', () => {
		const parsed = parseLatexFile(FILE7);
		const out = serializeLatexFile(
			parsed,
			edit(parsed.doc, 0, (t) => t.replace('across', 'over'))
		);
		expect(out).toBe(FILE7.replace('across', 'over'));
	});

	it('a deletion keeps the bytes around the hole', () => {
		const parsed = parseLatexFile(FILE7);
		const out = serializeLatexFile(
			parsed,
			edit(parsed.doc, 0, (t) => t.replace(' with an accent', ''))
		);
		expect(out).toBe(FILE7.replace(' with an accent', ''));
	});

	it('an edit reaching into a stand-in writes the stand-in afresh, not half of it', () => {
		const parsed = parseLatexFile(FILE7);
		// retype the dash itself: the bytes -- it stands for cannot be cut in half
		const out = serializeLatexFile(
			parsed,
			edit(parsed.doc, 2, (t) => t.replace('\u2013', '\u2014'))
		);
		expect(out).toContain("three lines, with an accent caf\\'e and a dash --- in it.");
		expect(reserialize(out)).toBe(out);
	});

	it('maps the kept head and tail and the fresh middle', () => {
		const parsed = parseLatexFile(FILE7);
		const edited = edit(parsed.doc, 0, (t) => t.replace('across', 'over'));
		const { text, map } = serializeLatexFileDetailed(parsed, edited);
		for (const word of ['One', 'hand', 'over', 'three', 'dash']) {
			const off = pmToSource(map.leaves, posOf(edited, word) + 1);
			expect(off).not.toBeNull();
			expect(text.slice(off! - 1, off! - 1 + word.length)).toBe(word);
		}
	});
});

describe("the gaps beside a regenerated block are the file's", () => {
	const FILE5 = `${PREAMBLE}
First paragraph here.



Middle paragraph here.
  

\\section{Two}

    Indented paragraph.
\\end{document}
`;

	function retype(doc: Node, i: number): Node {
		const block = doc.child(i);
		const kids: Node[] = [];
		block.forEach((c, _o, k) => kids.push(k === 0 && c.isText ? schema.text('EDITED ' + c.text!, c.marks) : c));
		return replaceChild(doc, i, block.type.create(block.attrs, Fragment.fromArray(kids), block.marks));
	}

	it('keeps a gap of several blank lines on either side of a retyped paragraph', () => {
		const parsed = parseLatexFile(FILE5);
		expect(parsed.doc.child(1).textContent).toBe('Middle paragraph here.');
		const out = serializeLatexFile(parsed, retype(parsed.doc, 1));
		expect(out).toBe(FILE5.replace('Middle paragraph', 'EDITED Middle paragraph'));
		expect(reserialize(out)).toBe(out);
	});

	it('keeps the indentation in the gap before a retyped paragraph', () => {
		const parsed = parseLatexFile(FILE5);
		expect(parsed.doc.child(3).textContent).toBe('Indented paragraph.');
		const out = serializeLatexFile(parsed, retype(parsed.doc, 3));
		expect(out).toContain('\\section{Two}\n\n    EDITED Indented paragraph.\n');
		expect(reserialize(out)).toBe(out);
	});

	it('still puts a blank line after a retyped paragraph the file ran straight into a heading', () => {
		const FILE6 = `${PREAMBLE}
A paragraph.
\\section{Two}
Another.
\\end{document}
`;
		const parsed = parseLatexFile(FILE6);
		const out = serializeLatexFile(parsed, retype(parsed.doc, 0));
		expect(out).toContain('EDITED A paragraph.\n\n\\section{Two}\nAnother.');
		expect(parseLatexFile(out).doc.childCount).toBe(3);
	});

	it('keeps the single line end between a regenerated heading and the \\label under it', () => {
		const FILE7 = `${PREAMBLE}
\\section{Intro words}
\\label{sec:intro}

Text here.
\\end{document}
`;
		const parsed = parseLatexFile(FILE7);
		expect(parsed.doc.child(1).textContent).toBe('');
		const heading = parsed.doc.child(0);
		const kids: Node[] = [];
		heading.forEach((c) => {
			const t = c.text!;
			kids.push(schema.text(t.replace(' words', ' ')), schema.text('words', [schema.marks.strong.create()]));
		});
		const out = serializeLatexFile(parsed, replaceChild(parsed.doc, 0, heading.type.create(heading.attrs, Fragment.fromArray(kids))));
		expect(out).toContain('\\section{Intro \\textbf{words}}\n\\label{sec:intro}\n\nText here.');
		expect(reserialize(out)).toBe(out);
	});

	it("a paragraph put in afresh between two of the file's gets one blank line each side", () => {
		const parsed = parseLatexFile(FILE5);
		const fresh = schema.nodes.paragraph.create(null, schema.text('Brand new.'));
		const kids: Node[] = [];
		parsed.doc.forEach((c, _o, i) => {
			kids.push(c);
			if (i === 0) kids.push(fresh);
		});
		const out = serializeLatexFile(parsed, parsed.doc.copy(Fragment.fromArray(kids)));
		expect(out).toContain('First paragraph here.\n\nBrand new.\n\nMiddle paragraph here.\n  \n\n\\section{Two}');
	});
});

describe('a table keeps every byte but the cell or caption that changed', () => {
	const FILE8 = `${PREAMBLE}
Before.

\\begin{table}[t]
  \\centering
  \\caption{A caption here.}
  \\label{tab:x}
  \\begin{tabular}{l|rr}
    \\hline
    Name & Alpha value &  \\\\
    \\hline
    \\multicolumn{2}{c}{Merged cell text} & Last one \\\\ [2pt]
    Third row & 1.5 & 2.5 \\\\
    \\hline
  \\end{tabular}
\\end{table}

After.
\\end{document}
`;

	/** the first cell or caption holding `word`, its text leaf retyped */
	function retypeIn(doc: Node, word: string, fn: (t: string) => string): Node {
		let target: Node | null = null;
		doc.descendants((n) => {
			if (!target && /table_(cell|caption)/.test(n.type.name) && n.textContent.includes(word)) target = n;
			return !target;
		});
		if (!target) throw new Error(`no cell with ${word}`);
		const cell = target as Node;
		const fix = (p: Node): Node => {
			const inner: Node[] = [];
			let done = false;
			p.forEach((t) => {
				if (!done && t.isText && t.text!.includes(word)) {
					inner.push(schema.text(fn(t.text!), t.marks));
					done = true;
				} else inner.push(t);
			});
			return p.type.create(p.attrs, Fragment.fromArray(inner), p.marks);
		};
		const go = (node: Node): Node => {
			if (node === cell) {
				if (node.isTextblock) return fix(node);
				const kids: Node[] = [];
				node.forEach((c) => kids.push(fix(c)));
				return node.type.create(node.attrs, Fragment.fromArray(kids), node.marks);
			}
			if (node.isText || node.isLeaf) return node;
			const kids: Node[] = [];
			node.forEach((c) => kids.push(go(c)));
			return node.type.create(node.attrs, Fragment.fromArray(kids), node.marks);
		};
		return go(doc);
	}

	it('untouched, the table is byte-identical', () => {
		const parsed = parseLatexFile(FILE8);
		expect(serializeLatexFile(parsed, parsed.doc)).toBe(FILE8);
	});

	it('a cell retyped keeps the rules, the other cells, the empty cell and the row break suffix', () => {
		const parsed = parseLatexFile(FILE8);
		expect(
			serializeLatexFile(
				parsed,
				retypeIn(parsed.doc, 'Alpha', (t) => t.replace('Alpha', 'ALPHA'))
			)
		).toBe(FILE8.replace('Alpha', 'ALPHA'));
		expect(
			serializeLatexFile(
				parsed,
				retypeIn(parsed.doc, 'Third', (t) => t.replace('Third', 'THIRD'))
			)
		).toBe(FILE8.replace('Third', 'THIRD'));
	});

	it('a merged cell retyped keeps its \\multicolumn as written', () => {
		const parsed = parseLatexFile(FILE8);
		expect(
			serializeLatexFile(
				parsed,
				retypeIn(parsed.doc, 'Merged', (t) => t.replace('Merged', 'MERGED'))
			)
		).toBe(FILE8.replace('Merged', 'MERGED'));
	});

	it('a caption retyped keeps the tabular and the float frame', () => {
		const parsed = parseLatexFile(FILE8);
		expect(
			serializeLatexFile(
				parsed,
				retypeIn(parsed.doc, 'caption', (t) => t.replace('caption', 'CAPTION'))
			)
		).toBe(FILE8.replace('A caption', 'A CAPTION'));
	});

	it('maps the cells of a table one of whose cells changed', () => {
		const parsed = parseLatexFile(FILE8);
		const edited = retypeIn(parsed.doc, 'Third', (t) => t.replace('Third', 'THIRD'));
		const { text, map } = serializeLatexFileDetailed(parsed, edited);
		for (const word of ['Name', 'Alpha', 'Merged', 'Last', 'THIRD', '2.5', 'caption']) {
			const off = pmToSource(map.leaves, posOf(edited, word) + 1);
			expect(off, word).not.toBeNull();
			expect(text.slice(off! - 1, off! - 1 + word.length)).toBe(word);
		}
	});
});

describe('a block dragged elsewhere brings its bytes along', () => {
	const FILE9 = `${PREAMBLE}
First paragraph wrapped
by hand.

\\begin{itemize}
  \\item one wrapped
    by hand
  \\item two
  \\item three
\\end{itemize}

\\begin{theorem}
  Step one wrapped
  by hand.

  Step two.
\\end{theorem}

Last paragraph wrapped
by hand.
\\end{document}
`;

	/** the child at `from` of the node at `path` dragged to index `to`: the nodes themselves kept, as a drag keeps them */
	function move(doc: Node, path: number[], from: number, to: number): Node {
		function go(node: Node, depth: number): Node {
			const kids: Node[] = [];
			if (depth === path.length) {
				node.forEach((c) => kids.push(c));
				const [m] = kids.splice(from, 1);
				kids.splice(to, 0, m);
			} else node.forEach((c, _o, i) => kids.push(i === path[depth] ? go(c, depth + 1) : c));
			return node.type.create(node.attrs, Fragment.fromArray(kids), node.marks);
		}
		return go(doc, 0);
	}

	it('a paragraph dragged to the top keeps its wrap and leaves the rest as written', () => {
		const parsed = parseLatexFile(FILE9);
		expect(serializeLatexFile(parsed, move(parsed.doc, [], 5, 0))).toBe(
			FILE9.replace('First paragraph wrapped\nby hand.\n\n', '')
				.replace('\\end{theorem}\n\nLast paragraph wrapped\nby hand.', '\\end{theorem}')
				.replace(`${PREAMBLE}\n`, `${PREAMBLE}\nLast paragraph wrapped\nby hand.\n\nFirst paragraph wrapped\nby hand.\n\n`)
		);
	});

	it('an item dragged before the others keeps every item as written, in the new order', () => {
		const parsed = parseLatexFile(FILE9);
		expect(serializeLatexFile(parsed, move(parsed.doc, [], 3, 1))).toBe(
			FILE9.replace(
				'  \\item one wrapped\n    by hand\n  \\item two\n  \\item three',
				'  \\item three\n  \\item one wrapped\n    by hand\n  \\item two'
			)
		);
	});

	it('a paragraph dragged above another inside an environment keeps both as written', () => {
		const parsed = parseLatexFile(FILE9);
		expect(serializeLatexFile(parsed, move(parsed.doc, [4], 1, 0))).toBe(
			FILE9.replace('  Step one wrapped\n  by hand.\n\n  Step two.', '  Step two.\n\n  Step one wrapped\n  by hand.')
		);
	});
});

describe('a child added to or taken from a container leaves the other children as written', () => {
	const FILE10 = `${PREAMBLE}
\\begin{theorem}
	Step one wrapped
	by hand.

	Step two wrapped
	by hand.
\\end{theorem}

\\begin{itemize}
  \\item one wrapped
    by hand
  \\item two
\\end{itemize}
\\end{document}
`;

	it('a paragraph split inside an environment keeps the other paragraph and the indentation', () => {
		const parsed = parseLatexFile(FILE10);
		const env = parsed.doc.child(0);
		const p2 = env.child(1);
		const t = p2.textContent;
		const a = schema.nodes.paragraph.create(p2.attrs, schema.text('Step two'));
		const b = schema.nodes.paragraph.create(p2.attrs, schema.text(t.slice('Step two '.length)));
		const edited = replaceChild(parsed.doc, 0, env.type.create(env.attrs, Fragment.fromArray([env.child(0), a, b]), env.marks));
		const out = serializeLatexFile(parsed, edited);
		expect(out).toContain('\\begin{theorem}\n\tStep one wrapped\n\tby hand.\n\n\tStep two\n\n\twrapped by hand.\n\\end{theorem}');
	});

	it('a paragraph taken out of an environment keeps the other as written', () => {
		const parsed = parseLatexFile(FILE10);
		const env = parsed.doc.child(0);
		const edited = replaceChild(parsed.doc, 0, env.type.create(env.attrs, Fragment.fromArray([env.child(0)]), env.marks));
		expect(serializeLatexFile(parsed, edited)).toContain('\\begin{theorem}\n\tStep one wrapped\n\tby hand.\n\\end{theorem}');
	});

	it('a paragraph added to a list item keeps the other item as written', () => {
		const parsed = parseLatexFile(FILE10);
		const item = parsed.doc.child(1);
		expect(item.textContent).toBe('one wrapped by hand');
		const fresh = schema.nodes.paragraph.create(null, schema.text('More here.'));
		const edited = replaceChild(parsed.doc, 1, item.type.create(item.attrs, Fragment.fromArray([item.child(0), fresh]), item.marks));
		const out = serializeLatexFile(parsed, edited);
		// the fresh paragraph continues as the file indented the item's own lines
		expect(out).toContain('  \\item one wrapped\n    by hand\n\n    More here.\n  \\item two\n\\end{itemize}');
	});
});

describe('prose written afresh into an item is set off by a blank line', () => {
	const FILE11 = `${PREAMBLE}
\\begin{itemize}
\\item First item text here.
\\begin{itemize}
\\item Nested one.
\\end{itemize}
\\item Second item.
\\end{itemize}
\\end{document}
`;

	it('an item paragraph split above its nested list gets a blank line, so the halves stay two paragraphs', () => {
		const parsed = parseLatexFile(FILE11);
		const item = parsed.doc.child(0);
		expect(item.child(0).textContent).toBe('First item text here.');
		const a = schema.nodes.paragraph.create(item.child(0).attrs, schema.text('First item'));
		const b = schema.nodes.paragraph.create(item.child(0).attrs, schema.text('text here.'));
		const kids: Node[] = [a, b];
		item.forEach((c, _o, i) => {
			if (i > 0) kids.push(c);
		});
		const edited = replaceChild(parsed.doc, 0, item.type.create(item.attrs, Fragment.fromArray(kids)));
		const out = serializeLatexFile(parsed, edited);
		// the second half continues under the marker, as a paragraph written afresh into an item does
		expect(out).toContain(
			'\\item First item\n\n      text here.\n\\begin{itemize}\n\\item Nested one.\n\\end{itemize}\n\\item Second item.'
		);
		const again = parseLatexFile(out).doc.child(0);
		expect(again.child(1).textContent).toBe('text here.');
	});
});

describe('a block whose bytes end on a line end keeps it', () => {
	const FILE12 = `${PREAMBLE}
\\begin{equation}
x = 1 ,
\\end{equation}
%
and each glue is set to $a$ when $b$.
\\end{document}
`;

	it('a paragraph edited under a bare comment line is not swallowed by the comment', () => {
		const parsed = parseLatexFile(FILE12);
		const para = parsed.doc.child(2);
		expect(para.textContent).toContain('and each glue');
		const edited = replaceChild(parsed.doc, 2, para.type.create(para.attrs, schema.text('and every glue is set to it.')));
		const out = serializeLatexFile(parsed, edited);
		expect(out).toContain('%\nand every glue');
	});
});

describe('a line break typed into a table cell', () => {
	const FILE13 = `${PREAMBLE}
\\begin{tabular}{@{}ll@{}}
Quantity & Source \\\\
Column goal & column box \\\\
\\end{tabular}
\\end{document}
`;

	it('is a break inside the cell, not the row break that ends it', () => {
		const parsed = parseLatexFile(FILE13);
		const opened = padTables(parsed.doc);
		let at = -1;
		opened.descendants((node, pos) => {
			if (at < 0 && node.isText && (node.text ?? '').startsWith('Column goal')) at = pos;
			return at < 0;
		});
		const doc = new Transform(opened).replaceWith(at + 3, at + 3, schema.nodes.hard_break.create()).doc;
		const out = serializeLatexFile(parsed, doc);
		expect(out).toContain('Col\\newline');
		expect(parseLatexFile(out).doc.child(0).textContent).toContain('umn goal');
	});
});
