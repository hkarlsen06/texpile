// text whose line ends the items cannot stand for, so its paragraph is left to the browser

// tabs and line feeds take a width that depends on where they land; right to left text reorders
const PLACED_BY_LAYOUT = /[\t\n\r\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufeff]/;
// these scripts end a line between any two characters, by rules the browser knows (no comma at a line start, word
// lists for Thai). Held to its spaces, a Chinese line with an English term in it is spread out character by character
const ENDS_LINES_WITHOUT_SPACES =
	/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Bopomofo}\p{Script=Hangul}\p{Script=Yi}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}\p{Script=Tibetan}\u3000-\u303f\uff00-\uffef]/u;

export function isUnmodeledText(text: string): boolean {
	return PLACED_BY_LAYOUT.test(text) || ENDS_LINES_WITHOUT_SPACES.test(text);
}
