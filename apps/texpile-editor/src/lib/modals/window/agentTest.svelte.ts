// A one-word request to the agent chosen in Preferences, so the reader sees it answers before using Refine
import { agentBridge, agentName } from '$lib/ai/selectionRefiner';
import { m } from '$lib/paraglide/messages';

const PROMPT = 'Reply with the single word: ready';
// rules of its own, so the test takes the same way through the agent that Refine does
const SYSTEM = 'You answer in one word.';

export class AgentTest {
	running = $state<string | null>(null);
	result = $state<{ ok: boolean; text: string } | null>(null);

	async run(): Promise<void> {
		const bridge = agentBridge();
		if (!bridge || this.running) return;
		const id = crypto.randomUUID();
		this.running = id;
		this.result = null;
		const agent = agentName();
		const started = performance.now();
		const answer = await bridge.run(id, PROMPT, SYSTEM);
		this.running = null;
		const seconds = String(Math.max(1, Math.round((performance.now() - started) / 1000)));
		if (answer.ok) this.result = { ok: true, text: m.prefs_ai_test_ok({ agent, seconds, reply: answer.text.trim().slice(0, 60) }) };
		else if (!answer.cancelled) this.result = { ok: false, text: m.prefs_ai_test_failed({ agent, error: answer.error }) };
	}

	cancel(): void {
		if (this.running) agentBridge()?.cancel(this.running);
	}

	clear(): void {
		this.result = null;
	}
}
