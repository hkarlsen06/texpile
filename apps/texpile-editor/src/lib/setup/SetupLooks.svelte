<script lang="ts">
	// Step one: the settings whose result you see the moment you pick them, in the order
	// Preferences > Appearance uses, so they are findable again there
	import { Languages } from '@lucide/svelte';
	import { Switch } from '@skeletonlabs/skeleton-svelte';
	import { settings, updateSettings, applyUiLocale, type AppSettings } from '$lib/settings';
	import { windowGlass } from '$lib/chrome/windowGlass.svelte';
	import { markSetupReopen } from '$lib/stores/dialogStore';
	import { uiLocaleOptions } from '$lib/modals/window/prefsOptions';
	import RadioChoiceList from '$lib/modals/window/RadioChoiceList.svelte';
	import AppearanceMode from '$lib/modals/window/AppearanceMode.svelte';
	import ThemePicker from '$lib/modals/window/ThemePicker.svelte';
	import { m } from '$lib/paraglide/messages';

	const ROW = 'border-surface-200-800 flex items-center justify-between gap-6 border-b py-3.5 last:border-b-0';

	// messages are not reactive in place, so a switch reloads the window; the screen asks to be put
	// back up, in the language just chosen
	function pickLocale(uiLocale: string): void {
		updateSettings({ uiLocale: uiLocale as AppSettings['uiLocale'] });
		markSetupReopen();
		applyUiLocale(uiLocale as AppSettings['uiLocale']);
	}
</script>

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

<div class="{ROW} items-start">
	<!-- the icon the Preferences row carries, for the same reason: findable in a language you cannot read -->
	<div class="flex min-w-0 items-center gap-2">
		<Languages class="text-muted size-4 shrink-0" />
		<div class="text-sm font-medium">{m.prefs_language()}</div>
	</div>
	<!-- rows, not a select: Windows draws a native select's popup light whatever the theme -->
	<RadioChoiceList choices={uiLocaleOptions()} value={settings.current.uiLocale} label={m.prefs_language()} onpick={pickLocale} />
</div>
