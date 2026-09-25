<script lang="ts">
	// Step four: the name other people see
	import SetupProfilePreview from './SetupProfilePreview.svelte';
	import { userData, updateUserData } from '$lib/storage/userData';
	import { workspaceRoot } from '$lib/workspace/workspaceStore';
	import { m } from '$lib/paraglide/messages';

	const shown = $derived(userData.current.collabName.trim() || m.setup_profile_placeholder());

	async function write(collabName: string): Promise<void> {
		updateUserData({ collabName });
		if (!workspaceRoot.current) return;
		const [host, guest] = await Promise.all([import('$lib/collab/hostStore.svelte'), import('$lib/collab/guestStore.svelte')]);
		host.collabHost.refreshIdentity();
		guest.collabGuest.refreshIdentity();
	}
</script>

<div class="flex flex-col gap-6">
	<input
		class="input max-w-sm text-sm"
		maxlength={40}
		placeholder={m.setup_profile_placeholder()}
		value={userData.current.collabName}
		oninput={(e) => void write(e.currentTarget.value)}
	/>
	<SetupProfilePreview name={shown} />
</div>
