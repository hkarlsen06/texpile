<script lang="ts">
	// text prompt dialog, Electron has no window.prompt()
	import Modal from '$lib/modals/Modal.svelte';
	import ModalActions from '$lib/modals/ModalActions.svelte';
	import { m } from '$lib/paraglide/messages';

	let open = $state(false);
	let title = $state('');
	let value = $state('');
	let suggestions = $state<string[]>([]);
	let resolvePrompt: ((v: string | null) => void) | null = null;
	let input = $state<HTMLInputElement>();

	export function askText(promptTitle: string, initial = '', offered: string[] = []): Promise<string | null> {
		title = promptTitle;
		value = initial;
		suggestions = offered;
		open = true;
		setTimeout(() => input?.select(), 0);
		return new Promise((resolve) => (resolvePrompt = resolve));
	}

	function close(ok: boolean) {
		open = false;
		resolvePrompt?.(ok ? value : null);
		resolvePrompt = null;
	}
</script>

{#if open}
	<Modal onClose={() => close(false)} card="max-h-full max-w-sm overflow-y-auto p-4">
		<div class="mb-2 text-sm font-medium">{title}</div>
		<input
			bind:this={input}
			bind:value
			class="input w-full"
			list={suggestions.length ? 'text-prompt-suggestions' : undefined}
			onkeydown={(e) => {
				if (e.key === 'Enter') close(true);
			}}
		/>
		{#if suggestions.length}
			<datalist id="text-prompt-suggestions">
				{#each suggestions as suggestion (suggestion)}<option value={suggestion}></option>{/each}
			</datalist>
		{/if}
		<ModalActions
			class="mt-4"
			size="xs"
			buttons={[
				{ label: m.menubar_prompt_cancel(), role: 'cancel', onclick: () => close(false) },
				{ label: m.menubar_prompt_ok(), role: 'primary', onclick: () => close(true) }
			]}
		/>
	</Modal>
{/if}
