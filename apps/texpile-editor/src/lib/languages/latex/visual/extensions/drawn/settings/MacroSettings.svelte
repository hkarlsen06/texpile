<script lang="ts">
	import { Code } from '@lucide/svelte';
	import type { ChipSettingsProps } from '$lib/editor/visual/extensions/drawnChips/chipPanel.svelte';
	import * as Panel from '$lib/editor/visual/extensions/drawnChips/panel';
	import { ownMacroDefinition } from '../ownMacroFace.svelte';
	import { macroCall } from './macroCall';
	import { m } from '$lib/paraglide/messages';

	const props: ChipSettingsProps = $props();

	const name = $derived(macroCall(props.source));
	const definition = $derived(name ? ownMacroDefinition(name) : null);
</script>

{#if name && definition}
	<div class="flex flex-col gap-2">
		<Panel.Header title={m.drawn_chip_macro_title()} command={`\\${name}`} />
		<p class="text-muted text-xs">{m.drawn_chip_macro_defined_as()}</p>
		<pre
			class="border-surface-300-700 rounded-base text-surface-700-300 max-h-40 overflow-auto border px-2 py-1 font-mono text-xs whitespace-pre-wrap">{definition.def}</pre>
		<Panel.Button
			onclick={() => {
				props.close();
				props.jumpToDefinition(name);
			}}
		>
			<Code class="size-3.5" />
			{m.drawn_chip_macro_go_to()}
		</Panel.Button>
	</div>
{/if}
