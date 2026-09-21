import { describe, it, expect } from 'vitest';
import { Fragment, type Node } from 'prosemirror-model';
import { Transform } from 'prosemirror-transform';
import { parseTypstFile, serializeTypstFile, serializeTypstFileDetailed } from '$lib/languages/typst/visual/roundtrip';
import { pmToSource } from '$lib/editor/visual/sourceSpans';

// what an edit in the visual editor leaves of a typst file: everything but the bytes of what
// changed, inside a list item or a quote as at the top level, hand wraps and prefixes included

const MD = `= Title



Intro paragraph wrapped
by hand here.

- first item wrapped
  by hand too
- second item with _emph_ and
  a wrap
  - nested child
  - nested other

/ Term: description wrapped
  by hand

#quote(block: true)[
  quoted line one
  quoted line two
]

+ one
+ two

Tail paragraph.
`;

/** the block at `path`, its first text leaf retyped */
function retype(doc: Node, path: number[], fn: (t: string) => string): Node {
	function go(node: Node, depth: number): Node {
		const kids: Node[] = [];
		if (depth === path.length) {
			let done = false;
			node.forEach((c) => {
				if (!done && c.isText) {
					kids.push(c.type.schema.text(fn(c.text!), c.marks));
					done = true;
				} else kids.push(c);
			});
		} else node.forEach((c, _o, i) => kids.push(i === path[depth] ? go(c, depth + 1) : c));
		return node.type.create(node.attrs, Fragment.fromArray(kids), node.marks);
	}
	return go(doc, 0);
}

/** the block at `path` replaced by `make(schema)` */
function replace(doc: Node, path: number[], make: (node: Node) => Node): Node {
	function go(node: Node, depth: number): Node {
		if (depth === path.length) return make(node);
		const kids: Node[] = [];
		node.forEach((c, _o, i) => kids.push(i === path[depth] ? go(c, depth + 1) : c));
		return node.type.create(node.attrs, Fragment.fromArray(kids), node.marks);
	}
	return go(doc, 0);
}

function bold(doc: Node, path: number[], word: string): Node {
	return replace(doc, path, (node) => {
		const kids: Node[] = [];
		node.forEach((c) => {
			const at = c.isText ? c.text!.indexOf(word) : -1;
			if (at < 0) return kids.push(c);
			const t = c.text!;
			if (at > 0) kids.push(c.type.schema.text(t.slice(0, at), c.marks));
			kids.push(c.type.schema.text(word, [...c.marks, c.type.schema.marks.strong.create()]));
			if (at + word.length < t.length) kids.push(c.type.schema.text(t.slice(at + word.length), c.marks));
		});
		return node.type.create(node.attrs, Fragment.fromArray(kids), node.marks);
	});
}

function posOf(doc: Node, needle: string): number {
	let found = -1;
	doc.descendants((n, pos) => {
		if (found >= 0 || !n.isText) return found < 0;
		const at = n.text!.indexOf(needle);
		if (at >= 0) found = pos + at;
		return false;
	});
	if (found < 0) throw new Error(`no ${needle}`);
	return found;
}

