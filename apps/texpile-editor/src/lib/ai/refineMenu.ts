// The Refine actions as a submenu of both right-click menus
import { Sparkles } from '@lucide/svelte';
import type { ContextMenuItem } from '$lib/menus/contextMenu.svelte';
import { m } from '$lib/paraglide/messages';
import { REFINE_ACTIONS } from './refineActions';
import { agentName, refiner, type SelectionRefiner } from './selectionRefiner';

function actionItems(r: SelectionRefiner): ContextMenuItem[] {
	return REFINE_ACTIONS.map((action) => ({ label: action.label(), icon: action.icon, onclick: () => void r.refine(action) }));
}

/** null wherever Refine is not set up, so the menu leaves it out */
export function refineMenuItem(hasSelection: boolean): ContextMenuItem | null {
	const r = refiner.current;
	if (!r?.available) return null;
	return {
		label: m.ai_refine_menu({ agent: agentName() }),
		icon: Sparkles,
		disabled: !hasSelection || r.busy,
		submenu: actionItems(r)
	};
}
