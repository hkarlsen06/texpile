// one set of classes for every menu in the bar, so the eight menus cannot drift apart
export const triggerClass = 'rounded-base px-2.5 py-1 text-sm hover:preset-tonal data-[disabled]:opacity-40';
// no taller than the room the positioner found, and scrolling past that, so no item is ever out of reach
export const contentClass =
	'card bg-surface-50-950 border-surface-200-800 z-[1200] flex max-h-[var(--available-height,100vh)] min-w-48 flex-col gap-0 overflow-y-auto border p-1 shadow-xl';
export const itemClass =
	'flex cursor-pointer items-center justify-between gap-6 rounded-base px-2.5 py-1 text-sm hover:preset-tonal data-[disabled]:opacity-40';
export const separatorClass = 'border-surface-200-800 my-1 border-t';
