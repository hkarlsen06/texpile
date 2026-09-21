<script lang="ts">
	// Step five: the agent Refine runs, and its model
	import { settings, updateSettings } from '$lib/settings';
	import { agentBridge, isPresetAgent, PRESET_AGENTS, type PresetAgent } from '$lib/ai/selectionRefiner';
	import AgentModelChoice from '$lib/modals/window/AgentModelChoice.svelte';
	import SetupChoice from './SetupChoice.svelte';
	import { m } from '$lib/paraglide/messages';

	let installed = $state<Record<PresetAgent, boolean> | null>(null);
	void agentBridge()
		?.detect()
		.then((found) => (installed = found))
		.catch(() => undefined);

	const LABELS: Record<PresetAgent, () => string> = {
		claude: () => m.prefs_ai_agent_claude(),
		codex: () => m.prefs_ai_agent_codex(),
		agy: () => m.prefs_ai_agent_agy()
	};
	const here = $derived(PRESET_AGENTS.filter((a) => installed?.[a]));
	const picked = $derived(settings.current.aiAgent ?? '');

	function pick(value: PresetAgent | 'custom' | ''): void {
		updateSettings({ aiAgent: value, aiAgentModel: '' });
	}
</script>

<div class="flex flex-col gap-2.5">
	<SetupChoice kind="radio" checked={picked === ''} label={m.prefs_ai_agent_off()} onpick={() => pick('')} />
	{#each here as a (a)}
		<SetupChoice kind="radio" checked={picked === a} label={LABELS[a]()} aside={m.prefs_ai_agent_installed()} onpick={() => pick(a)} />
	{/each}
	<SetupChoice kind="radio" checked={picked === 'custom'} label={m.prefs_ai_agent_custom()} onpick={() => pick('custom')} />
</div>

{#if isPresetAgent(picked) && installed?.[picked]}
	<div class="border-surface-200-800 mt-4 flex items-start justify-between gap-6 border-t pt-4">
		<AgentModelChoice agent={picked} />
	</div>
{/if}

{#if picked === 'custom'}
	<input
		class="input mt-2.5 text-sm"
		placeholder={m.prefs_ai_agent_command_placeholder()}
		spellcheck="false"
		value={settings.current.aiAgentCommand}
		oninput={(e) => updateSettings({ aiAgentCommand: e.currentTarget.value.trim() })}
	/>
	<p class="text-muted mt-1.5 text-xs">{m.prefs_ai_agent_command_note()}</p>
{/if}
