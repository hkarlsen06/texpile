// A folder main asked this window to open while the welcome screen is still owed
import { box } from '$lib/runes/box.svelte';

export const pendingWorkspace = box<string | null>(null);

export function takePendingWorkspace(): string | null {
	const root = pendingWorkspace.current;
	pendingWorkspace.current = null;
	return root;
}
