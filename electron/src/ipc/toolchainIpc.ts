import { app, ipcMain } from 'electron';
import * as fs from 'node:fs';
import { readSettings } from '../appSettings';
import { portable } from '../appIdentity';
import { dirForms } from '../shell/toolDirs';
import { detectDistros } from '../shell/distros';
import * as toolchain from '../toolchain';

export function registerToolchainIpc(): void {
	// tinymist is not in this list: typst:resolve answers for it, with more detail
	ipcMain.handle('toolchain:probe', (e) =>
		toolchain.probeToolchain((p) => {
			if (!e.sender.isDestroyed()) e.sender.send('toolchain:probe:result', p);
		})
	);
	ipcMain.handle('toolchain:distros', () => detectDistros(readSettings().toolDirs, app.getPath('userData')));
	ipcMain.handle('toolchain:dirForms', (_e, entry: unknown) => {
		// an AppImage on a stick is as portable as the Windows zip; its launcher says so in the environment
		const f = dirForms(typeof entry === 'string' ? entry : '.', portable || !!process.env.APPIMAGE);
		let exists = false;
		// the folder behind any symlink (MacTeX's texbin, a linked home), which is how distros names it
		let real = f.absolute;
		try {
			exists = fs.statSync(f.absolute).isDirectory();
			real = fs.realpathSync.native(f.absolute);
		} catch {}
		return { ...f, exists, real };
	});
}
