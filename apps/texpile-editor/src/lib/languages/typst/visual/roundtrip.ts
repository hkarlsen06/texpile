// the .typ file IS the document, same fidelity model as latexRoundtrip and the markdown side.
// Typst has no preamble/frontmatter split: code-mode preludes (#import/#set/#show) are ordinary
// top-level raw blocks, preserved verbatim by the orig machinery like every other block. The
// ParsedLatexFile shape is reused wholesale so the buffer/worker/view plumbing needs no parallel
// types: preamble = '', postamble = '', hadDocumentEnv = false.
import { typstToProseMirror } from './converter';
import { serializeToTypstDetailed, serializeTypNode } from './serializer';
import { fillOrigNorms } from '$lib/serializer/blockAssembly';
import { padTables } from '$lib/editor/visual/padTables';
import { collectMap, rememberParseMap, shiftMap, type RegionParse, type SourceMap } from '$lib/editor/visual/sourceSpans';
import type { Node } from 'prosemirror-model';
import type { ParsedLatexFile, ParsePhase } from '$lib/workspace/latexRoundtrip';

export function parseTypstFile(source: string, _projectMacros = '', onPhase?: (phase: ParsePhase) => void): ParsedLatexFile {
	onPhase?.('parsing');
	const { doc: parsedDoc } = typstToProseMirror(source);
	onPhase?.('finalizing');
	const doc = fillOrigNorms(padTables(parsedDoc), serializeTypNode);

	if (import.meta.env.DEV) {
		try {
			doc.check();
		} catch (e) {
			console.error('[typstRoundtrip] parsed doc violates the schema content model:', e);
		}
	}

	const map = collectMap(doc, 0);
	rememberParseMap(doc, map);
	return { preamble: '', postamble: '', doc, hadDocumentEnv: false, warnings: [], map };
}

/** a stretch of the file parsed as the file is, for a comparison; the map's offsets are the stretch's own */
export function parseTypstRegion(source: string): RegionParse {
	const doc = padTables(typstToProseMirror(source).doc);
	return { doc, map: collectMap(doc, 0) };
}

/** Serializes back to .typ (a protected tail reproduces the exact original trailing bytes,
 *  including a missing final newline). A file that opened with a BOM keeps it. */
export function serializeTypstFile(parsed: Pick<ParsedLatexFile, 'preamble' | 'postamble' | 'hadDocumentEnv'>, doc: Node): string {
	return serializeTypstFileDetailed(parsed, doc).text;
}

/** the file text and where every run of `doc` landed in it */
export function serializeTypstFileDetailed(
	_parsed: Pick<ParsedLatexFile, 'preamble' | 'postamble' | 'hadDocumentEnv'>,
	doc: Node
): { text: string; map: SourceMap } {
	const { text: body, tailProtected, map } = serializeToTypstDetailed(doc);
	const file = doc.attrs.typFile as { bom?: boolean; eol?: string } | null;
	const eol = file?.eol === '\r\n' ? '\r\n' : '\n';
	const withTail = body + (tailProtected ? '' : eol);
	const bom = file?.bom && !withTail.startsWith('\uFEFF') ? '\uFEFF' : '';
	return { text: bom + withTail, map: shiftMap(map, bom.length, bom.length + body.length) };
}
