// What the toolchain probe found, said in one line per typesetter. The Toolchain panel lists every
// program; a reader meeting Texpile only needs to know whether anything can build their document

export type EngineFound = { found: boolean; detail: string };

const LATEX_ENGINES = ['latexmk', 'pdflatex', 'lualatex', 'xelatex'];

/** the install's own name ("TeX Live 2025") when a distribution answered, else the engine's version line */
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
