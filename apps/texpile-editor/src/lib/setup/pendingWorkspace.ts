// A folder main asked this window to open while the welcome screen is still owed. Kept in sessionStorage, because a
// language picked in the welcome screen reloads the window
const PENDING = 'texpile:pending-workspace';

export function holdPendingWorkspace(root: string): void {
	try {
		sessionStorage.setItem(PENDING, root);
	} catch {
		return;
	}
}

export function takePendingWorkspace(): string | null {
	try {
		const root = sessionStorage.getItem(PENDING);
		sessionStorage.removeItem(PENDING);
		return root;
	} catch {
		return null;
	}
}
