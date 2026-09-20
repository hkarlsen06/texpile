// The selection toolbar in the source editor: the shared row of buttons, placed in the left margin
import { type EditorView, ViewPlugin } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import { settings } from '$lib/settings';
import { observe } from '$lib/runes/observe.svelte';
import { selectionToolbarRow, type SelectionToolbarRow } from '$lib/editor/selectionToolbarRow';

/** the row fades in rather than flashing under the pointer for every drag it passes through */
const SHOW_DELAY = 120;

/**
 * The row for a non-empty selection, in the LEFT margin, vertically centred on the cursor's line.
 *
 * This is Overleaf's editor-floating-menu, whose measure is `right: window.innerWidth -
 * contentDOM.left` - the row's right edge flush against the left edge of the text, so it lands in
 * the gutter and covers nothing. A tooltip above the selection sits ON the line you are reading to
 * decide, and the right margin is already spoken for here by the preview divider and its lozenge.
 *
 * `position: fixed` with a measured `right`, not `absolute` inside the editor: the gutter's width
 * changes with the line count and the pane's own left edge moves when the sidebar resizes, and
 * fixed coordinates read off contentDOM track both without a second source of truth.
 */
export function cmSelectionToolbar(onAdd: (from: number, to: number) => void, label: string): Extension {
	return ViewPlugin.fromClass(
		class {
			private readonly row: SelectionToolbarRow;
			private timer: ReturnType<typeof setTimeout> | null = null;
			private shown = false;
			private added: { from: number; to: number } | null = null;
			private readonly resize: ResizeObserver;
			private readonly unsub: () => void;

			constructor(private readonly view: EditorView) {
				this.row = selectionToolbarRow(
					label,
					() => {
						const sel = view.state.selection.main;
						if (sel.empty) return;
						this.added = { from: sel.from, to: sel.to };
						onAdd(sel.from, sel.to);
						this.hide();
					},
					() => this.hide()
				);
				view.dom.appendChild(this.row.dom);
				// scrolling moves the line without changing the viewport, so update() alone would
				// leave the row behind; the observer catches pane and window resizes, which move
				// contentDOM's left edge without any editor update at all
				view.scrollDOM.addEventListener('scroll', this.schedule);
				this.resize = new ResizeObserver(this.schedule);
				this.resize.observe(view.scrollDOM);
				// the toggle has to bite without waiting for the next selection change, both ways
				this.unsub = observe(
					() => settings.current,
					() => this.schedule()
				);
				this.schedule();
			}

			update() {
				this.schedule();
			}

			destroy() {
				this.view.scrollDOM.removeEventListener('scroll', this.schedule);
				this.resize.disconnect();
				this.unsub();
				if (this.timer) clearTimeout(this.timer);
				this.row.dom.remove();
			}

			/**
			 * Measuring has to go through requestMeasure.
			 *
			 * coordsAtPos reads DOM layout, and CodeMirror forbids that inside update() - it throws
			 * "Reading the editor layout isn't allowed during an update" and disables the plugin,
			 * which is why calling it directly meant the row never appeared at all. The read phase
			 * runs once the update has settled; write is where the style goes.
			 */
			private schedule = () => {
				this.view.requestMeasure<{ top: number; right: number } | null>({
					key: 'cm-comment-add',
					read: (view) => {
						const sel = view.state.selection.main;
						// turned off in Preferences: the row never appears
						if (settings.current.commentPill === false || sel.empty) return null;
						if (this.added && this.added.from === sel.from && this.added.to === sel.to) return null;
						const coords = view.coordsAtPos(sel.head);
						if (!coords) return null;
						const scroller = view.scrollDOM.getBoundingClientRect();
						// scrolled out of the pane: hide rather than park the row at the edge
						if (coords.top < scroller.top || coords.top > scroller.bottom) return null;
						if (view.contentDOM.getBoundingClientRect().left < scroller.left) return null;
						const height = this.row.dom.getBoundingClientRect().height;
						return {
							top: (coords.top + coords.bottom) / 2 - height / 2,
							right: window.innerWidth - view.contentDOM.getBoundingClientRect().left
						};
					},
					// written straight to the DOM: this runs on every scroll frame, and routing it
					// through state would re-render the whole plugin each time
					write: (box) => {
						if (!box) {
							this.hide();
							return;
						}
						this.row.sync();
						this.row.dom.style.display = 'flex';
						this.row.dom.style.top = `${box.top}px`;
						this.row.dom.style.right = `${box.right}px`;
						if (!this.shown && !this.timer) {
							this.timer = setTimeout(() => {
								this.timer = null;
								this.shown = true;
								this.row.dom.classList.add('cm-comment-add-visible');
							}, SHOW_DELAY);
						}
					}
				});
			};

			private hide() {
				if (this.timer) {
					clearTimeout(this.timer);
					this.timer = null;
				}
				this.shown = false;
				this.row.dom.classList.remove('cm-comment-add-visible');
				this.row.dom.style.display = 'none';
			}
		}
	);
}
