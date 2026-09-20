<script lang="ts">
	// Step two: what the reader writes. It decides whether the typesetter check is worth showing
	// them, and which engines it looks for
	import SetupChoice from './SetupChoice.svelte';
	import type { WritingFormats } from './setupSteps';

	let { formats = $bindable() }: { formats: WritingFormats } = $props();

	const rows: { id: keyof WritingFormats; label: string; note: string }[] = [
		{ id: 'latex', label: 'LaTeX', note: '.tex, .cls, .sty' },
		{ id: 'typst', label: 'Typst', note: '.typ' },
		{ id: 'markdown', label: 'Markdown', note: '.md' }
	];
</script>

<div class="flex max-w-md flex-col gap-2.5">
	{#each rows as r (r.id)}
		<SetupChoice
			kind="checkbox"
			checked={formats[r.id]}
			label={r.label}
			note={r.note}
			onpick={() => (formats = { ...formats, [r.id]: !formats[r.id] })}
		/>
	{/each}
</div>
