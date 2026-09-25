// @vitest-environment jsdom
import { it, expect, vi, afterEach } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import CompileOptionsMenu from '../../../../src/views/workspace/CompileOptionsMenu.svelte';

let app: Record<string, unknown> | null = null;
afterEach(() => {
	if (app) unmount(app);
	app = null;
	document.body.innerHTML = '';
});

// the menu opens with the focus still on its chevron, so the key reaches the window, not the menu
it('closes on Escape', () => {
	const onClose = vi.fn();
	app = mount(CompileOptionsMenu, {
		target: document.body.appendChild(document.createElement('div')),
		props: {
			open: true,
			onClose,
			onConfigure: () => {},
			onFromScratch: () => {},
			onCleanAux: () => {},
			latexmkActions: true,
			onShowOutput: () => {},
			outputAvailable: true
		}
	});
	flushSync();
	window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
	expect(onClose).toHaveBeenCalledOnce();
});
