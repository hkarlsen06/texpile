<script lang="ts">
	// Step four: the name other people see, drawn into the comment it lands on, because a name field
	// on its own says nothing about where the name goes. No color to pick: it comes from the name
	import InitialAvatar from '$lib/components/InitialAvatar.svelte';
	import { userData, updateUserData } from '$lib/storage/userData';
	import { workspaceRoot } from '$lib/workspace/workspaceStore';
	import { m } from '$lib/paraglide/messages';

	const shown = $derived(userData.current.collabName.trim() || m.setup_profile_placeholder());

	// a rename during a live session has to reach the peers, and the collab stores carry Yjs with
	// them: no workspace open means no session to tell, and the start screen never loads them
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

	<div class="border-surface-200-800 bg-surface-100-900 rounded-container border px-3.5 py-3">
		<div class="flex items-center gap-2 text-xs">
			<InitialAvatar name={shown} class="size-5 text-[10px]" />
			<span class="min-w-0 truncate">{shown}</span>
			<span class="text-muted">{m.setup_profile_when()}</span>
		</div>
		<p class="mt-2 text-sm leading-relaxed">{m.setup_profile_sample()}</p>
		<div class="text-muted mt-2 flex gap-3 text-xs">
			<span>{m.comments_reply()}</span>
			<span>{m.comments_resolve()}</span>
		</div>
	</div>
</div>
