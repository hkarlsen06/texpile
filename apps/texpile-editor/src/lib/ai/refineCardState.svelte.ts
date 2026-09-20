// Where the Refine card is open: beside the selection toolbar's button, or nowhere
import { box } from '$lib/runes/box.svelte';
import { refiner } from './selectionRefiner';

export const refineCard = box<{ anchor: DOMRect } | null>(null);

export function openRefineCard(button: HTMLElement): void {
	const r = refiner.current;
	if (!r?.available || r.busy) return;
	refineCard.current = { anchor: button.getBoundingClientRect() };
}

export function closeRefineCard(): void {
	refineCard.current = null;
}