describe('typst: an edit keeps every byte but its own', () => {
	const parsed = parseTypstFile(MD);

	it('untouched, the file is byte-identical', () => {
		expect(serializeTypstFile(parsed, parsed.doc)).toBe(MD);
	});

	it('a word typed at the start of a wrapped paragraph keeps its wrap and the three blank lines above it', () => {
		expect(
			serializeTypstFile(
				parsed,
				retype(parsed.doc, [1], (t) => 'EDITED ' + t)
			)
		).toBe(MD.replace('Intro', 'EDITED Intro'));
	});

	it('a word made bold keeps the wrap on either side', () => {
		expect(serializeTypstFile(parsed, bold(parsed.doc, [1], 'hand'))).toBe(MD.replace('by hand here', 'by *hand* here'));
	});

	it('an item retyped leaves the other items, their wraps and the nested list as they were', () => {
		expect(
			serializeTypstFile(
				parsed,
				retype(parsed.doc, [3, 0], (t) => t.replace('second', 'SECOND'))
			)
		).toBe(MD.replace('second', 'SECOND'));
	});

	it('a nested item retyped leaves everything around it', () => {
		expect(
			serializeTypstFile(
				parsed,
				retype(parsed.doc, [3, 2, 0], (t) => t.replace('other', 'OTHER'))
			)
		).toBe(MD.replace('nested other', 'nested OTHER'));
	});

	it('a term description retyped keeps the term, its title retyped keeps the description', () => {
		expect(
			serializeTypstFile(
				parsed,
				retype(parsed.doc, [4, 1], (t) => t.replace('description', 'DESC'))
			)
		).toBe(MD.replace('description', 'DESC'));
		expect(
			serializeTypstFile(
				parsed,
				retype(parsed.doc, [4, 0], () => 'TERM')
			)
		).toBe(MD.replace('/ Term:', '/ TERM:'));
	});

	it('a quoted paragraph retyped keeps the quote and its indentation', () => {
		expect(
			serializeTypstFile(
				parsed,
				retype(parsed.doc, [5, 0], (t) => t.replace('two', 'TWO'))
			)
		).toBe(MD.replace('line two', 'line TWO'));
	});

	it('an enum item retyped keeps its marker and its neighbour', () => {
		expect(
			serializeTypstFile(
				parsed,
				retype(parsed.doc, [7, 0], () => 'TWO')
			)
		).toBe(MD.replace('+ two', '+ TWO'));
	});

	it('a paragraph written afresh inside an item continues under the marker', () => {
		const schema = parsed.doc.type.schema;
		const edited = replace(parsed.doc, [3, 2, 0], (p) =>
			p.type.create(
				p.attrs,
				Fragment.fromArray([schema.text('one line'), schema.nodes.hard_break.create(), schema.text('next line')]),
				p.marks
			)
		);
		const out = serializeTypstFile(parsed, edited);
		expect(out).toContain('  - nested child\n  - one line\\\n    next line\n');
		expect(out).toContain('- first item wrapped\n  by hand too\n');
	});

	it('maps the kept bytes and the fresh ones of an edited item', () => {
		const edited = retype(parsed.doc, [3, 0], (t) => t.replace('second', 'SECOND'));
		const { text, map } = serializeTypstFileDetailed(parsed, edited);
		for (const word of ['Intro', 'first', 'SECOND', 'wrap', 'nested', 'quoted', 'Tail']) {
			const off = pmToSource(map.leaves, posOf(edited, word) + 1);
			expect(off, word).not.toBeNull();
			expect(text.slice(off! - 1, off! - 1 + word.length)).toBe(word);
		}
	});
});

describe('typst: a table keeps every byte but the cell that changed', () => {
	const TABLE = `Before.

#table(
  columns: (auto, 1fr, auto),
  stroke: 0.5pt,
  table.header([Name], [Alpha value], [Last]),
  table.hline(),
  [First row], table.cell(colspan: 2)[Merged cell text],
  [Third row], [1.5], [],
)

After.
`;

	function retypeIn(doc: Node, word: string, fn: (t: string) => string): Node {
		let target: Node | null = null;
		doc.descendants((n) => {
			if (!target && /table_(cell|header)/.test(n.type.name) && n.textContent.includes(word)) target = n;
			return !target;
		});
		if (!target) throw new Error(`no cell with ${word}`);
		const cell = target as Node;
		const go = (node: Node): Node => {
			if (node === cell) {
				const kids: Node[] = [];
				node.forEach((p) => {
					const inner: Node[] = [];
					let done = false;
					p.forEach((t) => {
						if (!done && t.isText && t.text!.includes(word)) {
							inner.push(t.type.schema.text(fn(t.text!), t.marks));
							done = true;
						} else inner.push(t);
					});
					kids.push(p.type.create(p.attrs, Fragment.fromArray(inner), p.marks));
				});
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
		const parsed = parseTypstFile(TABLE);
		expect(serializeTypstFile(parsed, parsed.doc)).toBe(TABLE);
	});

	it('a header cell, a body cell and a merged cell retyped keep everything else as written', () => {
		const parsed = parseTypstFile(TABLE);
		for (const [w, r] of [
			['Alpha', 'ALPHA'],
			['First', 'FIRST'],
			['Merged', 'MERGED'],
			['Third', 'THIRD']
		]) {
			expect(
				serializeTypstFile(
					parsed,
					retypeIn(parsed.doc, w, (t) => t.replace(w, r))
				),
				w
			).toBe(TABLE.replace(w, r));
		}
	});

	it('maps the cells of a table one of whose cells changed', () => {
		const parsed = parseTypstFile(TABLE);
		const edited = retypeIn(parsed.doc, 'Third', (t) => t.replace('Third', 'THIRD'));
		const { text, map } = serializeTypstFileDetailed(parsed, edited);
		for (const word of ['Name', 'Alpha', 'First', 'Merged', 'THIRD', '1.5']) {
			const off = pmToSource(map.leaves, posOf(edited, word) + 1);
			expect(off, word).not.toBeNull();
			expect(text.slice(off! - 1, off! - 1 + word.length)).toBe(word);
		}
	});
});

describe('typst: a block dragged elsewhere brings its bytes along', () => {
	const DRAG =
		'First paragraph wrapped\nby hand.\n\n- one wrapped\n  by hand\n- two\n- three\n\n#quote(block: true)[\n  quote one wrapped\n  by hand\n\n  quote two\n]\n\nLast paragraph wrapped\nby hand.\n';

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
		const parsed = parseTypstFile(DRAG);
		expect(serializeTypstFile(parsed, move(parsed.doc, [], 5, 0))).toBe(
			'Last paragraph wrapped\nby hand.\n\n' + DRAG.replace('\n\nLast paragraph wrapped\nby hand.\n', '\n')
		);
	});

	it('an item dragged before the others keeps every item as written, in the new order', () => {
		const parsed = parseTypstFile(DRAG);
		expect(serializeTypstFile(parsed, move(parsed.doc, [], 3, 1))).toBe(
			DRAG.replace('- one wrapped\n  by hand\n- two\n- three', '- three\n- one wrapped\n  by hand\n- two')
		);
	});

	it('a paragraph dragged above another inside a quote keeps both as written', () => {
		const parsed = parseTypstFile(DRAG);
		expect(serializeTypstFile(parsed, move(parsed.doc, [4], 1, 0))).toBe(
			DRAG.replace('  quote one wrapped\n  by hand\n\n  quote two', '  quote two\n\n  quote one wrapped\n  by hand')
		);
	});
});

