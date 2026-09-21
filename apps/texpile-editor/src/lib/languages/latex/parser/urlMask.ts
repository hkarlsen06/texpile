// \url and \href take their URL verbatim, but unified-latex tokenizes the argument like prose: a %
// starts a comment that swallows the closing brace, a # is a parameter token. The URL argument is
// masked to same-length placeholders before the parse (positions stay valid for the span capture)
// and every string in the AST is unmasked after it.
const PERCENT = '';
const HASH = '';

const URL_MACRO = /\\(?:url|href)\{/g;

export function maskUrlSpecials(src: string): string {
	if (!src.includes('%') && !src.includes('#')) return src;
	let out = '';
	let last = 0;
	URL_MACRO.lastIndex = 0;
	for (let m = URL_MACRO.exec(src); m; m = URL_MACRO.exec(src)) {
		if (m.index > 0 && src[m.index - 1] === '\\') continue; // \\url is a line break then text
		const start = m.index + m[0].length;
		let depth = 1;
		let j = start;
		while (j < src.length && depth > 0) {
			const c = src[j];
			if (c === '{') depth++;
			else if (c === '}') depth--;
			j++;
		}
		if (depth > 0) break; // unterminated: leave the rest alone
		out +=
			src.slice(last, start) +
			src
				.slice(start, j - 1)
				.replace(/%/g, PERCENT)
				.replace(/#/g, HASH);
		last = j - 1;
		URL_MACRO.lastIndex = j;
	}
	return out + src.slice(last);
}

export function unmaskUrlSpecials(node: unknown): void {
	if (!node || typeof node !== 'object') return;
	if (Array.isArray(node)) {
		for (const kid of node) unmaskUrlSpecials(kid);
		return;
	}
	const n = node as { content?: unknown; args?: unknown };
	if (typeof n.content === 'string') {
		if (n.content.includes(PERCENT) || n.content.includes(HASH)) n.content = n.content.replace(//g, '%').replace(//g, '#');
	} else unmaskUrlSpecials(n.content);
	unmaskUrlSpecials(n.args);
}
