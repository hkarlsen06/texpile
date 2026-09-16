// tinymist resolution and the per-window language server lifecycle.
// One language server per window: each window has its own folder, and tinymist's project model is
// rooted at one workspace. Keyed by webContents id so closing one window can't kill another's.
import { app, ipcMain } from 'electron';
import * as typstService from '../typstService';

const typstLsps = new Map<number, typstService.LspHandle>();

export function registerTypstIpc(): void {
	ipcMain.handle('typst:resolve', () => typstService.resolveTinymist(app.getPath('userData')));

	ipcMain.handle('typst:lsp:start', async (e, root: string | null) => {
		const wcId = e.sender.id;
		typstLsps.get(wcId)?.stop();
		typstLsps.delete(wcId);
		const resolved = await typstService.resolveTinymist(app.getPath('userData'));
		if (!resolved) return { ok: false, error: 'tinymist was not found on PATH.' };
		try {
			// tinymist logs to stderr; keep a short tail so an unexpected death says why it died
			// (otherwise the only symptom is the preview pane's port going dead)
			const stderrTail: string[] = [];
			const handle = typstService.startLsp(resolved.command, root, {
				message: (json) => {
					if (!e.sender.isDestroyed()) e.sender.send('typst:lsp:message', json);
				},
				exit: (code) => {
					console.error(`[tinymist] exited unexpectedly (code ${code}); last stderr:\n${stderrTail.join('')}`);
					typstLsps.delete(wcId);
					if (!e.sender.isDestroyed()) e.sender.send('typst:lsp:exit', code);
				},
				log: (line) => {
					stderrTail.push(line);
					while (stderrTail.length > 40) stderrTail.shift();
				}
			});
			typstLsps.set(wcId, handle);
			// a closed window can no longer release its own server, and the process holds ~90MB
			e.sender.once('destroyed', () => {
				typstLsps.get(wcId)?.stop();
				typstLsps.delete(wcId);
			});
			// eslint-disable-next-line id-denylist -- `info` is the reply's wire field name
			return { ok: true, info: resolved };
		} catch (err) {
			return { ok: false, error: String(err instanceof Error ? err.message : err) };
		}
	});

	ipcMain.on('typst:lsp:send', (e, json: string) => typstLsps.get(e.sender.id)?.send(json));
	ipcMain.on('typst:lsp:stop', (e) => {
		typstLsps.get(e.sender.id)?.stop();
		typstLsps.delete(e.sender.id);
	});
}
