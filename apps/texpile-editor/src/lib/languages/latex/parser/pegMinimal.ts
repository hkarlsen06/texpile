// the LaTeX tokenizer: unified-latex's own grammar, vendored without its result memo (see
// scripts/strip-peg-memo.mjs). Same tokens, byte for byte, in less than half the time and a
// fraction of the heap: the memo held about 1.5 KB per source byte until the parse returned
import type * as Ast from '@unified-latex/unified-latex-types';
import { parse } from './vendor/latexPegMemoFree.js';

/** the minimal parse of `source`: the token stream, environments and math found, nothing attached */
export function parseMinimal(source: string): Ast.Root {
	return parse(source) as Ast.Root;
}
