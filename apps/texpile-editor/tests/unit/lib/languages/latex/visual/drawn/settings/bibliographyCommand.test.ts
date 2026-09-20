import { describe, expect, it } from 'vitest';
import { readBibliography, writeBibliography } from '$lib/languages/latex/visual/extensions/drawn/settings/bibliographyCommand';

describe('bibliographyCommand', () => {
	it('changes the argument in place and keeps the rest', () => {
		const command = readBibliography('\\bibliographystyle{plain}')!;
		expect(command).toEqual({ style: true, value: 'plain' });
		expect(writeBibliography('\\bibliographystyle{plain}', command.value)).toBe('\\bibliographystyle{plain}');
		expect(writeBibliography('\\bibliography{refs,more}', 'refs')).toBe('\\bibliography{refs}');
	});
});
