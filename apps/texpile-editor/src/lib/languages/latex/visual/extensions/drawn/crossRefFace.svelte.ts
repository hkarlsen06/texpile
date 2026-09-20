// \cref, \autoref, \pageref, \nameref and \hyperref drawn the way a \ref is: tinted text the compiler's .aux fills in.
// It follows the store, so a compile finishing updates it in place
import { tip } from '$lib/components/tooltip.svelte';
import type { ChipFace } from '$lib/editor/visual/extensions/drawnChips/chipFace';
import { projectIntelStore } from '$lib/stores/projectIntel';
import { templateFeaturesStore } from '$lib/stores/editorStore';
import { undefinedRefs } from '../ref/undefinedRefs.svelte';
import { DEFAULT_CROSS_REF_NAMES } from './crossRefNames';
import { crossRefText } from './crossRefText';
import { onDrawnInputs } from './drawnInputs.svelte';

/** `shown` is the text a \hyperref[label]{text} prints itself */
export function crossRefFace(command: string, labels: string[], shown: string | null, source: string): ChipFace {
	const dom = document.createElement('span');
	dom.className = 'drawn-crossref';
	const tipped = tip(dom, source);
	// drawn now, so the line breaker measures it, and again whenever a compile writes a new .aux
	function show(): void {
		const intel = projectIntelStore.current;
		const aux = { numbers: intel.auxNumbers, pages: intel.auxPages, kinds: intel.auxKinds, titles: intel.auxTitles };
		const names = templateFeaturesStore.current.crossRefNames ?? DEFAULT_CROSS_REF_NAMES;
		dom.textContent = shown ?? crossRefText(command, labels, aux, names).text;
		const missing = labels.find((label) => undefinedRefs.current.has(label));
		dom.classList.toggle('drawn-crossref-broken', missing !== undefined);
		tipped.update(missing !== undefined ? `Label "${missing}" not found` : source);
	}
	show();
	const stop = onDrawnInputs(show);
	return {
		dom,
		destroy() {
			stop();
			tipped.destroy();
		}
	};
}
