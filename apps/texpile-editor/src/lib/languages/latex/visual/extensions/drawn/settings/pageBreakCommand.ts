// a page break as its one setting, which command it is
export const PAGE_BREAKS = ['newpage', 'clearpage', 'cleardoublepage', 'pagebreak'];

const PAGE_BREAK = /^(\s*\\)(newpage|clearpage|cleardoublepage|pagebreak)((?:\{\})?\s*)$/;

export function readPageBreak(source: string): string | null {
	return PAGE_BREAK.exec(source)?.[2] ?? null;
}

export function writePageBreak(source: string, name: string): string {
	return source.replace(PAGE_BREAK, (_, lead: string, _name: string, trail: string) => lead + name + trail);
}
