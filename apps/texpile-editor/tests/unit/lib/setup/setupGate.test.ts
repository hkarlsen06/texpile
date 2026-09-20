import { it, expect, vi } from 'vitest';
import { needsSetup, markSetupSeen } from '$lib/setup/setupGate';
import * as settings from '$lib/settings';

it('greets a new install and everyone from before the screen existed, once', () => {
	// no key in settings.json: installed before 1.2.0, or installed fresh
	expect(needsSetup('')).toBe(true);
	expect(needsSetup('1.1.9')).toBe(true);
	expect(needsSetup('0.9.0')).toBe(true);

	// stamped by finishing or skipping it, so no later release brings it back
	expect(needsSetup('1.2.0')).toBe(false);
	expect(needsSetup('1.3.0')).toBe(false);
	expect(needsSetup('2.0.0')).toBe(false);

	// a release candidate of 1.2.0 saw the same screen
	expect(needsSetup('1.2.0-rc.3')).toBe(false);
});

// a dev build still on 1.1.0 stamping its own version would be owed the screen again every launch
it('stamps a version that counts as seen, whatever build finished it', () => {
	const stamps: string[] = [];
	const spy = vi.spyOn(settings, 'updateSettings').mockImplementation((p) => void stamps.push(String(p.setupSeen)));
	markSetupSeen('1.1.0');
	markSetupSeen('1.4.2');
	spy.mockRestore();
	expect(stamps.map((s) => needsSetup(s))).toEqual([false, false]);
	expect(stamps).toEqual(['1.2.0', '1.4.2']);
});
