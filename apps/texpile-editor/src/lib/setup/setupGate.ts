// Whether the welcome screen is owed: setupSeen holds the version that finished or skipped it
import { settings, updateSettings } from '$lib/settings';
import { nativeBridge } from '$lib/workspace/fileSystem';

const SETUP_SINCE = '1.2.0';

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

export function markSetupSeen(version = __APP_VERSION__): void {
	updateSettings({ setupSeen: needsSetup(version) ? SETUP_SINCE : version });
}

export function setupOwed(): boolean {
	return needsSetup(settings.current.setupSeen ?? '');
}

export function setupOwedAtBoot(): boolean {
	const snapshot = nativeBridge()?.bootstrap?.settings as { setupSeen?: unknown } | undefined;
	if (!snapshot) return false;
	return needsSetup(typeof snapshot.setupSeen === 'string' ? snapshot.setupSeen : '');
}
