// maps markdown-it's line-based token positions back to source offsets for block span capture
import type { Token } from 'markdown-it';

export type Cap = {
	source: string;
	lineStarts: number[];
	prevEnd: number;
};

// markdown-it turns \r\n and a bare \r into \n before it numbers lines, so the table has to
// count line breaks the same way
export function buildLineStarts(source: string): number[] {
	const starts = [0];
	for (let i = 0; i < source.length; i++) {
		const ch = source[i];
		if (ch === '\r' && source[i + 1] === '\n') i++;
		else if (ch !== '\r' && ch !== '\n') continue;
		starts.push(i + 1);
	}
	return starts;
}

export function offsetOfLine(cap: Cap, line: number): number {
	return line < cap.lineStarts.length ? cap.lineStarts[line] : cap.source.length;
}

/** byte just past the construct's last line, excluding that line's own line break (the break
 *  is inter-block gap and belongs to the next block's `pre`). */
export function sliceEnd(cap: Cap, endLine: number): number {
	let end = offsetOfLine(cap, endLine);
	if (end > 0 && cap.source[end - 1] === '\n') end--;
	if (end > 0 && cap.source[end - 1] === '\r') end--;
	return end;
}

/** `end` pulled back over trailing blank lines: a list token's map runs past the blank lines
 *  after it, and those are gap, not list. */
export function trimBlankTail(source: string, min: number, end: number): number {
	let e = end;
	while (e > min) {
		let lineStart = e;
		while (lineStart > min && source[lineStart - 1] !== '\n' && source[lineStart - 1] !== '\r') lineStart--;
		if (source.slice(lineStart, e).trim() !== '') break;
		e = lineStart;
		if (e > min && source[e - 1] === '\n') e--;
		if (e > min && source[e - 1] === '\r') e--;
	}
	return e;
}

/** index of the token closing the construct opened at `i`; `i` itself for self-closed tokens. */
export function constructEnd(tokens: Token[], i: number): number {
	if (tokens[i].nesting !== 1) return i;
	let depth = 0;
	for (let k = i; k < tokens.length; k++) {
		depth += tokens[k].nesting;
		if (depth === 0) return k;
	}
	return tokens.length - 1; // unbalanced stream: consume to the end rather than loop
}
