<script lang="ts">
	// The welcome screen again, on purpose, from Help
	import { preferencesOpen, setupOpen, openToolchainPrefs } from '$lib/stores/dialogStore';
	import WelcomeSetup from './WelcomeSetup.svelte';
</script>

{#if setupOpen.current}
	<div class:hidden={preferencesOpen.current}>
		<WelcomeSetup done={() => (setupOpen.current = false)} openToolchain={openToolchainPrefs} />
	</div>
{/if}
