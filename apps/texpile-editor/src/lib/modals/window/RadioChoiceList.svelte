<script lang="ts" module>
	export type RadioChoice = { value: string; label: string; aside?: string; warn?: boolean; tip?: string };
</script>

<script lang="ts">
	// A short list of choices as radio rows, in the chip-panel style; Chromium draws a native select's popup light on
	// Windows whatever the theme
	import { tip } from '$lib/components/tooltip.svelte';

	type Props = { choices: RadioChoice[]; value: string; label: string; onpick: (value: string) => void };
	const props: Props = $props();
</script>

<div class="flex w-56 shrink-0 flex-col" role="radiogroup" aria-label={props.label}>
	{#each props.choices as c (c.value)}
		{@const on = props.value === c.value}
		<button
			type="button"
			role="radio"
			aria-checked={on}
			class="rounded-base flex h-7 items-center gap-2 px-1.5 text-left text-sm {on ? 'preset-tonal-primary' : 'hover:preset-tonal'}"
			onclick={() => props.onpick(c.value)}
			use:tip={c.tip}
		>
			<span class="size-2.5 shrink-0 rounded-full {on ? 'border-primary-500 border-[3px]' : 'border-surface-400-600 border'}"></span>
			<span class="min-w-0 flex-1 truncate">{c.label}</span>
			{#if c.aside}
				<span class="shrink-0 text-xs {c.warn ? 'text-warning-ink' : 'text-muted'}">{c.aside}</span>
			{/if}
		</button>
	{/each}
</div>
