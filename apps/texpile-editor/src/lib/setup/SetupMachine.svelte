<script lang="ts">
	// Step three: whether this computer can build what the reader writes
	import { LoaderCircle, X } from '@lucide/svelte';
	import { tip } from '$lib/components/tooltip.svelte';
	import { toolchainProbe } from '$lib/modals/window/toolchainProbe.svelte';
	import { toolDirs } from '$lib/modals/window/toolDirs.svelte';
	import { engineRows } from './typesetterStatus.svelte';
	import type { WritingFormats } from './setupSteps';
	import { m } from '$lib/paraglide/messages';

	let { formats, openToolchain }: { formats: WritingFormats; openToolchain: () => void } = $props();

	void toolchainProbe.run();
	void toolDirs.refresh();

	async function addFolder(): Promise<void> {
		await toolDirs.browse();
		await toolDirs.add();
	}

	const engines = $derived(engineRows(formats));
</script>

<div class="border-surface-200-800 divide-surface-200-800 rounded-container max-w-xl divide-y border">
	{#each engines as e (e.kind)}
		<div class="flex items-center justify-between gap-4 px-4 py-3">
			<div class="min-w-0">
				<div class="text-sm font-medium">{e.kind}</div>
				<div class="text-muted truncate text-xs">{e.detail || (e.found ? m.setup_found() : m.setup_typesetter_absent())}</div>
			</div>
			{#if toolchainProbe.probing && !e.found}
				<LoaderCircle class="text-muted size-4 shrink-0 animate-spin" />
			{:else if e.found}
				<span class="badge preset-tonal-success shrink-0 text-xs">{m.setup_found()}</span>
			{:else}
				<span class="badge preset-tonal-warning shrink-0 text-xs">{m.prefs_toolchain_missing()}</span>
			{/if}
		</div>
	{/each}
</div>

{#if toolDirs.rows.length}
	<div class="mt-3 max-w-xl">
		{#each toolDirs.rows as row (row.entry)}
			<div class="border-surface-200-800 flex items-center gap-3 border-b py-1.5">
				<span class="min-w-0 flex-1 truncate font-mono text-xs" use:tip={row.absolute}>{row.entry}</span>
				{#if !row.exists}
					<span class="text-warning-ink shrink-0 text-xs">{m.prefs_toolchain_dir_missing()}</span>
				{/if}
				<button
					type="button"
					class="btn-icon btn-icon-xs hover:preset-tonal opacity-60 hover:opacity-100"
					aria-label={m.prefs_toolchain_dirs_remove()}
					use:tip={m.prefs_toolchain_dirs_remove()}
					onclick={() => void toolDirs.remove(row.entry)}
					disabled={toolDirs.busy}
				>
					<X class="size-4" />
				</button>
			</div>
		{/each}
	</div>
{/if}

<div class="mt-3.5 flex max-w-xl flex-wrap items-center gap-x-4 gap-y-2 text-xs">
	<a class="anchor" href="https://texpile.com/docs/installation" target="_blank" rel="noopener noreferrer">
		{m.setup_toolchain_install()}
	</a>
	<button type="button" class="anchor" onclick={() => void addFolder()} disabled={toolDirs.busy}>{m.setup_toolchain_add_folder()}</button>
	<button type="button" class="anchor" onclick={openToolchain}>{m.setup_toolchain_link()}</button>
	<button
		type="button"
		class="btn preset-tonal ml-auto shrink-0 text-xs"
		onclick={() => void toolchainProbe.run()}
		disabled={toolchainProbe.probing}
	>
		{toolchainProbe.probing ? m.prefs_toolchain_checking() : m.prefs_toolchain_recheck()}
	</button>
</div>
