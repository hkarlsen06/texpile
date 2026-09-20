import { it, expect } from 'vitest';
import { visibleSteps, DEFAULT_FORMATS } from '$lib/setup/setupSteps';

it('asks about the typesetter only when a format needs one', () => {
	expect(visibleSteps(DEFAULT_FORMATS)).toContain('toolchain');
	expect(visibleSteps({ latex: false, typst: true, markdown: false })).toContain('toolchain');

	// markdown alone compiles with nothing, so the check would only ever report a lack it does not have
	const markdownOnly = visibleSteps({ latex: false, typst: false, markdown: true });
	expect(markdownOnly).not.toContain('toolchain');
	expect(markdownOnly).toHaveLength(4);
});
