<script lang="ts">
	// One pick on the welcome screen: a box or a dot, a name and a note
	import { Check } from '@lucide/svelte';

	type Props = {
		kind: 'checkbox' | 'radio';
		checked: boolean;
		label: string;
		note?: string;
		aside?: string;
		onpick: () => void;
	};
	const props: Props = $props();
</script>

<button
	type="button"
	role={props.kind}
	aria-checked={props.checked}
	onclick={props.onpick}
	class="rounded-container flex items-center gap-3 border px-3.5 py-2.5 text-left {props.checked
		? 'border-primary-500 preset-tonal-primary'
		: 'border-surface-200-800 bg-surface-100-900 hover:preset-tonal'}"
>
	{#if props.kind === 'checkbox'}
		<span
			class="rounded-base flex size-4 shrink-0 items-center justify-center border {props.checked
				? 'bg-primary-500 border-primary-500 text-primary-contrast-500'
				: 'border-surface-400-600'}"
		>
			{#if props.checked}<Check class="size-3" />{/if}
		</span>
	{:else}
		<span class="size-3 shrink-0 rounded-full {props.checked ? 'border-primary-500 border-4' : 'border-surface-400-600 border'}"></span>
	{/if}
	<span class="min-w-0 flex-1">
		<span class="block text-sm">{props.label}</span>
		{#if props.note}<span class="text-muted block text-xs">{props.note}</span>{/if}
	</span>
	{#if props.aside}<span class="text-muted shrink-0 text-xs">{props.aside}</span>{/if}
</button>
