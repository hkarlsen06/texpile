// a decision in ProseMirror's undo history (comments/decisionHistory.ts): a step that changes nothing and inverts to
// itself facing the other way
import { Plugin } from 'prosemirror-state';
import { Step, StepMap, StepResult } from 'prosemirror-transform';
import type { Node } from 'prosemirror-model';
import type { EditorView } from 'prosemirror-view';
import { closeHistory, isHistoryTransaction } from 'prosemirror-history';
import { decisionStepped } from '$lib/comments/decisionHistory';

class DecisionMarkStep extends Step {
	constructor(
		readonly seq: number,
		readonly undone: boolean
	) {
		super();
	}
	override apply(doc: Node): StepResult {
		return StepResult.ok(doc);
	}
	override getMap(): StepMap {
		return StepMap.empty;
	}
	override invert(): Step {
		return new DecisionMarkStep(this.seq, !this.undone);
	}
	override map(): Step {
		return this;
	}
	// never sent anywhere: the history keeps it, and nothing else reads steps as JSON
	// eslint-disable-next-line @typescript-eslint/naming-convention -- prosemirror-transform Step API method
	override toJSON() {
		return { stepType: 'texpileDecision', seq: this.seq, undone: this.undone };
	}
}

/** record the decision numbered `seq` as its own undo step */
export function markPmDecision(view: EditorView, seq: number): void {
	view.dispatch(closeHistory(view.state.tr.step(new DecisionMarkStep(seq, false))));
}

export function pmDecisionSteps(): Plugin {
	return new Plugin({
		appendTransaction(trs) {
			for (const tr of trs) {
				if (!isHistoryTransaction(tr)) continue;
				for (const s of tr.steps)
					if (s instanceof DecisionMarkStep) queueMicrotask(() => decisionStepped({ seq: s.seq, undone: s.undone }));
			}
			return null;
		}
	});
}
