<script lang="ts">
	// The Model row for a preset agent, listing what the agent itself says it offers
	import { LoaderCircle } from '@lucide/svelte';
	import { settings, updateSettings } from '$lib/settings';
	import { agentModels, modelChoices } from '$lib/ai/agentModels';
	import { agentName, type PresetAgent } from '$lib/ai/selectionRefiner';
	import { m } from '$lib/paraglide/messages';
	import RadioChoiceList from './RadioChoiceList.svelte';

	type Props = { agent: PresetAgent; onpick?: () => void };
	const props: Props = $props();
	const chosen = $derived(settings.current.aiAgentModel ?? '');
	const list = $derived(agentModels(props.agent));

	function pick(id: string): void {
		updateSettings({ aiAgentModel: id });
		props.onpick?.();
	}
</script>

{#snippet label(hint: string, error = false)}
	<div class="min-w-0">
		<div class="text-sm font-medium">{m.prefs_ai_model()}</div>
		<p class="mt-1 text-xs leading-relaxed [overflow-wrap:anywhere] {error ? 'text-error-ink' : 'text-muted'}">{hint}</p>
	</div>
{/snippet}

{#await list}
	{@render label(m.prefs_ai_model_loading({ agent: agentName() }))}
	<div class="flex h-7 w-56 shrink-0 items-center px-1.5"><LoaderCircle class="text-muted size-4 animate-spin" /></div>
{:then result}
	{@const models = modelChoices(result.ok ? result.models : [], chosen, m.prefs_ai_model_default())}
	{@const picked = models.find((x) => x.id === chosen)}
	{#if result.ok}
		{@render label(picked?.description || m.prefs_ai_model_note({ agent: agentName() }))}
	{:else}
		{@render label(m.prefs_ai_model_failed({ agent: agentName(), error: result.error }), true)}
	{/if}
	<RadioChoiceList
		choices={models.map((x) => ({ value: x.id, label: x.name, tip: x.description || undefined }))}
		value={chosen}
		label={m.prefs_ai_model()}
		onpick={pick}
	/>
{/await}