describe('typst: a child added to an item leaves the other items as written', () => {
	const LIST = 'Intro.\n\n- one wrapped\n  by hand\n- two wrapped\n  by hand\n- three\n\nAfter.\n';

	it('a paragraph added to the second item keeps the first and third as written, the list tight', () => {
		const parsed = parseTypstFile(LIST);
		const schema = parsed.doc.type.schema;
		const fresh = schema.nodes.paragraph.create(null, schema.text('More here.'));
		const edited = replace(parsed.doc, [2], (it) => it.type.create(it.attrs, Fragment.fromArray([it.child(0), fresh]), it.marks));
		const out = serializeTypstFile(parsed, edited);
		expect(out).toContain('- one wrapped\n  by hand\n- two wrapped\n  by hand\n\n  More here.\n- three\n');
	});

	it('the second item split in two keeps the first and third as written', () => {
		const parsed = parseTypstFile(LIST);
		const schema = parsed.doc.type.schema;
		const a = schema.nodes.paragraph.create(null, schema.text('two'));
		const b = schema.nodes.paragraph.create(null, schema.text('wrapped by hand'));
		const edited = replace(parsed.doc, [2], (it) => it.type.create(it.attrs, Fragment.fromArray([a, b]), it.marks));
		const out = serializeTypstFile(parsed, edited);
		expect(out).toContain('- one wrapped\n  by hand\n- two\n\n  wrapped by hand\n- three\n');
	});
});

describe('typst: a regenerated block keeps its <label> where the file put it', () => {
	it('a heading with its label on the next line keeps it there once a word is made bold', () => {
		const parsed = parseTypstFile('= Intro words\n<sec:intro>\n\nText here.\n');
		expect(parsed.doc.child(0).attrs.label).toBe('sec:intro');
		const out = serializeTypstFile(parsed, bold(parsed.doc, [0], 'words'));
		expect(out).toBe('= Intro *words*\n<sec:intro>\n\nText here.\n');
	});

	it('a heading with its label on its own line keeps it on the line', () => {
		const parsed = parseTypstFile('= Intro words <sec:intro>\n\nText here.\n');
		const out = serializeTypstFile(parsed, bold(parsed.doc, [0], 'words'));
		expect(out).toBe('= Intro *words* <sec:intro>\n\nText here.\n');
	});

	it('an equation and a figure keep their label line too', () => {
		const file = '$ x + y $\n<eq:one>\n\n#figure(image("a.png"), caption: [A cap])\n<fig:one>\n';
		const parsed = parseTypstFile(file);
		expect(parsed.doc.child(0).attrs.labelGap).toBe('\n');
		expect(parsed.doc.child(1).attrs.labelGap).toBe('\n');
		expect(serializeTypstFile(parsed, parsed.doc.copy(parsed.doc.content))).toBe(file);
	});
});

describe('typst: prose written afresh into an item is set off by a blank line', () => {
	const NESTED = 'Intro.\n\n- One, with nested children:\n  - A second level.\n    - A third level.\n- Two.\n';

	it('a nested item paragraph split above its own nested list gets a blank line', () => {
		const parsed = parseTypstFile(NESTED);
		const schema = parsed.doc.type.schema;
		const a = schema.nodes.paragraph.create(null, schema.text('A second'));
		const b = schema.nodes.paragraph.create(null, schema.text('level.'));
		const edited = replace(parsed.doc, [1, 1], (it) => it.type.create(it.attrs, Fragment.fromArray([a, b, it.child(1)]), it.marks));
		const out = serializeTypstFile(parsed, edited);
		expect(out).toContain('- One, with nested children:\n  - A second\n\n    level.\n    - A third level.\n- Two.\n');
		const again = parseTypstFile(out).doc.child(1).child(1);
		expect(again.childCount).toBe(3);
		expect(again.child(1).textContent).toBe('level.');
	});
});

