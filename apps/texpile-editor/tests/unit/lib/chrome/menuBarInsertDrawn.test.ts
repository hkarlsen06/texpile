// @vitest-environment jsdom
import { it, expect, afterEach } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { schema } from '$lib/languages/latex/schema/latexPMSchema';
import { editorViewStore } from '$lib/stores/editorStore';
import { makeDrawnInserts } from '$lib/chrome/menubar/menuBarInsertDrawn';

const para = (text: string) => schema.nodes.paragraph.create(null, schema.text(text));

function editorWith(text: string, caretBefore: string): EditorView {
	const doc = schema.nodes.doc.create(null, [para(text)]);
	const at = 1 + text.indexOf(caretBefore);
	const state = EditorState.create({ doc, selection: TextSelection.create(doc, at) });
	const view = new EditorView(document.body.appendChild(document.createElement('div')), { state });
	editorViewStore.current = view;
	return view;
}

const insert = makeDrawnInserts({ dialect: () => 'tex', askText: async () => null });

afterEach(() => {
	editorViewStore.current?.destroy();
	editorViewStore.current = null;
});

it('keeps a command name from running into the word after it', async () => {
	const view = editorWith('before after', 'after');
	await insert('hspace');
	const para = view.state.doc.firstChild!;
	const chip = para.content.content.findIndex((node) => node.type.name === 'inline_latex');
	expect(para.child(chip).textContent).toBe('\\quad');
	// the word after it starts past a space, so \quad never reads as \quadafter
	expect(para.child(chip + 1).text?.startsWith(' ')).toBe(true);
});

it('puts a comment after the paragraph instead of through a word', async () => {
	const view = editorWith('A paragraph before the comments.', 'omments');
	await insert('comment');
	const blocks = view.state.doc.content.content.map((node) => `${node.type.name}:${node.textContent}`);
	expect(blocks).toEqual(['paragraph:A paragraph before the comments.', 'raw_latex:% ']);
});
