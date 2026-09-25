<script lang="ts">
	// The name where other people meet it: the caret flag a shared session shows them, and a comment in the margin
	import InitialAvatar from '$lib/components/InitialAvatar.svelte';
	import { colorFor } from '$lib/components/initialColor';
	import { m } from '$lib/paraglide/messages';

	type Props = { name: string };
	const props: Props = $props();
	const color = $derived(colorFor(props.name));

	const LINE = 'col-start-1 flex h-5 items-center gap-1.5';
	const WORDS = 'bg-surface-300-700 h-2 rounded-full';
</script>

<!-- a page drawn as bars: only the name and the comment are words, so it reads the same in every language -->
<div
	class="border-surface-200-800 bg-surface-100-900 rounded-container grid grid-cols-[minmax(0,1fr)_15rem] gap-x-8 gap-y-1.5 border px-7 py-5"
	aria-hidden="true"
>
	<div class="col-start-1 mb-2 flex h-5 items-center"><div class="bg-surface-400-600 h-3 w-2/5 rounded-full"></div></div>
	<div class={LINE}><div class="{WORDS} w-full"></div></div>
	<div class={LINE}>
		<div class="{WORDS} w-[28%]"></div>
		<div class="bg-warning-500/45 h-2 w-[30%] rounded-full"></div>
		<div class="{WORDS} flex-1"></div>
	</div>
	<div class={LINE}><div class="{WORDS} w-[45%]"></div></div>
	<div class="{LINE} mt-3"><div class="{WORDS} w-full"></div></div>
	<div class={LINE}>
		<div class="{WORDS} w-[52%]"></div>
		<span class="relative h-5 w-0.5 shrink-0" style="background-color: {color}">
			<span
				class="absolute bottom-full left-0 mb-0.5 rounded-sm px-1 text-[10px] leading-4 font-semibold whitespace-nowrap text-white"
				style="background-color: {color}"
			>
				{props.name}
			</span>
		</span>
		<div class="{WORDS} flex-1"></div>
	</div>
	<div class={LINE}><div class="{WORDS} w-[70%]"></div></div>

	<div
		class="bg-surface-50-950 border-surface-200-800 rounded-container col-start-2 row-span-5 row-start-3 self-start border py-1.5 pr-2 pl-2.5 text-xs"
	>
		<div class="flex items-start gap-2 leading-snug">
			<InitialAvatar name={props.name} class="mt-0.5 size-5 text-[10px]" />
			<div class="min-w-0 flex-1">
				<span class="text-muted font-medium">{props.name}</span>
				<p>{m.setup_profile_sample()}</p>
			</div>
		</div>
	</div>
</div>
