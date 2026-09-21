import { describe, it, expect } from 'vitest';
import {
	alignedSpans,
	charsOf,
	concatSpans,
	nearestPm,
	nearestSource,
	pmToSource,
	replaceKeepingSpans,
	sliceSpans,
	sourceToPm,
	spansOfChars,
	type Segment
} from '$lib/editor/visual/sourceSpans';

describe('leaf spans', () => {
	it('aligns a text against its bytes character by character', () => {
		expect(alignedSpans('a b', 10, 'a~b')).toEqual([
			{ from: 0, to: 1, srcFrom: 10, srcTo: 11, kind: 'text' },
			{ from: 1, to: 2, srcFrom: 11, srcTo: 12, kind: 'sub' },
			{ from: 2, to: 3, srcFrom: 12, srcTo: 13, kind: 'text' }
		]);
		expect(alignedSpans(' ', 5, '\n  ')).toEqual([{ from: 0, to: 1, srcFrom: 5, srcTo: 8, kind: 'sub' }]);
	});

	it('keeps the record through a replacement', () => {
		const r = replaceKeepingSpans('a---b', charsOf(5, [{ from: 0, to: 5, srcFrom: 0, srcTo: 5, kind: 'text' }]), '---', '—');
		expect(r.text).toBe('a—b');
		expect(spansOfChars(r.chars)).toEqual([
			{ from: 0, to: 1, srcFrom: 0, srcTo: 1, kind: 'text' },
			{ from: 1, to: 2, srcFrom: 1, srcTo: 4, kind: 'sub' },
			{ from: 2, to: 3, srcFrom: 4, srcTo: 5, kind: 'text' }
		]);
	});

	it('slices and joins', () => {
		const spans = [{ from: 0, to: 5, srcFrom: 0, srcTo: 5, kind: 'text' as const }];
		expect(sliceSpans('hello', spans, 2, 5)).toEqual([{ from: 0, to: 3, srcFrom: 2, srcTo: 5, kind: 'text' }]);
		expect(
			concatSpans([
				{ len: 2, spans: [{ from: 0, to: 2, srcFrom: 0, srcTo: 2, kind: 'text' }] },
				{ len: 3, spans: [{ from: 0, to: 3, srcFrom: 2, srcTo: 5, kind: 'text' }] }
			])
		).toEqual([{ from: 0, to: 5, srcFrom: 0, srcTo: 5, kind: 'text' }]);
	});
});

describe('lookups', () => {
	// "Hi \emph{there}." as a paragraph: the prose runs are the bytes, the markup between them is nobody's
	const spans: Segment[] = [
		{ pmFrom: 1, pmTo: 4, srcFrom: 0, srcTo: 3, kind: 'text' },
		{ pmFrom: 4, pmTo: 9, srcFrom: 9, srcTo: 14, kind: 'text' },
		{ pmFrom: 9, pmTo: 10, srcFrom: 15, srcTo: 16, kind: 'text' }
	];

	it('maps inside a run both ways', () => {
		expect(pmToSource(spans, 6)).toBe(11);
		expect(sourceToPm(spans, 11)).toBe(6);
	});

	it('has no answer for markup bytes and says so', () => {
		expect(sourceToPm(spans, 5)).toBeNull();
		expect(nearestPm(spans, 5, 1)).toBe(4);
		expect(nearestPm(spans, 5, -1)).toBe(4);
	});

	it('takes the side asked for at a shared boundary', () => {
		expect(pmToSource(spans, 4, -1)).toBe(3);
		expect(pmToSource(spans, 4, 1)).toBe(9);
	});

	it('inside a substituted run, the side asked for is the whole of it', () => {
		const sub: Segment[] = [{ pmFrom: 1, pmTo: 6, srcFrom: 0, srcTo: 6, kind: 'sub' }];
		expect(pmToSource(sub, 3, 1)).toBe(0);
		expect(pmToSource(sub, 3, -1)).toBe(6);
		expect(pmToSource(sub, 1, -1)).toBe(0);
		expect(pmToSource(sub, 6, 1)).toBe(6);
		expect(sourceToPm(sub, 2, 1)).toBe(1);
		expect(sourceToPm(sub, 2, -1)).toBe(6);
		expect(sourceToPm(sub, 6)).toBe(6);
	});

	it('reaches past unmapped positions to the nearest run', () => {
		expect(pmToSource(spans, 0)).toBeNull();
		expect(nearestSource(spans, 0, 1)).toBe(0);
		expect(nearestSource(spans, 0, -1)).toBe(0);
		expect(nearestSource(spans, 12, -1)).toBe(16);
		expect(nearestSource([], 3)).toBeNull();
	});
});
