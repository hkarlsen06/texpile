// What an agent's rewrite may not do to LaTeX: cite a source the paper does not have, or lose a label
import type { AnchorDialect } from '$lib/comments/anchor';

const CITE = /\\[A-Za-z]*cite[A-Za-z]*\*?\s*(?:\[[^\]]*\]\s*){0,2}\{([^}]*)\}/g;
const BIBITEM = /\\bibitem\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g;
const LABEL = /\\label\s*\{([^}]*)\}/g;

export type AgentEditProblem = { invented: string[] } | { lost: string[] };

function keysOf(text: string, pattern: RegExp): string[] {
	return [...text.matchAll(pattern)].flatMap((m) =>
		m[1]
			.split(',')
			.map((k) => k.trim())
			.filter(Boolean)
	);
}

/** the citation keys a rewrite may use: the .bib's, and any the file already cites or defines */
export function knownCiteKeys(fileText: string, bibKeys: string[]): Set<string> {
	return new Set([...bibKeys, ...keysOf(fileText, CITE), ...keysOf(fileText, BIBITEM)]);
}

/** what is wrong with `after` replacing `before`, or null when nothing is */
export function agentEditProblem(dialect: AnchorDialect, before: string, after: string, known: Set<string>): AgentEditProblem | null {
	if (dialect !== 'tex') return null;
	const cited = new Set(keysOf(before, CITE));
	const invented = [...new Set(keysOf(after, CITE))].filter((k) => !cited.has(k) && !known.has(k));
	if (invented.length) return { invented };
	const kept = new Set(keysOf(after, LABEL));
	const lost = keysOf(before, LABEL).filter((l) => !kept.has(l));
	return lost.length ? { lost } : null;
}
