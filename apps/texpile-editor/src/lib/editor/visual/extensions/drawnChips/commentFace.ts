// a comment folded to one quiet line: its first words and how many lines follow, the rest in the hint
import { tip } from '$lib/components/tooltip.svelte';
import type { ChipFace } from './chipFace';

const HINT_LINES = 12;

/** `lines` without their comment markers; `marker` is the language's own, shown faint in front */
export function commentFace(lines: string[], marker: string): ChipFace {
	const dom = document.createElement('span');
	dom.className = 'drawn-comment';
	const shown = lines.find((line) => line.trim()) ?? '';
	const sign = dom.appendChild(document.createElement('span'));
	sign.className = 'drawn-comment-marker';
	sign.textContent = marker;
	dom.appendChild(document.createTextNode(' ' + shown.trim()));
	const rest = lines.length - 1;
	if (rest > 0) {
		const more = dom.appendChild(document.createElement('span'));
		more.className = 'drawn-comment-more';
		more.textContent = `+${rest} ${rest === 1 ? 'line' : 'lines'}`;
	}
	const hint = lines.slice(0, HINT_LINES).join('\n') + (lines.length > HINT_LINES ? '\n…' : '');
	const tipped = hint.trim() && hint.trim() !== shown.trim() ? tip(dom, hint) : null;
	return { dom, line: true, destroy: () => tipped?.destroy() };
}
