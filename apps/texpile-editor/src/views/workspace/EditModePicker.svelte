<script lang="ts">
	import { Popover, Portal } from '@skeletonlabs/skeleton-svelte';
	import { Check, ChevronDown, Pencil, SquarePen } from '@lucide/svelte';
	import { tip } from '$lib/components/tooltip.svelte';
	import { m } from '$lib/paraglide/messages';

	let { suggesting, onChange }: { suggesting: boolean; onChange: (v: boolean) => void } = $props();

	let open = $state(false);

	function pick(v: boolean) {
		open = false;
		if (v !== suggesting) onChange(v);
	}
</script>

<Popover {open} onOpenChange={(e) => (open = e.open)} positioning={{ placement: 'bottom-end', offset: { mainAxis: 4 } }} autoFocus={false}>
	<Popover.Trigger>
		{#snippet element(attrs)}
			<button
				{...attrs}
				class="btn btn-xs gap-1 {suggesting ? 'preset-filled-primary-500' : 'preset-outlined-surface-200-800 hover:preset-tonal'}"
				aria-label={`${m.suggest_mode_picker()}: ${suggesting ? m.suggest_mode_suggesting() : m.suggest_mode_editing()}`}
				use:tip={suggesting ? m.suggest_mode_on() : m.suggest_mode_off()}
			>
				{#if suggesting}<SquarePen class="size-3.5" />{:else}<Pencil class="size-3.5" />{/if}
				<ChevronDown class="size-3" />
			</button>
		{/snippet}
	</Popover.Trigger>
	<Portal>
		<Popover.Positioner class="z-floating-ui">
			<Popover.Content class="card bg-surface-50-950 border-surface-300-700 min-w-[230px] border shadow-lg">
				<div class="py-1" role="radiogroup" aria-label={m.suggest_mode_picker()}>
					{#each [false, true] as mode (mode)}
						<button
							type="button"
							role="radio"
							aria-checked={mode === suggesting}
							class="hover:preset-tonal flex w-full items-start gap-2.5 px-3 py-2 text-left"
							onclick={() => pick(mode)}
						>
							{#if mode}
								<SquarePen class="mt-0.5 size-4 shrink-0 {suggesting ? 'text-primary-ink' : 'text-muted'}" />
							{:else}
								<Pencil class="mt-0.5 size-4 shrink-0 {suggesting ? 'text-muted' : 'text-primary-ink'}" />
							{/if}
							<span class="min-w-0 flex-1">
								<span class="block text-sm {mode === suggesting ? 'text-primary-ink font-medium' : ''}">
									{mode ? m.suggest_mode_suggesting() : m.suggest_mode_editing()}
								</span>
								<span class="text-muted block text-xs leading-relaxed">
									{mode ? m.suggest_mode_suggesting_note() : m.suggest_mode_editing_note()}
								</span>
							</span>
							{#if mode === suggesting}<Check class="text-primary-ink mt-0.5 size-4 shrink-0" />{/if}
						</button>
					{/each}
				</div>
			</Popover.Content>
		</Popover.Positioner>
	</Portal>
</Popover>
