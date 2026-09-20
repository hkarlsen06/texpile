// a suggestion is a comment thread carrying the words it took out
import type { CommentThread } from './log';
import type { AnchorDialect } from './anchorNormalize';
import { renderSource } from './renderedWords';

export type SuggestionKind = 'replace' | 'insert' | 'delete';

/** the same words with other formatting; `added` and `removed` name what changed, when the words say */
export type FormatChange = { words: string; added: string[]; removed: string[] };

const FORMAT_TAGS = new Map([
	['strong', 'bold'],
	['em', 'italic'],
	['u', 'underline'],
	['code', 'code'],
	['sup', 'superscript'],
	['sub', 'subscript'],
	['s', 'strikethrough'],
	['a', 'link']
]);

// formatting that leaves no tag on the words, told from the source instead
const TEX_MARKERS: [RegExp, string][] = [
	[/\\textcolor\b/, 'color'],
	[/\\hl\{/, 'highlight']
];

function formats(source: string, dialect: AnchorDialect) {
	const rendered = renderSource(source, dialect);
	if (!rendered) return null;
	const names = new Set<string>();
	for (const run of rendered.words.flat()) for (const tag of run.tags) if (FORMAT_TAGS.has(tag)) names.add(FORMAT_TAGS.get(tag)!);
	if (dialect === 'tex') for (const [marker, name] of TEX_MARKERS) if (marker.test(source)) names.add(name);
	const text = rendered.words
		.map((p) =>
			p
				.map((run) => run.text)
				.join('')
				.trim()
		)
		.filter(Boolean)
		.join('\n');
	return { text, names, balance: rendered.closed.join() + '|' + rendered.open.join(), chips: !!rendered.chips };
}

export function formatChange(quote: string, restore: string, dialect: AnchorDialect): FormatChange | null {
	if (!quote || !restore) return null;
	const fresh = formats(quote, dialect);
	const gone = formats(restore, dialect);
	if (!fresh || !gone || !fresh.text || fresh.text !== gone.text || fresh.balance !== gone.balance) return null;
	// \'e written as é is another spelling of the letter, not other formatting
	if (fresh.chips !== gone.chips && !fresh.names.size && !gone.names.size) return null;
	const only = (a: Set<string>, b: Set<string>) => [...a].filter((name) => !b.has(name));
	return { words: fresh.text, added: only(fresh.names, gone.names), removed: only(gone.names, fresh.names) };
}

export function isSuggestion(t: CommentThread): boolean {
	return t.restore !== undefined;
}

export function isOpenSuggestion(t: CommentThread): boolean {
	return isSuggestion(t) && !t.resolved;
}

export function suggestionKind(quote: string, restore: string): SuggestionKind {
	if (quote && restore) return 'replace';
	return quote ? 'insert' : 'delete';
}

export function suggestionAuthor(t: CommentThread): string {
	return t.messages[0]?.by ?? '';
}

export function spotRanks(placed: { id: string; from: number; to: number }[]): Map<string, number> {
	const ranks = new Map<string, number>();
	for (let i = 0; i < placed.length;) {
		let j = i;
		while (j < placed.length && placed[j].from === placed[i].from && placed[j].to === placed[j].from) j++;
		if (j - i > 1) for (let k = i; k < j; k++) ranks.set(placed[k].id, k - i);
		i = Math.max(j, i + 1);
	}
	return ranks;
}

export function shownWords(words: string): string {
	if (!words || /\S/.test(words)) return words;
	return words.replace(/\n/g, '↵').replace(/\t/g, '⇥').replace(/ /g, '·');
}
