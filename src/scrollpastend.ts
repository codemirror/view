import {Extension} from "@codemirror/state"
import {EditorView} from "./editorview"
import {ViewPlugin, ViewUpdate, MeasureRequest} from "./extension"

const plugin = ViewPlugin.fromClass(class {
  height = -1
  measure: MeasureRequest<number>

  constructor(view: EditorView) {
    this.measure = {
      read: view => Math.max(0, view.scrollDOM.clientHeight - view.defaultLineHeight),
      write: (value, view) => {
        if (Math.abs(value - this.height) > 1) {
          this.height = value
          view.contentDOM.style.paddingBottom = value + "px"
        }
      }
    }
    view.requestMeasure(this.measure)
  }

  update(update: ViewUpdate) {
    if (update.geometryChanged) update.view.requestMeasure(this.measure)
  }
})

/// Returns a plugin that makes sure the content has a bottom margin
/// equivalent to the height of the editor, minus one line height, so
/// that every line in the document can be scrolled to the top of the
/// editor.
///
/// This is only meaningful when the editor is scrollable, and should
/// not be enabled in editors that take the size of their content.
export function scrollPastEnd(): Extension {
  return plugin
}
