// The command line for the agent the reader picked in Preferences. The prompt always goes on stdin, so nothing the
// reader wrote ever becomes part of a command line

/** the agents Texpile knows how to run, and to ask for their models */
export type PresetAgent = 'claude' | 'codex' | 'agy';
export type AgentChoice = PresetAgent | 'custom';

export const PRESET_AGENTS: PresetAgent[] = ['claude', 'codex', 'agy'];

/** where an agent that writes its answer to a file (rather than stdout) is told to put it */
export const ANSWER_FILE = '{answer}';

const PRESETS: Record<PresetAgent, string[]> = {
	// no tools and none of the reader's MCP servers: a rewrite needs neither, and each slows the start.
	// Not --bare, which never reads the reader's sign-in
	claude: ['claude', '-p', '--tools', '', '--strict-mcp-config', '--no-session-persistence', '--output-format', 'text'],
	// "-" reads the prompt from stdin; the last message goes to a file. The sandbox is named because exec otherwise takes
	// the reader's config, and --ephemeral keeps these runs out of their saved sessions
	codex: ['codex', 'exec', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'read-only', '--output-last-message', ANSWER_FILE, '-'],
	// one JSON message per turn on stdin (agentStdio.ts): Antigravity drops a prompt given on its command line. Slash
	// commands are off, or a passage whose line begins with one would be read as a command of its own
	agy: ['agy', '--input-format', 'stream-json', '--output-format', 'stream-json', '--disable-slash-commands']
};

/** where --model goes: Codex takes it after exec, which has options of its own */
const MODEL_AT: Record<PresetAgent, number> = { claude: 1, codex: 2, agy: 1 };

/** a command line split the way a shell splits words, quotes holding spaces together, without running a shell */
export function splitCommandLine(line: string): string[] {
	const out: string[] = [];
	let word = '';
	let quote: string | null = null;
	let started = false;
	for (const ch of line) {
		if (quote) {
			if (ch === quote) quote = null;
			else word += ch;
		} else if (ch === '"' || ch === "'") {
			quote = ch;
			started = true;
		} else if (/\s/.test(ch)) {
			if (started) out.push(word);
			word = '';
			started = false;
		} else {
			word += ch;
			started = true;
		}
	}
	if (started) out.push(word);
	return out;
}

/** the program and its arguments, or null when no agent is set. A custom command names its own model */
export function agentArgv(choice: unknown, custom: unknown, model?: unknown): string[] | null {
	if (PRESET_AGENTS.includes(choice as PresetAgent)) {
		const argv = [...PRESETS[choice as PresetAgent]];
		// one word with "=", so a model name can never read as a flag of its own
		if (typeof model === 'string' && model) argv.splice(MODEL_AT[choice as PresetAgent], 0, `--model=${model}`);
		return argv;
	}
	if (choice !== 'custom' || typeof custom !== 'string') return null;
	const argv = splitCommandLine(custom);
	return argv.length ? argv : null;
}
