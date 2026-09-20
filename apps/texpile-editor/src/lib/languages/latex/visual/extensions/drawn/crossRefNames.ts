// the words \cref, \Cref and \autoref print before a number: the packages' own defaults, then what the preamble renames

export type CrossRefNames = {
	/** cleveref's \crefname: counter to [singular, plural] */
	cref: Record<string, [string, string]>;
	/** cleveref's \Crefname */
	Cref: Record<string, [string, string]>;
	/** hyperref's \<counter>autorefname */
	autoref: Record<string, string>;
};

const CREF: Record<string, [string, string]> = {
	equation: ['eq.', 'eqs.'],
	figure: ['fig.', 'figs.'],
	subfigure: ['fig.', 'figs.'],
	table: ['table', 'tables'],
	subtable: ['table', 'tables'],
	page: ['page', 'pages'],
	part: ['part', 'parts'],
	chapter: ['chapter', 'chapters'],
	section: ['section', 'sections'],
	subsection: ['section', 'sections'],
	subsubsection: ['section', 'sections'],
	paragraph: ['paragraph', 'paragraphs'],
	appendix: ['appendix', 'appendices'],
	subappendix: ['appendix', 'appendices'],
	enumi: ['item', 'items'],
	enumii: ['item', 'items'],
	enumiii: ['item', 'items'],
	footnote: ['footnote', 'footnotes'],
	theorem: ['theorem', 'theorems'],
	lemma: ['lemma', 'lemmas'],
	corollary: ['corollary', 'corollaries'],
	proposition: ['proposition', 'propositions'],
	definition: ['definition', 'definitions'],
	result: ['result', 'results'],
	example: ['example', 'examples'],
	remark: ['remark', 'remarks'],
	note: ['note', 'notes'],
	algorithm: ['algorithm', 'algorithms'],
	listing: ['listing', 'listings'],
	line: ['line', 'lines']
};

// only equations and figures are abbreviated, and noabbrev spells them out
const UNABBREVIATED: Record<string, [string, string]> = {
	equation: ['equation', 'equations'],
	figure: ['figure', 'figures'],
	subfigure: ['figure', 'figures']
};

const AUTOREF: Record<string, string> = {
	equation: 'Equation',
	footnote: 'footnote',
	item: 'item',
	enumi: 'item',
	figure: 'Figure',
	table: 'Table',
	part: 'Part',
	appendix: 'Appendix',
	chapter: 'chapter',
	section: 'section',
	subsection: 'subsection',
	subsubsection: 'subsubsection',
	paragraph: 'paragraph',
	subparagraph: 'subparagraph',
	theorem: 'Theorem',
	page: 'page'
};

function capitalised(word: string): string {
	return word.charAt(0).toUpperCase() + word.slice(1);
}

function capitalisedPair([one, many]: [string, string]): [string, string] {
	return [capitalised(one), capitalised(many)];
}

// \crefname{figure}{Fig.}{Figs.}, with any spacing
const CREFNAME = /\\(crefname|Crefname)\s*\{([^{}]+)\}\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g;
// \renewcommand{\sectionautorefname}{Section}, \def\sectionautorefname{Section}, and the starred and braceless forms
const AUTOREFNAME = /\\(?:(?:re)?newcommand\*?|providecommand\*?|def)\s*\{?\s*\\([a-zA-Z]+)autorefname\s*\}?\s*\{([^{}]*)\}/g;
const CLEVEREF_OPTIONS = /\\usepackage\s*\[([^\]]*)\]\s*\{cleveref\}/;

export function crossRefNamesFromPreamble(preamble: string): CrossRefNames {
	const options =
		CLEVEREF_OPTIONS.exec(preamble)?.[1]
			.split(',')
			.map((o) => o.trim()) ?? [];
	const base: Record<string, [string, string]> = { ...CREF, ...(options.includes('noabbrev') ? UNABBREVIATED : {}) };
	const capital = Object.fromEntries(Object.entries({ ...CREF, ...UNABBREVIATED }).map(([k, v]) => [k, capitalisedPair(v)]));
	const cref = options.includes('capitalise') || options.includes('capitalize') ? { ...capital } : base;
	const Cref: Record<string, [string, string]> = { ...capital };
	const autoref: Record<string, string> = { ...AUTOREF };
	const renamed = new Set<string>();
	for (const m of preamble.matchAll(CREFNAME)) {
		const pair: [string, string] = [m[3].trim(), m[4].trim()];
		if (m[1] === 'crefname') {
			cref[m[2]] = pair;
			if (!renamed.has(m[2])) Cref[m[2]] = capitalisedPair(pair);
		} else {
			Cref[m[2]] = pair;
			renamed.add(m[2]);
		}
	}
	for (const m of preamble.matchAll(AUTOREFNAME)) autoref[m[1]] = m[2].trim();
	return { cref, Cref, autoref };
}

export const DEFAULT_CROSS_REF_NAMES = crossRefNamesFromPreamble('');
