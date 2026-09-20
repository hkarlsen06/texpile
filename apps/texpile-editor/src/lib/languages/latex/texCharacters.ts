// the characters LaTeX's accent and symbol commands print

/** accent command name to the combining mark it puts over (or under) its letter */
export const ACCENTS: Record<string, string> = {
	"'": '́',
	'`': '̀',
	'^': '̂',
	'"': '̈',
	'~': '̃',
	'=': '̄',
	'.': '̇',
	u: '̆',
	v: '̌',
	H: '̋',
	r: '̊',
	c: '̧',
	k: '̨',
	d: '̣',
	b: '̱',
	t: '͡'
};

/** symbol commands that take no argument, to what they print */
export const SYMBOLS: Record<string, string> = {
	S: '§',
	P: '¶',
	AA: 'Å',
	aa: 'å',
	ss: 'ß',
	SS: 'SS',
	o: 'ø',
	O: 'Ø',
	ae: 'æ',
	AE: 'Æ',
	oe: 'œ',
	OE: 'Œ',
	l: 'ł',
	L: 'Ł',
	i: 'ı',
	j: 'ȷ',
	dag: '†',
	ddag: '‡',
	dh: 'ð',
	DH: 'Ð',
	th: 'þ',
	TH: 'Þ',
	ng: 'ŋ',
	NG: 'Ŋ',
	copyright: '©',
	textcopyright: '©',
	textregistered: '®',
	texttrademark: '™',
	pounds: '£',
	textsterling: '£',
	euro: '€',
	texteuro: '€',
	textyen: '¥',
	textcent: '¢',
	ldots: '…',
	dots: '…',
	textellipsis: '…',
	textbackslash: '\\',
	textasciitilde: '~',
	textasciicircum: '^',
	textbar: '|',
	textbullet: '•',
	textperiodcentered: '·',
	textdegree: '°',
	textless: '<',
	textgreater: '>',
	textquotedbl: '"',
	textquotesingle: "'",
	textquoteleft: '‘',
	textquoteright: '’',
	textquotedblleft: '“',
	textquotedblright: '”',
	textendash: '–',
	textemdash: '—',
	textexclamdown: '¡',
	textquestiondown: '¿',
	guillemotleft: '«',
	guillemotright: '»',
	guilsinglleft: '‹',
	guilsinglright: '›',
	textsection: '§',
	textparagraph: '¶',
	textdagger: '†',
	textdaggerdbl: '‡',
	textmu: 'µ',
	textonehalf: '½',
	textonequarter: '¼',
	textthreequarters: '¾',
	textpm: '±',
	texttimes: '×',
	textdiv: '÷',
	textminus: '−',
	checkmark: '✓',
	textdollar: '$',
	textunderscore: '_',
	textbraceleft: '{',
	textbraceright: '}',
	LaTeX: 'LaTeX',
	LaTeXe: 'LaTeX2ε',
	TeX: 'TeX',
	BibTeX: 'BibTeX'
};

/** the letter an accent's argument names: a letter, or a dotless i or j */
export function accentBase(argument: string): string | null {
	const t = argument.trim();
	if (/^\\i$/.test(t)) return 'ı';
	if (/^\\j$/.test(t)) return 'ȷ';
	if (/^\p{L}$/u.test(t)) return t;
	return null;
}

/** the accented letter as one character where Unicode has one */
export function accented(accent: string, base: string): string {
	return (base + ACCENTS[accent]).normalize('NFC');
}

// an accent's letter: a letter accent (\v) ends at a space or a brace, as TeX reads it
const ACCENT_LETTER = /^\s*\{([^{}]*)\}|^\s+(\\[ij](?![a-zA-Z])|\p{L})/u;
const SYMBOL_ACCENT_LETTER = /^\s*\{([^{}]*)\}|^\s*(\\[ij](?![a-zA-Z])|\p{L})/u;

/** the accented letter or symbol the command whose backslash is at `at` prints, and where the command ends */
export function readTexCharacter(s: string, at: number): { text: string; end: number } | null {
	const name = /^(?:[a-zA-Z]+|[^a-zA-Z\s])/.exec(s.slice(at + 1, at + 32))?.[0];
	if (!name) return null;
	let i = at + 1 + name.length;
	if (Object.hasOwn(SYMBOLS, name)) {
		if (s.startsWith('{}', i)) i += 2;
		else while (s[i] === ' ') i++;
		return { text: SYMBOLS[name], end: i };
	}
	if (!Object.hasOwn(ACCENTS, name)) return null;
	const letter = (/[a-zA-Z]/.test(name) ? ACCENT_LETTER : SYMBOL_ACCENT_LETTER).exec(s.slice(i));
	const base = letter && accentBase(letter[1] ?? letter[2]);
	return base ? { text: accented(name, base), end: i + letter[0].length } : null;
}
