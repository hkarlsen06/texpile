<script lang="ts">
	// The welcome screen again, on purpose, from Help. What covers the reader who skipped it, and the
	// one who installed TeX a week later and wants the check rerun
	import { preferencesOpen, setupOpen, openToolchainPrefs } from '$lib/stores/dialogStore';
	import WelcomeSetup from './WelcomeSetup.svelte';
</script>

{#if setupOpen.current}
	<!-- hidden rather than unmounted while Preferences is up: the reader sent themselves to Toolchain
	     from a step, and comes back to the step they were on -->
	<div class:hidden={preferencesOpen.current}>
		<WelcomeSetup done={() => (setupOpen.current = false)} openToolchain={openToolchainPrefs} />
	</div>
{/if}
