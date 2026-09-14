// the .md file IS the document, same fidelity model as latexRoundtrip: opening splits the
// frontmatter (preserved verbatim, the markdown "preamble") from the body and parses only the
// body; saving regenerates only the body and splices it back. The ParsedLatexFile shape is
// reused wholesale so the buffer/worker/view plumbing needs no parallel types: preamble =
// byte order mark + frontmatter, postamble = '', hadDocumentEnv = has a preamble.
import { markdownToProseMirror } from './converter';
import { serializeToMarkdownDetailed, serializeMdNode } from './serializer';
import { fillOrigNorms } from '$lib/serializer/blockAssembly';
import { padTables } from '$lib/editor/visual/padTables';
import type { Node } from 'prosemirror-model';
import type { ParsedLatexFile, ParsePhase } from '$lib/workspace/latexRoundtrip';

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
	const doc = fillOrigNorms(padTables(parsedDoc), serializeMdNode);

	if (import.meta.env.DEV) {
		try {
			doc.check();
		} catch (e) {
			console.error('[markdownRoundtrip] parsed doc violates the schema content model:', e);
		}
	}

	return { preamble, postamble: '', doc, hadDocumentEnv: preamble.length > 0, warnings: [] };
}

/** Serializes back to .md, preserving the frontmatter and regenerating only the body. */
export function serializeMarkdownFile(parsed: Pick<ParsedLatexFile, 'preamble' | 'postamble' | 'hadDocumentEnv'>, doc: Node): string {
	const { text: body, leadProtected, tailProtected } = serializeToMarkdownDetailed(doc);
	const tail = tailProtected ? '' : '\n';
	const bom = parsed.preamble.startsWith(BOM) ? BOM : '';
	const frontmatter = parsed.preamble.slice(bom.length);
	let out: string;
	// no frontmatter: the body IS the file (a protected tail reproduces the exact original
	// trailing bytes, including a missing final newline)
	if (!frontmatter) out = bom + body + tail;
	else if (!body)
		out = parsed.preamble + '\n'; // frontmatter-only file: don't grow blank lines per save
	else out = `${parsed.preamble}${leadProtected ? '' : '\n\n'}${body}${tail}`;
	return doc.attrs.eol === '\r\n' ? out.replace(/\r?\n/g, '\r\n') : out;
}
