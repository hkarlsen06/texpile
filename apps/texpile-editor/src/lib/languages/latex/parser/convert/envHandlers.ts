// per-environment conversion handlers (verbatim, math, lists, floats, quotes, generic)
// mutually recursive with the walkers in converter.ts; ESM live bindings make the circular import safe
import type { Node, Macro, Environment } from '@unified-latex/unified-latex-types';
import { printRaw } from '@unified-latex/unified-latex-util-print-raw';
import { buildNode, textNode, nodeToLatexString, type PmNode } from '../builders';
import { listingLanguage } from '../listingLanguage';
import { convertNodesToBlocks } from '../converter';
import { type EnvHandler } from './macroHandlers';
import { createTableWrapper, createTable } from './tableConvert';
import { createFigureWrapper } from './figureConvert';
import { createList } from './listConvert';
import { createBlockMath } from './mathConvert';
import { capture, nodeRawSpan, positionSpan, rawTextNode } from './origCapture';
import { bytesSpan, type LeafSpan } from '$lib/editor/visual/sourceSpans';

/** the listing's bytes: its literal content sits inside the environment's own slice exactly once */
function verbatimBodySpans(env: Environment, raw: string, body: string): LeafSpan[] | null {
	const p = positionSpan(env);
	const src = capture.rawSource;
	if (!p || !src || !raw || !body) return null;
	const at = src.indexOf(raw, p.from);
	if (at < 0 || at + raw.length > p.to) return null;
	const again = src.indexOf(raw, at + 1);
	if (again >= 0 && again + raw.length <= p.to) return null;
	return bytesSpan(body.length, at + (raw.length - raw.replace(/^\r?\n/, '').length));
}

export const transparentEnvironments = new Set(['document']);

/** verbatim/lstlisting/minted to one code_block, remembering the source env name + verbatim args
 * so the serializer reconstructs the SAME environment instead of a fixed one. */
export function codeBlockFromVerbatimEnv(env: Environment): PmNode {
	// unified-latex stores verbatim-family bodies as a literal string on `content`, despite the
	// declared `content: Node[]` type.
	const rawContent = env.content as unknown as Node[] | string;
	const raw = typeof rawContent === 'string' ? rawContent : printRaw(rawContent);
	// Drop the delimiter newlines, which belong to the \begin and \end lines rather than to the
	// code. LaTeX itself discards the one after \begin{verbatim}, and the serializer re-adds both -
	// so keeping them showed a blank line at the top and bottom of every block in the editor, and
	// grew the file by one at each end every time an edited block was written back and reparsed.
	// Only the outermost pair goes; blank lines inside the listing are the author's.
	const body = raw.replace(/^\r?\n/, '').replace(/\r?\n[ \t]*$/, '');
	const args = env.args && env.args.length ? printRaw(env.args) : '';
	// the language the source already declares, so a listing opens highlighted instead of as plain
	// text with a dropdown that has to be set by hand every time (and forgot the answer on reload)
	return buildNode('code_block', { lang: listingLanguage(env.env, args) ?? 'text', env: env.env, args }, [
		textNode(body, null, verbatimBodySpans(env, raw, body))
	]);
}

