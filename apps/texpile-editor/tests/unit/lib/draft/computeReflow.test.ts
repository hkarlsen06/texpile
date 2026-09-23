import { it, expect } from 'vitest';
import { computeReflow } from '$lib/draft/heuristics/computeReflow';
import type { Cal } from '$lib/draft/locate/locate.types';

// the same three lines on the page and from the daemon: subtracting the two equal spans left 1.4e-14, which counted
// as growth and refused every keystroke on a packed page the certificate could not speak for (the tutorial's basics.tex)
it('reads an edited paragraph whose lines span what they did as not grown', () => {
	const cal = { pageNo: 3, b1: 93.4548, bk: 120.6548, medGap: 13.6, colL: 0, colR: 400 } as unknown as Cal;
	const glyphs = [10, 23.6, 37.2].map((y) => ({ t: 'g', x: 72, y }));
	const flow = computeReflow(cal, glyphs, [], { dk: 3, colBottom: 600, floorA: 600, pageRecords: () => [] });
	expect(flow.delta).toBe(0);
});
