// the installed copies of what compiles each format: TeX Live or MiKTeX for LaTeX, tinymist for Typst
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { firstInformativeLine } from '../toolchain';
import { managedTinymistPath, parseTinymistVersion } from '../typstService';
import { shellEnvReady } from './shellEnv';
import { baselinePath, resolveToolDir } from './toolDirs';

export type DistroFamily = 'latex' | 'typst';

export type ToolDistro = {
	family: DistroFamily;
	/** how the install names itself: "TeX Live 2025", "MiKTeX 24.1", "Typst 0.13.1, tinymist 0.13.24" */
	name: string;
	/** the bin folder, the one that goes in front of PATH */
	dir: string;
	/** every folder the install was reached through: the PATH entry, a folder of symlinks the list names */
	dirs: string[];
	/** the program's version line */
	detail: string;
	/** the copy the shell PATH reaches on its own */
	onPath: boolean;
};

const EXE = process.platform === 'win32' ? '.exe' : '';

export type DistroPlaces = {
	/** the program whose presence makes a folder a candidate, and whose version names the install */
	program: string;
	/** folders holding one install per year, each with bin/<platform> under it (TeX Live) */
	yearRoots: string[];
	/** bin folders at a fixed place (MiKTeX, the managed tinymist) */
	binDirs: string[];
	/** the shell PATH, searched for the copy it reaches on its own */
	pathDirs: string[];
};

function pathDirs(): string[] {
	return baselinePath()
		.split(process.platform === 'win32' ? ';' : ':')
		.filter(Boolean);
}

export function latexPlaces(home = os.homedir(), env = process.env): DistroPlaces {
	if (process.platform === 'win32') {
		const miktex = ['MiKTeX', 'miktex', 'bin', 'x64'];
		return {
			program: 'pdflatex',
			yearRoots: [path.join(env.SystemDrive || 'C:', '\\texlive')],
			binDirs: [
				path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Programs', ...miktex),
				path.join(env.ProgramFiles || 'C:\\Program Files', ...miktex)
			],
			pathDirs: pathDirs()
		};
	}
	return {
		program: 'pdflatex',
		yearRoots: ['/usr/local/texlive', '/opt/texlive', path.join(home, 'texlive')],
		binDirs: [path.join(home, 'bin')],
		pathDirs: pathDirs()
	};
}

export function typstPlaces(userData: string): DistroPlaces {
	return { program: 'tinymist', yearRoots: [], binDirs: [path.dirname(managedTinymistPath(userData))], pathDirs: pathDirs() };
}

function hasProgram(dir: string, program: string): boolean {
	try {
		return fs.statSync(path.join(dir, program + EXE)).isFile();
	} catch {
		return false;
	}
}

function subdirs(dir: string): string[] {
	try {
		return fs
			.readdirSync(dir, { withFileTypes: true })
			.filter((e) => e.isDirectory())
			.map((e) => path.join(dir, e.name));
	} catch {
		return [];
	}
}

function folderKey(p: string): string {
	const bare = p.replace(/[\\/]+$/, '');
	return process.platform === 'win32' ? bare.toLowerCase() : bare;
}

// MacTeX puts a folder of symlinks on PATH; the folder behind them is the one that names a year
function realDir(dir: string, program: string): string {
	try {
		return path.dirname(fs.realpathSync(path.join(dir, program + EXE)));
	} catch {
		return dir;
	}
}

/** every folder holding the program, the PATH one first; `extra` are the folders Preferences lists */
export function candidateBinDirs(places: DistroPlaces, extra: string[] = []): { dir: string; dirs: string[]; onPath: boolean }[] {
	const onPath = places.pathDirs.find((d) => hasProgram(d, places.program));
	const found: { dir: string; dirs: string[]; onPath: boolean }[] = [];
	const seen = new Map<string, { dirs: string[] }>();
	function take(dir: string, viaPath: boolean): void {
		if (!hasProgram(dir, places.program)) return;
		const real = realDir(dir, places.program);
		const hit = seen.get(folderKey(real));
		if (hit) {
			if (!hit.dirs.some((d) => folderKey(d) === folderKey(dir))) hit.dirs.push(dir);
			return;
		}
		const entry = { dir: real, dirs: [dir], onPath: viaPath };
		seen.set(folderKey(real), entry);
		found.push(entry);
	}
	if (onPath) take(onPath, true);
	for (const root of places.yearRoots)
		for (const year of subdirs(root).filter((d) => /^\d{4}$/.test(path.basename(d))))
			for (const bin of subdirs(path.join(year, 'bin'))) take(bin, false);
	for (const dir of [...places.binDirs, ...extra]) take(dir, false);
	return found;
}

/** the install's own name for itself, off the program's version output; null when it is not that program */
export function distroName(family: DistroFamily, out: string): string | null {
	if (family === 'typst') {
		const v = parseTinymistVersion(out);
		return v.typstVersion === 'unknown' ? null : `Typst ${v.typstVersion}, tinymist ${v.version}`;
	}
	const line = firstInformativeLine(out);
	if (!line) return null;
	return /\((TeX Live [^)]*|MiKTeX [^)]*)\)/.exec(line)?.[1] ?? line;
}

function probeDir(
	family: DistroFamily,
	program: string,
	{ dir, dirs, onPath }: { dir: string; dirs: string[]; onPath: boolean }
): Promise<ToolDistro | null> {
	return new Promise((resolve) => {
		execFile(path.join(dir, program + EXE), ['--version'], { timeout: 10000, windowsHide: true }, (err, stdout, stderr) => {
			const out = `${stdout}\n${stderr}`;
			const name = err ? null : distroName(family, out);
			if (!name) return resolve(null);
			// tinymist's first version-shaped line is a build timestamp, so the name says more
			resolve({ family, name, dir, dirs, detail: family === 'typst' ? name : (firstInformativeLine(out) ?? name), onPath });
		});
	});
}

/** `configured` is the folder list as settings hold it */
export async function detectDistros(configured: unknown, userData: string): Promise<ToolDistro[]> {
	await shellEnvReady();
	const listed = Array.isArray(configured) ? configured.filter((d): d is string => typeof d === 'string' && d.trim() !== '') : [];
	const extra = listed.map((d) => resolveToolDir(d));
	const families: [DistroFamily, DistroPlaces][] = [
		['latex', latexPlaces()],
		['typst', typstPlaces(userData)]
	];
	const found = await Promise.all(
		families.flatMap(([family, places]) => candidateBinDirs(places, extra).map((c) => probeDir(family, places.program, c)))
	);
	return found.filter((d): d is ToolDistro => d !== null);
}
