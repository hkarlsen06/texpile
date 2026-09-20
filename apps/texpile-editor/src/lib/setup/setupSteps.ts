// Which steps the welcome screen shows, in order
export type SetupStepId = 'looks' | 'formats' | 'toolchain' | 'profile' | 'agent';

export type WritingFormats = { latex: boolean; typst: boolean; markdown: boolean };

export const DEFAULT_FORMATS: WritingFormats = { latex: true, typst: false, markdown: false };

const ORDER: SetupStepId[] = ['looks', 'formats', 'toolchain', 'profile', 'agent'];

export function visibleSteps(formats: WritingFormats): SetupStepId[] {
	return ORDER.filter((id) => id !== 'toolchain' || formats.latex || formats.typst);
}
