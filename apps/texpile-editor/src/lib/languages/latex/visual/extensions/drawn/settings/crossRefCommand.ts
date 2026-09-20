// a cross-reference as its settings, the command and its labels
export type CrossRefCommand = { name: string; star: boolean; labels: string };

const CROSS_REF = /^(\s*\\)(ref|eqref|pageref|cref|Cref|autoref|nameref)(\*?)\{([^{}]*)\}(\s*)$/;
// \eqref takes no star
const STARRED = new Set(['ref', 'pageref', 'cref', 'Cref', 'autoref', 'nameref']);

export function readCrossRef(source: string): CrossRefCommand | null {
	const match = CROSS_REF.exec(source);
	return match ? { name: match[2], star: match[3] === '*', labels: match[4] } : null;
}

export function writeCrossRef(source: string, next: CrossRefCommand): string {
	const star = next.star && STARRED.has(next.name) ? '*' : '';
	return source.replace(CROSS_REF, (_, lead: string, ...rest: string[]) => `${lead}${next.name}${star}{${next.labels}}${rest[3]}`);
}

export function labelList(labels: string): string[] {
	return labels
		.split(',')
		.map((label) => label.trim())
		.filter(Boolean);
}
