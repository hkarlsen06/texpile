// What the toolchain probe says about the formats the reader picked
import { toolchainProbe } from '$lib/modals/window/toolchainProbe.svelte';
import { latexFound, typstFound } from './machineSummary';
import type { WritingFormats } from './setupSteps';

export type EngineRow = { kind: string; found: boolean; detail: string };

export function engineRows(formats: WritingFormats): EngineRow[] {
	return [
		formats.latex ? { kind: 'LaTeX', ...latexFound(toolchainProbe.probes, toolchainProbe.distros) } : null,
		formats.typst ? { kind: 'Typst', ...typstFound(toolchainProbe.tinymist) } : null
	].filter((e) => e !== null);
}

export function nothingToCompileWith(formats: WritingFormats): boolean {
	if (toolchainProbe.probing) return false;
	const rows = engineRows(formats);
	return rows.length > 0 && rows.every((r) => !r.found);
}
