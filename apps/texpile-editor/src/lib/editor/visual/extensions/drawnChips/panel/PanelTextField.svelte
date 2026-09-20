<script lang="ts">
	import { ChevronDown } from '@lucide/svelte';
	import { tip } from '$lib/components/tooltip.svelte';
	import { m } from '$lib/paraglide/messages';

	type Props = {
		value: string;
		label: string;
		oninput: (value: string) => void;
		mono?: boolean;
		autofocus?: boolean;
		/** a datalist of suggestions, opened from the field's own chevron in place of the browser's */
		list?: string;
		placeholder?: string;
	};

	const props: Props = $props();

	let input: HTMLInputElement | undefined = $state();

	function showSuggestions() {
		input?.focus();
		try {
			input?.showPicker();
		} catch {
			// no picker for this input here; the list still opens as the reader types
		}
	}
</script>

<div class="relative flex min-w-0 flex-1">
	<input
		bind:this={input}
		class="border-surface-300-700 rounded-base focus:border-primary-500 h-7 w-full min-w-0 border bg-transparent px-2 text-sm outline-none {props.list
			? 'pr-7'
			: ''} {props.mono ? 'font-mono' : ''}"
		spellcheck="false"
		aria-label={props.label}
		list={props.list}
		placeholder={props.placeholder}
		data-autofocus={props.autofocus ? '' : undefined}
		value={props.value}
		oninput={(e) => props.oninput(e.currentTarget.value)}
	/>
	{#if props.list}
		<button
			type="button"
			tabindex="-1"
			class="text-surface-700-300 hover:text-surface-950-50 absolute inset-y-0 right-0 flex w-7 items-center justify-center"
			use:tip={m.drawn_chip_suggestions()}
			onclick={showSuggestions}
		>
			<ChevronDown class="size-3.5" />
		</button>
	{/if}
</div>
