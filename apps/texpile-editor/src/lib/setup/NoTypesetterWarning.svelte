<script lang="ts">
	// Leaving the typesetter step with nothing installed
	import Modal from '$lib/modals/Modal.svelte';
	import { m } from '$lib/paraglide/messages';

	let { open = $bindable(), onContinue }: { open: boolean; onContinue: () => void } = $props();
</script>

<Modal bind:open title={m.setup_no_typesetter_title()} card="max-w-md p-5" z="z-1301">
	<p class="text-sm leading-relaxed">{m.setup_no_typesetter_body()}</p>
	<div class="mt-5 flex justify-end gap-2">
		<button type="button" class="btn btn-sm" onclick={() => (open = false)}>{m.setup_no_typesetter_install()}</button>
		<button
			type="button"
			class="btn btn-sm preset-filled-primary-500"
			onclick={() => {
				open = false;
				onContinue();
			}}>{m.setup_no_typesetter_continue()}</button
		>
	</div>
</Modal>
