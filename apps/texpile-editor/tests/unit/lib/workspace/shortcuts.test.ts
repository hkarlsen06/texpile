// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';

const store = { path: '/w/gone.tex' as string | null };
vi.mock('$lib/workspace/workspaceStore', () => ({
	activeFilePath: {
		get current() {
			return store.path;
		}
	},
	activeCompare: { current: null }
}));

const { createKeydownHandler } = await import('$lib/workspace/shortcuts');

function ctrlW() {
	return { ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, key: 'w', preventDefault: () => {} } as KeyboardEvent;
}

describe('Ctrl+W', () => {
	// the document buffer drops its path when a file fails to load; the tab is still there
	it('closes the focused tab even when no document is loaded', () => {
		const closeTab = vi.fn();
		const handle = createKeydownHandler({
			closeTab,
			reopenTab: () => {},
			isGuest: () => false,
			save: () => {},
			toggleGlobalSearch: () => {},
			terminalAvailable: () => false,
			isCompiling: () => false,
			runCompile: () => {},
			stopCompile: () => {},
			openPreferences: () => {}
		});
		handle(ctrlW());
		expect(closeTab).toHaveBeenCalledWith({ path: '/w/gone.tex', compare: undefined });
	});
});

// Ctrl+, toggled subscript in the editors and opened nothing; the desktop convention is Preferences
describe('Ctrl+,', () => {
	it('opens Preferences and swallows the key', () => {
		const openPreferences = vi.fn();
		const preventDefault = vi.fn();
		const handle = createKeydownHandler({
			closeTab: () => {},
			reopenTab: () => {},
			isGuest: () => false,
			save: () => {},
			toggleGlobalSearch: () => {},
			terminalAvailable: () => false,
			isCompiling: () => false,
			runCompile: () => {},
			stopCompile: () => {},
			openPreferences
		});
		handle({ ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, key: ',', preventDefault } as unknown as KeyboardEvent);
		expect(openPreferences).toHaveBeenCalledTimes(1);
		expect(preventDefault).toHaveBeenCalled();
		handle({ ctrlKey: true, metaKey: false, shiftKey: true, altKey: false, key: ',', preventDefault } as unknown as KeyboardEvent);
		expect(openPreferences).toHaveBeenCalledTimes(1); // Shift variant is the editors' subscript
	});
});

describe('Ctrl+Shift+T', () => {
	it('reopens the last closed tab and leaves Ctrl+T alone', () => {
		const reopenTab = vi.fn();
		const closeTab = vi.fn();
		const handle = createKeydownHandler({
			closeTab,
			reopenTab,
			isGuest: () => false,
			save: () => {},
			toggleGlobalSearch: () => {},
			terminalAvailable: () => false,
			isCompiling: () => false,
			runCompile: () => {},
			stopCompile: () => {},
			openPreferences: () => {}
		});
		handle({
			ctrlKey: true,
			metaKey: false,
			shiftKey: true,
			altKey: false,
			key: 't',
			preventDefault: () => {}
		} as unknown as KeyboardEvent);
		handle({
			ctrlKey: true,
			metaKey: false,
			shiftKey: false,
			altKey: false,
			key: 't',
			preventDefault: () => {}
		} as unknown as KeyboardEvent);
		expect(reopenTab).toHaveBeenCalledTimes(1);
		expect(closeTab).not.toHaveBeenCalled();
	});
});
