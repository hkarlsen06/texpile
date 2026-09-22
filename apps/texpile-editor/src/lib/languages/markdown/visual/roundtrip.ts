// the .md file IS the document, same fidelity model as latexRoundtrip: opening splits the
// frontmatter (preserved verbatim, the markdown "preamble") from the body and parses only the
// body; saving regenerates only the body and splices it back. The ParsedLatexFile shape is
// reused wholesale so the buffer/worker/view plumbing needs no parallel types: preamble =
// byte order mark + frontmatter, postamble = '', hadDocumentEnv = has a preamble.
import { markdownToProseMirror } from './converter';
import { serializeToMarkdownDetailed } from './serializer';
import { padTables } from '$lib/editor/visual/padTables';
import {
	collectMap,
	mapToCrlf,
	rememberParseMap,
	shiftMap,
	warnMapDefects,
	type RegionParse,
	type SourceMap
} from '$lib/editor/visual/sourceSpans';
import type { Node } from 'prosemirror-model';
import { parseBodyOf, type ParsedLatexFile, type ParsePhase } from '$lib/workspace/latexRoundtrip';

const BOM = String.fromCharCode(0xfeff);
const EOL = '(?:\\r\\n|\\r|\\n)';
// closing fence kept in the preamble WITHOUT its trailing newline (mirrors \begin{document}), so
// the body's leading gap lands in the first block's `pre` and pristine saves stay byte-exact
const YAML = new RegExp(`^---[ \\t]*${EOL}(?:([\\s\\S]*?)${EOL})?(?:---|\\.\\.\\.)[ \\t]*(?=${EOL}|$)`);
const TOML = new RegExp(`^\\+\\+\\+[ \\t]*${EOL}(?:([\\s\\S]*?)${EOL})?\\+\\+\\+[ \\t]*(?=${EOL}|$)`);
// a `key:` (or `key =`) line is what tells metadata from a document that opens with a
// thematic break
const YAML_KEY = /^[ \t]*[^\s#-][^\r\n]*?:(?:[ \t\r]|$)/m;
const TOML_KEY = /^[ \t]*(?:[\w."'-]+[ \t]*=|\[)/m;

function isMetadata(inner: string | undefined, key: RegExp): boolean {
	return !inner || inner.trim() === '' || key.test(inner);
}

function frontmatterLength(text: string): number {
	const yaml = YAML.exec(text);
	if (yaml) return isMetadata(yaml[1], YAML_KEY) ? yaml[0].length : 0;
	const toml = TOML.exec(text);
	if (toml) return isMetadata(toml[1], TOML_KEY) ? toml[0].length : 0;
	return 0;
}

export function parseMarkdownFile(markdown: string, _projectMacros = '', onPhase?: (phase: ParsePhase) => void): ParsedLatexFile {
	onPhase?.('parsing');
	const bom = markdown.startsWith(BOM) ? BOM : '';
	const text = markdown.slice(bom.length);
	const preamble = bom + text.slice(0, frontmatterLength(text));
	const body = markdown.slice(preamble.length);
	const { doc: parsedDoc } = markdownToProseMirror(body);
	onPhase?.('finalizing');
	const doc = padTables(parsedDoc);

	if (import.meta.env.DEV) {
		try {
			doc.check();
		} catch (e) {
			console.error('[markdownRoundtrip] parsed doc violates the schema content model:', e);
		}
	}

	const map = collectMap(doc, preamble.length);
	const meta = { preamble, postamble: '', hadDocumentEnv: preamble.length > 0 };
	const origins = rememberParseMap(doc, map, parseBodyOf(meta, markdown));
	warnMapDefects('markdownRoundtrip', origins);
	return { ...meta, doc, warnings: [], map, origins };
}

/** a stretch of the body parsed as the file is, for a comparison; the map's offsets are the stretch's own */
export function parseMarkdownRegion(body: string): RegionParse {
	const doc = padTables(markdownToProseMirror(body).doc);
	return { doc, map: collectMap(doc, 0) };
}

/** Serializes back to .md, preserving the frontmatter and regenerating only the body. */
export function serializeMarkdownFile(parsed: Pick<ParsedLatexFile, 'preamble' | 'postamble' | 'hadDocumentEnv'>, doc: Node): string {
	return serializeMarkdownFileDetailed(parsed, doc).text;
}

/** the file text and where every run of `doc` landed in it */
export function serializeMarkdownFileDetailed(
	parsed: Pick<ParsedLatexFile, 'preamble' | 'postamble' | 'hadDocumentEnv'> & Partial<Pick<ParsedLatexFile, 'origins'>>,
	doc: Node,
	afresh?: ReadonlySet<Node>
): { text: string; map: SourceMap } {
	const { text: body, leadProtected, tailProtected, map } = serializeToMarkdownDetailed(doc, parsed.origins ?? null, afresh);
	const tail = tailProtected ? '' : '\n';
	const bom = parsed.preamble.startsWith(BOM) ? BOM : '';
	const frontmatter = parsed.preamble.slice(bom.length);
	let out: string;
	let prefix: string;
	// no frontmatter: the body IS the file (a protected tail reproduces the exact original
	// trailing bytes, including a missing final newline)
	if (!frontmatter) {
		prefix = bom;
		out = bom + body + tail;
	} else if (!body) {
		prefix = parsed.preamble;
		out = parsed.preamble + '\n'; // frontmatter-only file: don't grow blank lines per save
	} else {
		prefix = `${parsed.preamble}${leadProtected ? '' : '\n\n'}`;
		out = `${prefix}${body}${tail}`;
	}
	const shifted = shiftMap(map, prefix.length, prefix.length + body.length);
	if (doc.attrs.eol !== '\r\n') return { text: out, map: shifted };
	return { text: out.replace(/\r?\n/g, '\r\n'), map: mapToCrlf(shifted, out) };
}
