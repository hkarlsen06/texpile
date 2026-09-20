<script lang="ts">
	// Step four: the name other people see, drawn into the comment it lands on, because a name field
	// on its own says nothing about where the name goes. The color under it is the session one: a
	// comment's own circle is hashed from the name, so the preview uses the real avatar and does not
	// take the color
	import InitialAvatar from '$lib/components/InitialAvatar.svelte';
	import { userData, updateUserData } from '$lib/storage/userData';
	import { PRESENCE_COLORS, HOST_COLOR } from '$lib/collab/identity';
	import { workspaceRoot } from '$lib/workspace/workspaceStore';
	import { m } from '$lib/paraglide/messages';

	const typed = $derived(userData.current.collabName.trim());
	const shown = $derived(typed || m.setup_profile_placeholder());
	const color = $derived(userData.current.collabColor || HOST_COLOR);

	const SWATCH = 'size-6 rounded-full border-2';

	// a rename during a live session has to reach the peers, and the collab stores carry Yjs with
	// them: no workspace open means no session to tell, and the start screen never loads them
	async function write(patch: { collabName?: string; collabColor?: string }): Promise<void> {
		updateUserData(patch);
		if (!workspaceRoot.current) return;
		const [host, guest] = await Promise.all([import('$lib/collab/hostStore.svelte'), import('$lib/collab/guestStore.svelte')]);
		host.collabHost.refreshIdentity();
		guest.collabGuest.refreshIdentity();
	}
</script>

<div class="grid items-center gap-8 md:grid-cols-2">
	<div>
		<input
			class="input text-sm"
			maxlength={40}
			placeholder={m.setup_profile_placeholder()}
			value={userData.current.collabName}
			oninput={(e) => void write({ collabName: e.currentTarget.value })}
		/>

		<span class="text-muted mt-5 mb-2 block text-xs">{m.setup_profile_color()}</span>
		<div class="flex gap-2.5" role="group" aria-label={m.setup_profile_color()}>
			{#each PRESENCE_COLORS as c, i (c)}
				<button
					type="button"
					class="{SWATCH} {color === c ? 'border-surface-950-50' : 'border-transparent'}"
					style="background-color: {c}"
					aria-pressed={color === c}
					aria-label={m.prefs_collab_color_option({ index: i + 1 })}
					onclick={() => void write({ collabColor: c })}
				></button>
			{/each}
		</div>
	</div>

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
