// A folder main asked this window to open while the welcome screen is still owed.
//
// Session restore pushes the last folder at launch, which would carry an upgrading reader straight
// past the screen into their workspace. So the open waits here, and the welcome opens it when it is
// finished or skipped.
import { box } from '$lib/runes/box.svelte';

export const pendingWorkspace = box<string | null>(null);

/** the folder that was held, if any, and the box is cleared so a later open is not doubled */
export function takePendingWorkspace(): string | null {
	const root = pendingWorkspace.current;
	pendingWorkspace.current = null;
	return root;
}
