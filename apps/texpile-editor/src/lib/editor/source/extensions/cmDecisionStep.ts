// a decision in CodeMirror's undo history (comments/decisionHistory.ts): an effect the history records and inverts
import { StateEffect, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { invertedEffects, isolateHistory } from '@codemirror/commands';
import { decisionStepped, type DecisionStep } from '$lib/comments/decisionHistory';

const decision = StateEffect.define<DecisionStep>();

/** record the decision numbered `seq` as its own undo step */
export function markCmDecision(view: EditorView, seq: number): void {
	view.dispatch({ effects: decision.of({ seq, undone: false }), annotations: isolateHistory.of('full') });
}

export function cmDecisionSteps(): Extension {
	return [
		invertedEffects.of((tr) =>
			tr.effects.filter((e) => e.is(decision)).map((e) => decision.of({ seq: e.value.seq, undone: !e.value.undone }))
		),
		EditorView.updateListener.of((u) => {
			for (const tr of u.transactions) {
				if (!tr.isUserEvent('undo') && !tr.isUserEvent('redo')) continue;
				for (const e of tr.effects) if (e.is(decision)) decisionStepped(e.value);
			}
		})
	];
}
