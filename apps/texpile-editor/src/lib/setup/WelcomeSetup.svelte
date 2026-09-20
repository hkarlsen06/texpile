<script lang="ts">
	// The welcome screen, shown once: a card over whatever is behind it, one question a step.
	// Closing it counts as having seen it, so no launch asks twice
	import { X } from '@lucide/svelte';
	import { markSetupSeen } from './setupGate';
	import { visibleSteps, DEFAULT_FORMATS, type SetupStepId, type WritingFormats } from './setupSteps';
	import SetupLooks from './SetupLooks.svelte';
	import SetupFormats from './SetupFormats.svelte';
	import SetupMachine from './SetupMachine.svelte';
	import SetupProfile from './SetupProfile.svelte';
	import SetupAgent from './SetupAgent.svelte';
	import { m } from '$lib/paraglide/messages';

	let { done, openToolchain }: { done: () => void; openToolchain: () => void } = $props();

	let formats = $state<WritingFormats>({ ...DEFAULT_FORMATS });
	let at = $state(0);

	const steps = $derived(visibleSteps(formats));
	// unticking LaTeX and Typst takes a step out from under the reader, so the index is read clamped
	const here = $derived(Math.min(at, steps.length - 1));
	const step = $derived(steps[here]);
	const last = $derived(here === steps.length - 1);

	const TITLE: Record<SetupStepId, () => string> = {
		looks: m.setup_title_looks,
		formats: m.setup_title_formats,
		toolchain: m.setup_title_toolchain,
		profile: m.setup_title_profile,
		agent: m.setup_title_agent
	};
	const SUBTITLE: Partial<Record<SetupStepId, () => string>> = {
		looks: m.setup_sub_looks,
		toolchain: m.setup_sub_toolchain,
		profile: m.setup_sub_profile,
		agent: m.setup_sub_agent
	};

	function finish(): void {
		markSetupSeen();
		done();
	}

	function next(): void {
		if (last) finish();
		else at = here + 1;
	}

	let card = $state<HTMLElement | null>(null);

	// the screen is hidden, not unmounted, while Preferences is up, and a hidden screen must not
	// answer the key that closes what is over it
	function onEscape(e: KeyboardEvent): void {
		if (e.key === 'Escape' && card?.checkVisibility()) finish();
	}
</script>

<svelte:window onkeydown={onEscape} />

<div class="app-scrim fixed inset-0 z-1300 flex items-center justify-center bg-black/40 p-4 backdrop-blur-md">
	<div
		bind:this={card}
		class="card bg-surface-50-950 border-surface-300-700 relative flex h-[min(46rem,90vh)] w-full max-w-[64rem] flex-col border shadow-2xl"
		role="dialog"
		aria-modal="true"
		aria-label={m.setup_welcome()}
	>
		<button class="btn-icon btn-icon-sm hover:preset-tonal absolute top-3 right-3" onclick={finish} aria-label={m.modal_close_aria()}>
			<X class="size-4" />
		</button>

		<div class="text-muted flex items-center gap-2.5 px-7 pt-6 text-xs">
			<span class="flex items-center gap-1.5">
				{#each steps as id, i (id)}
					<span
						class="h-1.5 rounded-full {i === here
							? 'bg-primary-500 w-4'
							: i < here
								? 'bg-primary-500/40 w-1.5'
								: 'bg-surface-300-700 w-1.5'}"
					></span>
				{/each}
			</span>
			<span>{m.setup_step_of({ step: here + 1, total: steps.length })}</span>
		</div>

		<!-- the question stays put: only the step under it scrolls, or a long step slides its own title
		     up under the progress dots -->
		<div class="px-7 pt-5">
			<p class="text-muted text-xs">{m.setup_version({ version: __APP_VERSION__ })}</p>
			<h2 class="mt-1 text-2xl font-semibold tracking-tight">{TITLE[step]()}</h2>
			{#if SUBTITLE[step]}
				<p class="text-muted mt-2 max-w-[66ch] text-sm leading-relaxed">{SUBTITLE[step]?.()}</p>
			{/if}
		</div>

		<div class="min-h-0 flex-1 overflow-y-auto px-7 pb-3">
			<div class="mt-5">
				{#if step === 'looks'}
					<SetupLooks />
				{:else if step === 'formats'}
					<SetupFormats bind:formats />
				{:else if step === 'toolchain'}
					<SetupMachine {formats} {openToolchain} />
				{:else if step === 'profile'}
					<SetupProfile />
				{:else}
					<SetupAgent />
				{/if}
			</div>
		</div>

		<div class="border-surface-200-800 flex items-center justify-between gap-3 border-t px-7 py-4">
			<span class="text-muted text-xs">{last ? m.setup_footer_note() : ''}</span>
			<span class="flex gap-2">
				<button type="button" class="btn btn-sm" onclick={() => (at = Math.max(0, here - 1))} disabled={here === 0}>
					{m.setup_back()}
				</button>
				<button type="button" class="btn btn-sm preset-filled-primary-500" onclick={next}>
					{last ? m.setup_get_started() : m.setup_continue()}
				</button>
			</span>
		</div>
	</div>
</div>
