import { describe, it, expect } from 'vitest';
import { compareSuggestions, type EditMode, type PlacedSuggestion, type TypingSide } from '$lib/comments/suggestCompare';

function run(before: string, after: string, pending: PlacedSuggestion[], mode: EditMode = 'editing', sides?: Record<string, TypingSide>) {
	let n = 0;
	return compareSuggestions({ before, after, pending, mode, author: 'me', newId: () => `n${++n}`, sides });
}

function on(text: string, words: string, restore: string, author = 'mei', id = 's1'): PlacedSuggestion {
	const from = text.indexOf(words);
	return { id, from, to: from + words.length, restore, author };
}

function point(text: string, before: string, restore: string, author = 'mei', id = 's1'): PlacedSuggestion {
	const at = text.indexOf(before);
	return { id, from: at, to: at, restore, author };
}

const shown = (text: string, r: ReturnType<typeof run>) => r.placed.map((s) => [s.id, text.slice(s.from, s.to), s.restore, s.author]);

describe('an edit meeting a suggestion', () => {
	const T = 'It is sharp and cheap for smooth data.';
	const S = on(T, 'sharp and cheap', 'reliable');

	it.each([
		[
			'editing outside leaves it alone',
			T,
			'It was sharp and cheap for smooth data.',
			[S],
			'editing',
			[['s1', 'sharp and cheap', 'reliable', 'mei']],
			[]
		],
		[
			'editing at its edge leaves it alone',
			T,
			'It is sharp and cheapest for smooth data.',
			[S],
			'editing',
			[['s1', 'sharp and cheap', 'reliable', 'mei']],
			[]
		],
		[
			'deleting some new words shrinks it',
			T,
			'It is sharp for smooth data.',
			[S],
			'editing',
			[['s1', 'sharp ', 'reliable', 'mei']],
			['revise:s1']
		],
		[
			'typing inside splits it, old words with the first part',
			T,
			'It is sharp and very cheap for smooth data.',
			[S],
			'editing',
			[
				['s1', 'sharp and ', 'reliable', 'mei'],
				['n1', 'cheap', '', 'mei']
			],
			['revise:s1', 'open:n1']
		],
		[
			'replacing part of it splits it around the new text',
			T,
			'It is sharp or cheap for smooth data.',
			[S],
			'editing',
			[
				['s1', 'sharp ', 'reliable', 'mei'],
				['n1', ' cheap', '', 'mei']
			],
			['revise:s1', 'open:n1']
		],
		[
			'an edit across one edge takes only what it covers',
			T,
			'It rp and cheap for smooth data.',
			[S],
			'editing',
			[['s1', 'rp and cheap', 'reliable', 'mei']],
			['revise:s1']
		],
		['an edit across the whole of it closes it', T, 'It data.', [S], 'editing', [], ['close:s1']],
		[
			'deleting exactly the new words of a Replace leaves the Delete',
			T,
			'It is  for smooth data.',
			[S],
			'editing',
			[['s1', '', 'reliable', 'mei']],
			['revise:s1']
		],
		[
			'deleting exactly the new words of an Add withdraws it',
			T,
			'It is  for smooth data.',
			[on(T, 'sharp and cheap', '')],
			'editing',
			[],
			['withdraw:s1']
		],
		['replacing the whole of it closes it', T, 'It is fine for smooth data.', [S], 'editing', [], ['close:s1']],
		['a Delete inside a deletion closes', T, 'It for smooth data.', [point(T, 'sharp', 'very ')], 'editing', [], ['close:s1']],

		[
			'suggesting away from any suggestion makes one',
			'the cat sat',
			'the dog sat',
			[],
			'suggesting',
			[['n1', 'dog', 'cat', 'me']],
			['open:n1']
		],
		['a new suggestion takes whole words', 'the cats sat', 'the cat sat', [], 'suggesting', [['n1', 'cat', 'cats', 'me']], ['open:n1']],
		[
			'a phrase typed over is one suggestion',
			'it beats all baselines here',
			'it beats the uniform baseline here',
			[],
			'suggesting',
			[['n1', 'the uniform baseline', 'all baselines', 'me']],
			['open:n1']
		],
		[
			'suggesting against your own joins it',
			'the dog sat',
			'the doggy sat',
			[on('the dog sat', 'dog', 'cat', 'me')],
			'suggesting',
			[['s1', 'doggy', 'cat', 'me']],
			['revise:s1']
		],
		[
			"typing inside someone else's splits theirs around yours",
			T,
			'It is sharp and very cheap for smooth data.',
			[S],
			'suggesting',
			[
				['s1', 'sharp and ', 'reliable', 'mei'],
				['n1', 'very ', '', 'me'],
				['n2', 'cheap', '', 'mei']
			],
			['revise:s1', 'open:n1', 'open:n2']
		],
		[
			"deleting some of someone else's new words shrinks theirs",
			T,
			'It is sharp cheap for smooth data.',
			[S],
			'suggesting',
			[['s1', 'sharp cheap', 'reliable', 'mei']],
			['revise:s1']
		],
		[
			"replacing the whole of someone else's absorbs it",
			T,
			'It is fine for smooth data.',
			[S],
			'suggesting',
			[['n1', 'fine', 'reliable', 'me']],
			['open:n1', 'close:s1']
		],
		[
			"an edit across the edge of someone else's shrinks theirs and suggests the rest",
			T,
			'It rp and cheap for smooth data.',
			[S],
			'suggesting',
			[
				['n1', '', 'is ', 'me'],
				['s1', 'rp and cheap', 'reliable', 'mei']
			],
			['open:n1', 'revise:s1']
		],
		[
			'a Delete of yours joins typing at it',
			'It is sharp.',
			'It is really sharp.',
			[point('It is sharp.', 'sharp', 'very ', 'me')],
			'suggesting',
			[['s1', 'really ', 'very ', 'me']],
			['revise:s1']
		],
		[
			'putting the old words back withdraws it',
			'the dog sat',
			'the cat sat',
			[on('the dog sat', 'dog', 'cat', 'me')],
			'suggesting',
			[],
			['withdraw:s1']
		],
		[
			'whitespace alone changes nothing',
			T,
			'It is sharp\nand cheap for smooth data.',
			[S],
			'editing',
			[['s1', 'sharp\nand cheap', 'reliable', 'mei']],
			['revise:s1']
		]
	] as const)('%s', (_name, before, after, pending, mode, placed, changes) => {
		const r = run(before, after, [...pending], mode);
		expect(shown(after, r)).toEqual(placed);
		expect(r.changes.map((c) => `${c.t}:${c.id}`)).toEqual(changes);
	});

	it.each([
		[
			'in front of your own Delete, its words stay behind the typing',
			'It is sharp.',
			'It is really sharp.',
			point('It is sharp.', 'sharp', 'very ', 'me'),
			'suggesting',
			'before',
			[
				['n1', 'really ', '', 'me'],
				['s1', '', 'very ', 'me']
			]
		],
		[
			'in front of your own Replace, the typing is a suggestion of its own',
			T,
			'It is very sharp and cheap for smooth data.',
			on(T, 'sharp and cheap', 'reliable', 'me'),
			'suggesting',
			'before',
			[
				['n1', 'very ', '', 'me'],
				['s1', 'sharp and cheap', 'reliable', 'me']
			]
		],
		[
			"between someone else's old words and new words, theirs splits around the typing",
			T,
			'It is very sharp and cheap for smooth data.',
			S,
			'suggesting',
			'after',
			[
				['s1', '', 'reliable', 'mei'],
				['n2', 'very ', '', 'me'],
				['n1', 'sharp and cheap', '', 'mei']
			]
		],
		[
			'editing between old words and new words splits them the same way',
			T,
			'It is very sharp and cheap for smooth data.',
			S,
			'editing',
			'after',
			[
				['s1', '', 'reliable', 'mei'],
				['n1', 'sharp and cheap', '', 'mei']
			]
		]
	] as const)('typing with the caret %s', (_name, before, after, pending, mode, side, placed) => {
		expect(shown(after, run(before, after, [pending], mode, { s1: side }))).toEqual(placed);
	});

	it('suggests a paragraph break made or taken away, and with exact whitespace every space', () => {
		const suggest = (before: string, after: string, whitespace?: 'exact') =>
			compareSuggestions({ before, after, pending: [], mode: 'suggesting', author: 'me', newId: () => 'n', whitespace }).placed.map((s) => [
				after.slice(s.from, s.to),
				s.restore
			]);
		expect(suggest('It ends here.\n\nThe next one.', 'It ends here. The next one.')).toEqual([[' ', '\n\n']]);
		expect(suggest('It ends here. The next one.', 'It ends here.\n\nThe next one.')).toEqual([['\n\n', ' ']]);
		expect(suggest('a line\nwrapped', 'a line wrapped')).toEqual([]);
		expect(suggest('a line\nwrapped', 'a line wrapped', 'exact')).toEqual([[' ', '\n']]);
		expect(suggest('two words', 'two  words', 'exact')).toEqual([[' ', '']]);
	});

	it('keeps a paragraph break that is half a suggestion’s new words afterwards', () => {
		const before = 'Aa.\n\n\\x{b t}\n\\x{he c}\n\nr.';
		const after = '\\\n\nr';
		const theirs = on(before, 't}\n\\x{he', 'the', 'me', 'p');
		let n = 0;
		const r = compareSuggestions({ before, after, pending: [theirs], mode: 'suggesting', author: 'mei', newId: () => `n${++n}` });
		let rejected = after;
		for (const s of [...r.placed].reverse()) rejected = rejected.slice(0, s.from) + s.restore + rejected.slice(s.to);
		expect(rejected.replace(/\n\n/g, '¶').replace(/\s+/g, ' ')).toBe('Aa.¶\\x{b the c}¶r.');
	});

	it('suggests a paragraph break that moved to the other side of a word', () => {
		const before = '\\section{Edge}\n\\label{sec}\n\nSpecial words.';
		const after = '\\section{Edge}\n\n\\label{sec}Special words.';
		const gestures = [{ from: after.indexOf('\n\n'), to: after.indexOf('Special') }];
		const r = compareSuggestions({ before, after, pending: [], mode: 'suggesting', author: 'me', newId: () => 'n', gestures });
		let rejected = after;
		for (const s of [...r.placed].reverse()) rejected = rejected.slice(0, s.from) + s.restore + rejected.slice(s.to);
		expect(rejected.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, ' '))).toEqual(['\\section{Edge} \\label{sec}', 'Special words.']);
	});

	it('joins the words one edit typed over, and keeps a separate edit separate', () => {
		const before = 'where a coarse grid resolves it and the old mesh too';
		const after = 'where one coarse cell resolves it and the new mesh too';
		const typed = { from: after.indexOf('one'), to: after.indexOf('cell') + 'cell'.length };
		let n = 0;
		const compare = (gestures: { from: number; to: number }[]) =>
			compareSuggestions({ before, after, pending: [], mode: 'suggesting', author: 'me', newId: () => `n${++n}`, gestures }).placed.map(
				(s) => s.restore
			);
		expect(compare([typed])).toEqual(['a coarse grid', 'old']);
		expect(compare([])).toEqual(['a', 'grid', 'old']);
	});

	it('reads an edit right before a suggestion as outside it, even where the text repeats', () => {
		const text = 'x the cat y';
		const theirs = on(text, 'the cat', 'a dog');
		expect(shown('x the the cat y', run(text, 'x the the cat y', [theirs]))).toEqual([['s1', 'the cat', 'a dog', 'mei']]);
		const deleted = run('x the the cat y', 'x the cat y', [on('x the the cat y', 'the cat', 'a dog')], 'suggesting');
		expect(shown('x the cat y', deleted)).toEqual([
			['n1', '', 'the ', 'me'],
			['s1', 'the cat', 'a dog', 'mei']
		]);
	});

	it('never splits a character that takes two code units', () => {
		const r = run('ok 😀 go', 'ok 😃 go', [], 'suggesting');
		expect(r.placed.map((s) => ['ok 😃 go'.slice(s.from, s.to), s.restore])).toEqual([['😃', '😀']]);
	});

	it('keeps suggestions a big replace-all does not touch', () => {
		const line = 'a coarse grid resolves it.\n';
		const before = line.repeat(1500);
		const after = before.replaceAll('grid', 'mesh');
		const pending = Array.from({ length: 100 }, (_, i) => {
			const at = i * 15 * line.length + 'a coarse'.length;
			return { id: `p${i}`, from: at, to: at, restore: ' very', author: 'mei' };
		});
		const r = run(before, after, pending);
		expect(r.changes.filter((c) => c.t === 'close')).toEqual([]);
		expect(r.placed).toHaveLength(100);
	});

	it('keeps a command whole when it is removed, added or renamed', () => {
		const text = 'Text.\n\n\\clearpage\n\n\\appendix\n';
		const removed = run(text, 'Text.\n\n\\appendix\n', [], 'suggesting');
		expect(removed.placed.map((s) => s.restore)).toEqual(['\\clearpage\n\n']);
		const added = run('Text.\n\n\\appendix\n', text, [], 'suggesting');
		expect(added.placed.map((s) => text.slice(s.from, s.to))).toEqual(['\\clearpage\n\n']);
		const renamed = 'Text.\n\n\\newpage\n\n\\appendix\n';
		const kind = run(text, renamed, [], 'suggesting');
		expect(kind.placed.map((s) => [s.restore, renamed.slice(s.from, s.to)])).toEqual([['\\clearpage', '\\newpage']]);
	});

	it('runs a change to what opens a group on to where the group closes', () => {
		const after = 'Some {\\it words} and \\textbf{bold words}, then more.';
		const { placed } = run('Some {\\it words} and {\\bf bold words}, then more.', after, [], 'suggesting');
		expect(placed.map((s) => [s.restore, after.slice(s.from, s.to)])).toEqual([['{\\bf bold words}', '\\textbf{bold words}']]);
	});

	it('suggests by word in text with no spaces', () => {
		const r = run('我们证明了这个方法是可靠的', '我们证明了这个方法是稳定的', [], 'suggesting');
		expect(r.placed).toHaveLength(1);
		expect(r.placed[0].restore.length).toBeLessThan(6);
	});
});
