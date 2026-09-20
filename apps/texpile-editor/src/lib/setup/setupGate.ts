// Whether the welcome screen is owed to this reader.
//
// `setupSeen` holds the app version that finished or skipped it, empty when it never ran. Anyone
// installed before the screen existed has no such key, so they read as empty and are greeted once;
// every release after this one stays quiet, because their stamp is no longer older than SETUP_SINCE.
// Bump SETUP_SINCE only to deliberately greet everyone again.
import { settings, updateSettings } from '$lib/settings';
import { nativeBridge } from '$lib/workspace/fileSystem';

const SETUP_SINCE = '1.2.0';

/** 1.2.0-rc.3 counts as 1.2.0: a release candidate saw the same screen, so it is not owed twice */
function core(version: string): number[] {
	const n = (version.split('-')[0] || '').split('.').map((p) => Number(p) || 0);
	while (n.length < 3) n.push(0);
	return n.slice(0, 3);
}

function olderThan(version: string, than: string): boolean {
	if (!version.trim()) return true;
	const a = core(version);
	const b = core(than);
	for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i];
	return false;
}

export function needsSetup(setupSeen: string): boolean {
	return olderThan(setupSeen, SETUP_SINCE);
}

/** the reader has been through it, or said no to it. A build older than the screen itself stamps the
 *  screen's own version, or it would ask again on every launch */
export function markSetupSeen(version = __APP_VERSION__): void {
	updateSettings({ setupSeen: needsSetup(version) ? SETUP_SINCE : version });
}

export function setupOwed(): boolean {
	return needsSetup(settings.current.setupSeen ?? '');
}

/** before the store has hydrated: the snapshot main hands the window at creation, read at boot */
export function setupOwedAtBoot(): boolean {
	const snapshot = nativeBridge()?.bootstrap?.settings as { setupSeen?: unknown } | undefined;
	if (!snapshot) return false;
	return needsSetup(typeof snapshot.setupSeen === 'string' ? snapshot.setupSeen : '');
}