describe('typst: bytes written beside the bytes the file keeps', () => {
	const TERMS = 'Intro line.\n\n/ Te\\@---rm: its definition, which is a term.\n/ Another term: a second one.\n\nTail line.\n';

	it('an at sign before a dash shorthand keeps its escape, so it is not read as a reference', () => {
		const parsed = parseTypstFile(TERMS);
		const edited = replace(parsed.doc, [1, 0, 1], (p) => p.type.create(p.attrs, p.type.schema.text('its meaning, retyped.'), p.marks));
		const out = serializeTypstFile(parsed, edited);
		expect(out).toContain('/ Te\\@---rm:');
		expect(parseTypstFile(out).doc.child(1).child(0).child(0).textContent).toBe('Te@—rm');
	});

	const STRONG = 'Intro line.\n\nText can be *strong*, and plain after it.\n';

	it('a deletion that would leave a strong marker against a letter writes the block afresh', () => {
		const parsed = parseTypstFile(STRONG);
		const para = parsed.doc.child(1);
		const kids: Node[] = [];
		para.forEach((c, _o, i) => kids.push(i === 0 ? c.type.schema.text('Text ca', c.marks) : c));
		const out = serializeTypstFile(
			parsed,
			replace(parsed.doc, [1], (p) => p.type.create(p.attrs, Fragment.fromArray(kids), p.marks))
		);
		expect(out).not.toContain('ca*strong*');
		expect(parseTypstFile(out).doc.child(1).textContent).toBe('Text castrong, and plain after it.');
	});
});

describe('typst: markup that a seam would open', () => {
	const WRAPPED = 'Intro line.\n\nA reference to a section works the\nsame way: @sec:basics.\n\nTail line.\n';

	it('a list marker typed at the start of a wrapped line is escaped', () => {
		const parsed = parseTypstFile(WRAPPED);
		const at = posOf(parsed.doc, 'same way');
		const doc = new Transform(parsed.doc).replaceWith(at, at, parsed.doc.type.schema.text('+ ')).doc;
		const out = serializeTypstFile(parsed, doc);
		expect(out).toContain('works the\n\\+ same way');
		expect(parseTypstFile(out).doc.child(1).textContent).toBe(doc.child(1).textContent);
	});

	it('text typed straight after a reference takes the call form, and a dot after that is escaped', () => {
		const parsed = parseTypstFile(WRAPPED);
		// the full stop after the reference atom
		const at = posOf(parsed.doc, 'same way: ') + 'same way: '.length + 1;
		const doc = new Transform(parsed.doc).replaceWith(at, at + 1, parsed.doc.type.schema.text('.word')).doc;
		const out = serializeTypstFile(parsed, doc);
		expect(out).toContain('#ref(<sec:basics>)\\.word');
		expect(parseTypstFile(out).doc.child(1).toString()).toBe(doc.child(1).toString());
	});

	const SNAKE = 'Intro line.\n\n== Raw blocks snake_case_words\n<sec:raw>\n\nTail line.\n';

	it('bytes put after an underscore the file keeps inside a word write the block afresh, the underscore escaped', () => {
		const parsed = parseTypstFile(SNAKE);
		const at = posOf(parsed.doc, 'case_') + 'case_'.length;
		const doc = new Transform(parsed.doc).replaceWith(at, at, parsed.doc.type.schema.text('/* ')).doc;
		const out = serializeTypstFile(parsed, doc);
		expect(out).toContain('snake_case\\_/\\* words');
		expect(parseTypstFile(out).doc.child(1).toString()).toBe(doc.child(1).toString());
	});

	const EMPTY = 'Intro line.\n\n+ \n+ The numbering is automatic.\n';

	it('what is typed into an empty item lands after the marker and its space', () => {
		const parsed = parseTypstFile(EMPTY);
		const item = parsed.doc.child(1);
		const doc = new Transform(parsed.doc).insert(parsed.doc.child(0).nodeSize + 2, parsed.doc.type.schema.text("'?")).doc;
		expect(doc.child(1).textContent).toBe("'?");
		expect(item.childCount).toBe(1);
		const out = serializeTypstFile(parsed, doc);
		expect(out).toBe("Intro line.\n\n+ '?\n+ The numbering is automatic.\n");
	});

	it('a bare url written as a bodiless link call reads back as the url', () => {
		const parsed = parseTypstFile('See #link("https://github.com/typst/typst") here.\n');
		expect(parsed.doc.child(0).toString()).toBe('paragraph("See ", inline_latex("https://github.com/typst/typst"), " here.")');
		expect(serializeTypstFile(parsed, parsed.doc)).toBe('See #link("https://github.com/typst/typst") here.\n');
	});
});