export const envHandlers: Record<string, EnvHandler> = {
	document: (env, _ctx, options) => convertNodesToBlocks(env.content, options),
	itemize: (env, _ctx, options) => createList(env, 'bullet', options),
	enumerate: (env, _ctx, options) => createList(env, 'ordered', options),
	description: (env, _ctx, options) => createList(env, 'bullet', options),
	quote: (env, _ctx, options) => [buildNode('blockquote', null, convertNodesToBlocks(env.content, options))],
	quotation: (env, _ctx, options) => [buildNode('blockquote', { env: 'quotation' }, convertNodesToBlocks(env.content, options))],
	// sourceForm:'env' so it round-trips to the env form (the command form stamps 'macro')
	abstract: (env, _ctx, options) => [buildNode('abstract', { sourceForm: 'env' }, convertNodesToBlocks(env.content, options))],
	// losing lstlisting's [language=...] silently drops \lstset styling keyed off it
	verbatim: (env) => [codeBlockFromVerbatimEnv(env)],
	lstlisting: (env) => [codeBlockFromVerbatimEnv(env)],
	minted: (env) => [codeBlockFromVerbatimEnv(env)],
	figure: (env, ctx, options) => createFigureWrapper(env, ctx, options),
	// starred variants: nodeToLatexString(env) uses env.env itself, so the star round-trips via
	// the figureTemplate slot mechanism. without this, figure* fell to the generic env wrapper
	// and a lone \includegraphics inside got promoted to a template-less image that always
	// serializes as a bare \begin{figure}[h]: wrong env, invalid nesting, caption dropped.
	// invisible to byte round-trip checks (the orig layer masks it); only surfaces on regeneration.
	'figure*': (env, ctx, options) => createFigureWrapper(env, ctx, options),
	// wrapfig: same bug/fix as figure*; createFigureWrapper handles any env name verbatim.
	// wraptable is deliberately NOT routed here: table_wrapper has no verbatim template
	// (tableSerializer always synthesizes \begin{table}/table*), so it would destroy the
	// text-wrap layout instead of fixing anything.
	wrapfigure: (env, ctx, options) => createFigureWrapper(env, ctx, options),
	table: (env, ctx, options) => createTableWrapper(env, ctx, options),
	'table*': (env, ctx, options) => createTableWrapper(env, ctx, options),
	tabular: (env) => createTable(env),
	'tabular*': (env) => createTable(env),
	tabularx: (env) => createTable(env),
	// a longtable with repeating header/footer markers (\endhead etc.) is unmodelable as a grid:
	// createTable garbled the markers into cell text and leaked the colspec into the body.
	// demote those to raw; marker-less longtables keep the editable-table path.
	longtable: (env) => {
		const LT_MARKERS = new Set(['endfirsthead', 'endhead', 'endfoot', 'endlastfoot']);
		const hasMarkers = (env.content as Node[]).some((n) => n.type === 'macro' && LT_MARKERS.has((n as Macro).content));
		if (hasMarkers) return [buildNode('raw_latex', null, [rawTextNode(nodeRawSpan(env), nodeToLatexString(env))])];
		return createTable(env);
	},
	equation: (env) => createBlockMath(env, false),
	'equation*': (env) => createBlockMath(env, true),
	align: (env) => createBlockMath(env, false, 'align'),
	'align*': (env) => createBlockMath(env, true, 'align'),
	alignat: (env) => createBlockMath(env, false, 'alignat'),
	'alignat*': (env) => createBlockMath(env, true, 'alignat'),
	// unregistered, flalign fell through to a bare \[...\], which drops the &-column syntax its
	// rows depend on: bare & outside an alignment env is a compile error ("Misplaced alignment tab").
	flalign: (env) => createBlockMath(env, false, 'flalign'),
	'flalign*': (env) => createBlockMath(env, true, 'flalign'),
	gather: (env) => createBlockMath(env, false, 'gather'),
	'gather*': (env) => createBlockMath(env, true, 'gather'),
	// multline/eqnarray must ALSO pass their env name: the serializer only re-inserts extracted
	// lineLabels when `environment` is set, otherwise blockMath's display-env early-return
	// re-emits the already label-stripped content and every \label (and \ref to it) vanishes.
	multline: (env) => createBlockMath(env, false, 'multline'),
	'multline*': (env) => createBlockMath(env, true, 'multline'),
	eqnarray: (env) => createBlockMath(env, false, 'eqnarray'),
	'eqnarray*': (env) => createBlockMath(env, true, 'eqnarray'),
	split: (env) => createBlockMath(env, true),
	cases: (env) => createBlockMath(env, true),
	displaymath: (env) => createBlockMath(env, true),
	math: (env) => createBlockMath(env, true)
	// minipage/center/flushleft/flushright are NOT handled here: they fall through to a preserved
	// environment node that carries its \begin args, so minipage keeps its {width}.
};
