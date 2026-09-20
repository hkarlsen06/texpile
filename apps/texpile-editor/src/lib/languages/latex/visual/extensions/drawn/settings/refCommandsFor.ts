import { detectedPackages } from '$lib/languages/latex/intellisense/completion/packageData';

/**
 * The reference commands a document can compile, read from what its preamble loads, so the reference panel never offers
 * \cref to a paper without cleveref. Undefined when there is no preamble (an included chapter), where nothing narrows.
 */
export function refCommandsFor(preamble: string): string[] | undefined {
	if (!/\\documentclass/.test(preamble)) return undefined;
	const packages = detectedPackages(preamble);
	function has(...names: string[]): boolean {
		return names.some((name) => packages.has(name));
	}
	return [
		'ref',
		...(has('amsmath', 'mathtools') ? ['eqref'] : []),
		'pageref',
		...(has('cleveref') ? ['cref', 'Cref'] : []),
		...(has('hyperref') ? ['autoref'] : []),
		...(has('hyperref', 'nameref') ? ['nameref'] : [])
	];
}
