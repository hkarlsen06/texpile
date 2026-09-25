// The reader's own agent, run for the renderer: which presets are installed, their models, a run, and its cancel. The command
// comes from settings.json here in main, never from the request, so a request can only choose the prompt
import { app, ipcMain } from 'electron';
import { readSettings } from '../appSettings';
import { shellEnvReady } from '../shell/shellEnv';
import { findProgram } from '../shell/findProgram';
import { agentArgv, PRESET_AGENTS, type PresetAgent } from '../ai/agentCommand';
import { runAgent } from '../ai/runAgent';
import { agentStdio } from '../ai/agentStdio';
import { listAgentModels } from '../ai/agentModels';

const running = new Map<string, AbortController>();

export function registerAgentIpc(): void {
	ipcMain.handle('agent:detect', async () => {
		await shellEnvReady();
		return Object.fromEntries(PRESET_AGENTS.map((a) => [a, findProgram(a) !== null]));
	});

	ipcMain.handle('agent:models', (_e, agent: unknown) =>
		PRESET_AGENTS.includes(agent as PresetAgent)
			? listAgentModels(agent as PresetAgent, app.getVersion())
			: { ok: false, error: 'bad request' }
	);

	ipcMain.handle('agent:run', async (_e, req: { id?: unknown; prompt?: unknown; system?: unknown }) => {
		if (typeof req?.id !== 'string' || typeof req.prompt !== 'string') return { ok: false, error: 'bad request' };
		const system = typeof req.system === 'string' ? req.system : '';
		const s = readSettings();
		const argv = agentArgv(s.aiAgent, s.aiAgentCommand, s.aiAgentModel);
		if (!argv) return { ok: false, error: 'no agent is set in Preferences' };
		const abort = new AbortController();
		running.set(req.id, abort);
		try {
			return await runAgent(argv, { system, request: req.prompt }, abort.signal, agentStdio(s.aiAgent));
		} finally {
			running.delete(req.id);
		}
	});

	ipcMain.on('agent:cancel', (_e, id: unknown) => {
		if (typeof id === 'string') running.get(id)?.abort();
	});
}
