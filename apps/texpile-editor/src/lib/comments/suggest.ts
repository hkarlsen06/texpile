// a suggestion is a comment thread carrying the words it took out
import type { CommentThread } from './log';

export type SuggestionKind = 'replace' | 'insert' | 'delete';

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
