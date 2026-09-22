<script lang="ts">
	// Step one: language, mode, theme and transparency
	import { Languages } from '@lucide/svelte';
	import { Switch } from '@skeletonlabs/skeleton-svelte';
	import { settings, updateSettings, applyUiLocale, type AppSettings } from '$lib/settings';
	import { windowGlass } from '$lib/chrome/windowGlass.svelte';
	import { markSetupReopen } from '$lib/stores/dialogStore';
	import { uiLocaleOptions } from '$lib/modals/window/prefsOptions';
	import AppearanceMode from '$lib/modals/window/AppearanceMode.svelte';
	import ThemePicker from '$lib/modals/window/ThemePicker.svelte';
	import { m } from '$lib/paraglide/messages';

	const ROW = 'border-surface-200-800 flex items-center justify-between gap-6 border-b py-3.5 last:border-b-0';

	function pickLocale(e: Event & { currentTarget: HTMLSelectElement }): void {
		const uiLocale = e.currentTarget.value as AppSettings['uiLocale'];
		updateSettings({ uiLocale });
		markSetupReopen();
		applyUiLocale(uiLocale);
	}
</script>

<!-- first, because it is the one choice that reloads the window, and the rest of the setup is read in whatever it picks -->
<div class={ROW}>
	<div class="flex min-w-0 items-center gap-2">
		<Languages class="text-muted size-4 shrink-0" />
		<div class="text-sm font-medium">{m.prefs_language()}</div>
	</div>
	<!-- sized by its widest label: a fixed width ran long language names under the native arrow -->
	<select class="select w-auto min-w-32 shrink-0 text-sm" value={settings.current.uiLocale} onchange={pickLocale}>
		{#each uiLocaleOptions() as l (l.value)}
			<option value={l.value}>{l.label}</option>
		{/each}
	</select>
</div>

<div class={ROW}>
	<div class="text-sm font-medium">{m.prefs_mode()}</div>
	<AppearanceMode />
</div>

<ThemePicker />

{#if windowGlass.works}
	<div class={ROW}>
		<div class="text-sm font-medium">{m.prefs_window_transparency()}</div>
		<Switch checked={settings.current.transparentWindow === true} onCheckedChange={(d) => updateSettings({ transparentWindow: d.checked })}>
			<Switch.Control><Switch.Thumb /></Switch.Control>
			<Switch.HiddenInput />
		</Switch>
	</div>
{/if}
