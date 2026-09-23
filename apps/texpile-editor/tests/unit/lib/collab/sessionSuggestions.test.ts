// @vitest-environment jsdom
// suggestions in a shared session, end to end: real editors on every side, the host recording
import { it, expect, vi, afterEach } from 'vitest';
import { disk } from './sessionDisk';

vi.mock('$lib/workspace/fileSystem', async () => {
	const { disk } = await import('./sessionDisk');
	return {
		readTextFile: async (path: string) => {
			const hit = Object.entries(disk).find(([k]) => path.replace(/\\/g, '/').endsWith(k));
			if (!hit) throw new Error(`ENOENT ${path}`);
			return hit[1];
		},
		writeTextFile: async (path: string, text: string) => {
			disk[path.replace(/\\/g, '/').replace(/^\/w\//, '')] = text;
		},
		joinPath: (a: string, b: string) => `${a}/${b}`
	};
});
vi.mock('$lib/workspace/texpileDir', () => ({
	texpilePath: (root: string, name: string) => `${root}/.texpile/${name}`,
	ensureTexpileIgnore: async () => {}
}));
vi.mock('$lib/comments/author', () => ({
	resolveAuthor: async (root: string | null, preferred: string) => preferred || (root === 'session' ? 'guest' : 'louis'),
	forgetAuthor: () => {}
}));

const { startSession, openSuggestions, placedOn, withAllRejected, logged, FILE } = await import('./sessionHarness');
type Session = Awaited<ReturnType<typeof startSession>>;

const TEXT = 'We prove the estimator is sharp for smooth solutions.\n';

let open: Session | null = null;
async function session(o: Parameters<typeof startSession>[0] = { text: TEXT }) {
	open = await startSession(o);
	return open;
}
afterEach(() => {
	open?.close();
	open = null;
});

it('smoke: a guest typing in Suggesting reaches the host as their suggestion', async () => {
	const s = await session();
	const mei = await s.join('mei');
	await mei.mode('suggesting');
	mei.keys.type('new ', 'estimator');
	await s.quiet();
	expect(s.host.text()).toBe(TEXT.replace('the estimator', 'the new estimator'));
	expect(openSuggestions(s.host.ctl.threads)).toEqual([['mei', 'new ', '']]);
	expect(disk[FILE]).toBe(s.host.text());
	expect(logged().filter((e) => e.t === 'open')).toHaveLength(1);
	expect(withAllRejected(s.host.text(), placedOn(s.host.ctl)!.placed)).toBe(TEXT);
});

type Side = { ctl: Parameters<typeof placedOn>[0] };
const shape = (side: Side) =>
	(placedOn(side.ctl)?.placed ?? []).map((p) => ({ id: p.id, from: p.from, to: p.to, restore: p.restore, author: p.author }));

/** once everything has settled: every guest draws what the host recorded, nothing is lost, and rejecting it all gives `base` */
async function agree(s: Session, base: string) {
	await s.quiet();
	const host = placedOn(s.host.ctl);
	const text = s.host.text();
	expect(host?.text ?? text).toBe(text);
	expect([...s.host.ctl.orphaned]).toEqual([]);
	const recorded = s.host.ctl.threads.filter((t) => t.restore !== undefined && !t.resolved && t.file === FILE).map((t) => t.id);
	expect(
		shape(s.host)
			.map((p) => p.id)
			.sort()
	).toEqual(recorded.sort());
	for (const g of s.guests) {
		expect(g.text()).toBe(text);
		expect(shape(g), `${g.name} draws what the host recorded`).toEqual(shape(s.host));
	}
	expect(withAllRejected(text, host?.placed ?? [])).toBe(base);
	expect(disk[FILE]).toBe(text);
}

async function rejectAllOn(ctl: Side['ctl'], s: Session) {
	for (let n = 0; n < 50; n++) {
		await s.quiet();
		const t = ctl.threads.find((x) => x.restore !== undefined && !x.resolved);
		if (!t) return;
		expect(await ctl.suggestions.reject(t), `rejecting ${JSON.stringify(t.anchor.quote)}`).toBe(true);
	}
	throw new Error('suggestions kept coming back');
}

async function acceptAllOn(ctl: Side['ctl'], s: Session) {
	for (let n = 0; n < 50; n++) {
		await s.quiet();
		const t = ctl.threads.find((x) => x.restore !== undefined && !x.resolved);
		if (!t) return;
		await ctl.suggestions.accept(t);
	}
	throw new Error('suggestions kept coming back');
}

it('a guest replaces, adds and deletes words; the host rejects them all and the file is exactly the original', async () => {
	const s = await session();
	const mei = await s.join('mei');
	await mei.mode('suggesting');
	mei.keys.replace('sharp', 'blunt');
	mei.keys.type('fully ', 'smooth');
	mei.keys.erase('We ');
	await agree(s, TEXT);
	expect(openSuggestions(s.host.ctl.threads)).toEqual([
		['mei', '', 'We '],
		['mei', 'blunt', 'sharp'],
		['mei', 'fully ', '']
	]);
	await rejectAllOn(s.host.ctl, s);
	await agree(s, TEXT);
	expect(s.host.text()).toBe(TEXT);
	expect(s.host.ctl.threads.map((t) => t.decision)).toEqual(['rejected', 'rejected', 'rejected']);
	expect(
		logged()
			.filter((e) => e.t === 'open')
			.map((e) => e.by)
	).toEqual(['mei', 'mei', 'mei']);
});

it('the host accepts what a guest suggested: the words stay and nothing is left open', async () => {
	const s = await session();
	const mei = await s.join('mei');
	await mei.mode('suggesting');
	mei.keys.replace('sharp', 'blunt');
	mei.keys.type('fully ', 'smooth');
	await agree(s, TEXT);
	const suggested = s.host.text();
	await acceptAllOn(s.host.ctl, s);
	await agree(s, suggested);
	expect(s.host.text()).toBe(suggested);
	expect(s.host.ctl.threads.map((t) => t.decision)).toEqual(['accepted', 'accepted']);
	expect(openSuggestions(mei.ctl.threads)).toEqual([]);
});

it('a guest rejects their own suggestion: the words come back and nothing new is suggested', async () => {
	const s = await session();
	const mei = await s.join('mei');
	await mei.mode('suggesting');
	mei.keys.replace('sharp', 'blunt');
	mei.keys.type('fully ', 'smooth');
	await agree(s, TEXT);
	const blunt = mei.ctl.threads.find((t) => t.restore === 'sharp')!;
	expect(await mei.ctl.suggestions.reject(blunt)).toBe(true);
	await agree(s, TEXT);
	expect(s.host.text()).toBe(TEXT.replace('smooth', 'fully smooth'));
	expect(openSuggestions(s.host.ctl.threads)).toEqual([['mei', 'fully ', '']]);
	expect(s.host.ctl.threads.find((t) => t.id === blunt.id)?.decision).toBe('rejected');
	expect(logged().filter((e) => e.t === 'open')).toHaveLength(2);
});

it('a guest accepts a suggestion someone else made', async () => {
	const s = await session();
	const mei = await s.join('mei');
	const ada = await s.join('ada');
	await mei.mode('suggesting');
	mei.keys.replace('sharp', 'blunt');
	await agree(s, TEXT);
	await acceptAllOn(ada.ctl, s);
	await agree(s, TEXT.replace('sharp', 'blunt'));
	expect(s.host.ctl.threads.map((t) => [t.decision, t.resolvedBy ?? null])).toEqual([['accepted', null]]);
});

it('a guest in Editing changes the file without suggesting anything, beside the host suggesting', async () => {
	const s = await session();
	const mei = await s.join('mei');
	await s.host.mode('suggesting');
	mei.keys.replace('sharp', 'blunt');
	s.host.keys.type('new ', 'estimator');
	const base = TEXT.replace('sharp', 'blunt');
	await agree(s, base);
	expect(openSuggestions(s.host.ctl.threads)).toEqual([['louis', 'new ', '']]);
});

it('the host and a guest both suggesting in one sentence at once each keep their own words', async () => {
	const s = await session();
	const mei = await s.join('mei');
	await s.host.mode('suggesting');
	await mei.mode('suggesting');
	const hostWords = 'new ';
	const guestWords = 'very ';
	for (let i = 0; i < 5; i++) {
		if (hostWords[i]) s.host.keys.type(hostWords[i], 'estimator');
		if (guestWords[i]) mei.keys.type(guestWords[i], 'smooth');
	}
	await agree(s, TEXT);
	expect(openSuggestions(s.host.ctl.threads)).toEqual([
		['louis', 'new ', ''],
		['mei', 'very ', '']
	]);
});

it('two guests suggesting in one sentence at once each keep their own words', async () => {
	const s = await session();
	const mei = await s.join('mei');
	const ada = await s.join('ada');
	await mei.mode('suggesting');
	await ada.mode('suggesting');
	for (let i = 0; i < 5; i++) {
		if ('new '[i]) mei.keys.type('new '[i], 'estimator');
		if ('very '[i]) ada.keys.type('very '[i], 'smooth');
	}
	await agree(s, TEXT);
	expect(openSuggestions(s.host.ctl.threads)).toEqual([
		['ada', 'very ', ''],
		['mei', 'new ', '']
	]);
	await rejectAllOn(ada.ctl, s);
	await agree(s, TEXT);
	expect(s.host.text()).toBe(TEXT);
});

it('a guest switching modes midway keeps what they typed before the switch in the mode they typed it in', async () => {
	const s = await session();
	const mei = await s.join('mei');
	await mei.mode('suggesting');
	mei.keys.type('new ', 'estimator');
	await mei.mode('editing');
	mei.keys.type('very ', 'smooth');
	await mei.mode('suggesting');
	mei.keys.erase('We ');
	const base = TEXT.replace('smooth', 'very smooth');
	await agree(s, base);
	expect(openSuggestions(s.host.ctl.threads)).toEqual([
		['mei', '', 'We '],
		['mei', 'new ', '']
	]);
});

it('a guest editing inside another guest suggestion changes it the way it would for one person', async () => {
	const s = await session();
	const mei = await s.join('mei');
	const ada = await s.join('ada');
	await mei.mode('suggesting');
	mei.keys.replace('sharp', 'blunt');
	await agree(s, TEXT);
	// ada, editing, rewrites the suggested word: the suggestion is gone and her word stands
	ada.keys.replace('blunt', 'loose');
	await agree(s, TEXT.replace('sharp', 'loose'));
	expect(openSuggestions(s.host.ctl.threads)).toEqual([]);
	expect(s.host.ctl.threads.map((t) => t.decision)).toEqual(['closed']);
});

it('a guest suggesting inside another guest suggestion takes it over and keeps the original words', async () => {
	const s = await session();
	const mei = await s.join('mei');
	const ada = await s.join('ada');
	await mei.mode('suggesting');
	await ada.mode('suggesting');
	mei.keys.replace('sharp', 'blunt');
	await agree(s, TEXT);
	ada.keys.replace('blunt', 'loose');
	await agree(s, TEXT);
	expect(openSuggestions(s.host.ctl.threads)).toEqual([['ada', 'loose', 'sharp']]);
	await rejectAllOn(s.host.ctl, s);
	await agree(s, TEXT);
	expect(s.host.text()).toBe(TEXT);
});

it('a guest undoing what they suggested withdraws it', async () => {
	const s = await session();
	const mei = await s.join('mei');
	await mei.mode('suggesting');
	mei.keys.type('new ', 'estimator');
	await agree(s, TEXT);
	mei.editor.undo.undo();
	await agree(s, TEXT);
	expect(s.host.text()).toBe(TEXT);
	expect(openSuggestions(s.host.ctl.threads)).toEqual([]);
	mei.editor.undo.redo();
	await agree(s, TEXT);
	expect(openSuggestions(s.host.ctl.threads)).toEqual([['mei', 'new ', '']]);
});

it('a guest retyping the words they deleted withdraws the deletion', async () => {
	const s = await session();
	const mei = await s.join('mei');
	await mei.mode('suggesting');
	mei.keys.erase('sharp ');
	await agree(s, TEXT);
	expect(openSuggestions(s.host.ctl.threads)).toEqual([['mei', '', 'sharp ']]);
	mei.keys.type('sharp ', 'for');
	await agree(s, TEXT);
	expect(openSuggestions(s.host.ctl.threads)).toEqual([]);
});

it('records a guest suggestion in a file the host does not have open, and places it when the host opens it', async () => {
	const s = await session({ text: TEXT, hostOpens: false });
	const mei = await s.join('mei');
	await mei.mode('suggesting');
	mei.keys.replace('sharp', 'blunt');
	await s.quiet();
	expect(openSuggestions(s.host.ctl.threads)).toEqual([['mei', 'blunt', 'sharp']]);
	expect(disk[FILE]).toBe(TEXT.replace('sharp', 'blunt'));
	const w = s.host.writes.find((x) => x.tex.includes('blunt'))!;
	expect(w.log.some((e) => e.t === 'open' && e.by === 'mei')).toBe(true);
	mei.keys.type('fully ', 'smooth');
	await s.quiet();
	s.host.open();
	await agree(s, TEXT);
	expect(openSuggestions(s.host.ctl.threads)).toEqual([
		['mei', 'blunt', 'sharp'],
		['mei', 'fully ', '']
	]);
});

it('every write of a guest suggestion has the log entries for it on disk first', async () => {
	const s = await session();
	const mei = await s.join('mei');
	await mei.mode('suggesting');
	for (const word of ['new ', 'very ', 'quite ']) {
		mei.keys.type(word, 'estimator');
		await s.quiet();
	}
	for (const w of s.host.writes) {
		const opened = w.log.filter((e) => e.t === 'open').length;
		const words = ['new ', 'very ', 'quite '].filter(
			(x) => w.tex.includes(x + 'estimator') || w.tex.includes(x + 'new') || w.tex.includes(x + 'very')
		).length;
		expect(opened, JSON.stringify(w.tex)).toBeGreaterThanOrEqual(words > 0 ? 1 : 0);
	}
	await agree(s, TEXT);
});

it('an older host that never says it records: a guest is not offered Suggesting', async () => {
	const s = await session({ text: TEXT, hostAdvertises: false });
	const mei = await s.join('mei');
	await s.quiet();
	expect(mei.hostRecords()).toBe(false);
	const s2 = await startSession({ text: TEXT });
	try {
		const ada = await s2.join('ada');
		await s2.quiet();
		expect(ada.hostRecords()).toBe(true);
	} finally {
		s2.close();
	}
});

it('a guest joining late draws the suggestions already made', async () => {
	const s = await session();
	const mei = await s.join('mei');
	await mei.mode('suggesting');
	mei.keys.replace('sharp', 'blunt');
	await agree(s, TEXT);
	await s.join('ada');
	await agree(s, TEXT);
});

it('a guest who drops off and comes back has their offline suggestions recorded, and the deleted words kept', async () => {
	const s = await session();
	const mei = await s.join('mei');
	await mei.mode('suggesting');
	await s.quiet();
	mei.away();
	mei.keys.erase('smooth ');
	mei.keys.type('new ', 'estimator');
	mei.back();
	await agree(s, TEXT);
	expect(openSuggestions(s.host.ctl.threads).map((x) => x[0])).toEqual(['mei', 'mei']);
});
