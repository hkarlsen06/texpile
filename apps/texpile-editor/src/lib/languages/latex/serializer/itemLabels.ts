// an item's label, and the body written after it
import type { Ctx } from '$lib/serializer/types';

// the same label written as source and re-serialized from the editor differs by markup, ties,
// dash ligatures and quote curling; those are folded, and any other character typed in counts
export function labelKey(s: string): string {
	return s
		.replace(/\\[a-zA-Z@]+\s*/g, '')
		.replace(/[{}]/g, '')
		.replace(/~|\u00A0/g, ' ')
		.replace(/---|—/g, '-')
		.replace(/--|–/g, '-')
		.replace(/``|''|[“”"]/g, '"')
		.replace(/[`‘’]/g, "'")
		.replace(/\s+/g, ' ')
		.trim();
}

/** an item body beginning with `[` reads as the item's label, and one beginning with `<` as a
 *  beamer overlay: an empty group in front keeps the bytes text */
export function guardItemBody(body: string): string {
	return /^[[<]/.test(body) ? '{}' + body : body;
}

/** whether `ctx` is the first block of a list item, whose bytes follow \item directly */
export function headsItem(ctx: Ctx | undefined): boolean {
	return !!ctx && ctx.parent?.type.name === 'list' && ctx.index === 0;
}
