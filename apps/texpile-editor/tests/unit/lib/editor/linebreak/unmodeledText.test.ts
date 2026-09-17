import { it, expect } from 'vitest';
import { isUnmodeledText } from '$lib/editor/visual/linebreak/unmodeledText';

it('leaves text that ends lines without spaces to the browser, and keeps accented Latin, Greek and Cyrillic', () => {
	for (const text of [
		'\u6bb5\u843d',
		'with one \u674e in it',
		'\u3072\u3089',
		'\u30ab\u30bf',
		'\ud55c\uad6d',
		'\u0e44\u0e17\u0e22',
		'a fullwidth comma\uff0chere'
	])
		expect(isUnmodeledText(text), text).toBe(true);
	for (const text of [
		'plain words',
		'na\u00efve caf\u00e9',
		'\u03bb\u03cc\u03b3\u03bf\u03c2',
		'\u0441\u043b\u043e\u0432\u043e',
		'Figure\u00a01',
		'a dash \u2014 here'
	])
		expect(isUnmodeledText(text), text).toBe(false);
});
