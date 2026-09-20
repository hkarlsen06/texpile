<script lang="ts">
	// Step four: the name other people see, and the comment it lands on
	import InitialAvatar from '$lib/components/InitialAvatar.svelte';
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

<div class="grid items-center gap-8 md:grid-cols-2">
	<input
		class="input text-sm"
		maxlength={40}
		placeholder={m.setup_profile_placeholder()}
		value={userData.current.collabName}
		oninput={(e) => void write(e.currentTarget.value)}
	/>

	<div class="border-surface-200-800 bg-surface-50-950 rounded-container w-[242px] border py-1.5 pr-2 pl-2.5 text-xs">
		<div class="flex items-start gap-2 leading-snug">
			<InitialAvatar name={shown} class="mt-0.5 size-5 text-[10px]" />
			<div class="min-w-0 flex-1">
				<span class="text-muted font-medium">{shown}</span>
				<p>{m.setup_profile_sample()}</p>
			</div>
		</div>
	</div>
</div>
