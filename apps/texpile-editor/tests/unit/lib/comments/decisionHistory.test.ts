// @vitest-environment jsdom
import { it, expect, afterEach } from 'vitest';
import { Schema } from 'prosemirror-model';
import { EditorState as PMState, type Transaction } from 'prosemirror-state';
import type { EditorView as PMView } from 'prosemirror-view';
import { history as pmHistory, undo as pmUndo, redo as pmRedo } from 'prosemirror-history';
import { EditorState as CMState } from '@codemirror/state';
import { EditorView as CMView } from '@codemirror/view';
import { history as cmHistory, undo as cmUndo, redo as cmRedo } from '@codemirror/commands';
import { onDecisionStep, type DecisionStep } from '$lib/comments/decisionHistory';
import { markPmDecision, pmDecisionSteps } from '$lib/editor/visual/extensions/pmDecisionStep';
import { markCmDecision, cmDecisionSteps } from '$lib/editor/source/extensions/cmDecisionStep';

const schema = new Schema({ nodes: { doc: { content: 'paragraph+' }, paragraph: { content: 'text*', toDOM: () => ['p', 0] }, text: {} } });

let steps: DecisionStep[] = [];
let off = onDecisionStep((s) => steps.push(s));
afterEach(() => {
	off();
	steps = [];
	off = onDecisionStep((s) => steps.push(s));
});

// the Accept sits in the history like any edit: typing after it comes off first, and the text is never touched
it('replays an Accept through ProseMirror undo and redo', async () => {
	let state = PMState.create({
		doc: schema.node('doc', null, [schema.node('paragraph', null, [schema.text('hi')])]),
		plugins: [pmHistory(), pmDecisionSteps()]
	});
	const dispatch = (tr: Transaction) => (state = state.apply(tr));
	markPmDecision(
		{
			get state() {
				return state;
			},
			dispatch
		} as unknown as PMView,
		7
	);
	dispatch(state.tr.insertText('!', 3));

	pmUndo(state, dispatch);
	await Promise.resolve();
	expect([state.doc.textContent, steps]).toEqual(['hi', []]);
	pmUndo(state, dispatch);
	await Promise.resolve();
	expect([state.doc.textContent, steps]).toEqual(['hi', [{ seq: 7, undone: true }]]);
	pmRedo(state, dispatch);
	await Promise.resolve();
	expect(steps.at(-1)).toEqual({ seq: 7, undone: false });
});

it('replays an Accept through CodeMirror undo and redo', () => {
	const view = new CMView({ state: CMState.create({ doc: 'hi', extensions: [cmHistory(), cmDecisionSteps()] }), parent: document.body });
	markCmDecision(view, 3);
	view.dispatch({ changes: { from: 2, insert: '!' }, userEvent: 'input.type' });

	cmUndo(view);
	expect([view.state.doc.toString(), steps]).toEqual(['hi', []]);
	cmUndo(view);
	expect([view.state.doc.toString(), steps]).toEqual(['hi', [{ seq: 3, undone: true }]]);
	cmRedo(view);
	expect(steps.at(-1)).toEqual({ seq: 3, undone: false });
	view.destroy();
});
