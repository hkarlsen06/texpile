// What the toolchain probe found, one line per typesetter

export type EngineFound = { found: boolean; detail: string };

const LATEX_ENGINES = ['latexmk', 'pdflatex', 'lualatex', 'xelatex'];

export function latexFound(probes: ToolProbe[], distros: ToolDistro[]): EngineFound {
	const engine = probes.find((p) => LATEX_ENGINES.includes(p.id) && p.found);
	if (!engine) return { found: false, detail: '' };
	const distro = distros.find((d) => d.family === 'latex' && d.onPath) ?? distros.find((d) => d.family === 'latex');
	return { found: true, detail: distro?.name ?? engine.detail ?? '' };
}

export function typstFound(tinymist: TinymistInfo | null | 'unchecked'): EngineFound {
	if (!tinymist || tinymist === 'unchecked') return { found: false, detail: '' };
	return { found: true, detail: `tinymist ${tinymist.version}, Typst ${tinymist.typstVersion}` };
}
