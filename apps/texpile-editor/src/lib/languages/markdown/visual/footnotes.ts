/* eslint no-param-reassign: "off" -- markdown-it rules advance parsing by mutating state.pos/state.line; that is the API */
// GFM footnotes as verbatim islands: a `[^label]: text` definition is one raw block and a
// `[^label]` reference an inline chip, so neither is read as a link nor escaped into brackets
import type { MarkdownIt, StateBlock, StateInline } from 'markdown-it';

const DEFINITION = /^\[\^([^\s\]]+)\]:/;
const REFERENCE = /^\[\^([^\s\]]+)\]/;

function footnoteDefinition(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
	if (state.sCount[startLine] - state.blkIndent >= 4) return false;
	const start = state.bMarks[startLine] + state.tShift[startLine];
	const m = DEFINITION.exec(state.src.slice(start, state.eMarks[startLine]));
	if (!m) return false;
	if (silent) return true;

	const terminators = state.md.block.ruler.getRules('paragraph');
	const oldParentType = state.parentType;
	state.parentType = 'paragraph';
	let next = startLine + 1;
	for (;;) {
		// lazy continuation, the paragraph rule's own test
		for (; next < endLine && !state.isEmpty(next); next++) {
			if (state.sCount[next] - state.blkIndent > 3 || state.sCount[next] < 0) continue;
			let terminate = false;
			for (const rule of terminators) {
				if (rule(state, next, endLine, true)) {
					terminate = true;
					break;
				}
			}
			if (terminate) break;
		}
		// past a blank line only an indented block still belongs to the footnote
		const after = state.skipEmptyLines(next);
		if (after === next || after >= endLine || state.sCount[after] - state.blkIndent < 4) break;
		next = after;
	}
	state.parentType = oldParentType;

	const token = state.push('footnote_definition', '', 0);
	token.map = [startLine, next];
	token.content = state.getLines(startLine, next, state.blkIndent, false);
	token.meta = { label: m[1] };
	state.line = next;
	return true;
}

// a chip whether or not its definition is in the file: deleting the definition leaves the reference as it was drawn,
// and bringing the definition back makes it a footnote again. As plain text it would be escaped into \[^label\]
function footnoteReference(state: StateInline, silent: boolean): boolean {
	if (state.src.charCodeAt(state.pos) !== 0x5b) return false;
	const m = REFERENCE.exec(state.src.slice(state.pos, Math.min(state.posMax, state.pos + 200)));
	// `[^x](url)` is a link whose text starts with a caret
	if (!m || state.src.charCodeAt(state.pos + m[0].length) === 0x28) return false;
	if (!silent) {
		const token = state.push('footnote_reference', '', 0);
		token.content = m[0];
		token.meta = { label: m[1] };
	}
	state.pos += m[0].length;
	return true;
}

export function footnotePlugin(md: MarkdownIt): void {
	md.block.ruler.before('reference', 'footnote_definition', footnoteDefinition, { alt: ['paragraph', 'reference'] });
	md.inline.ruler.before('link', 'footnote_reference', footnoteReference);
}
