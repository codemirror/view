import {StateField, StateEffect, Extension} from "@codemirror/state"
import {EditorView} from "./editorview"
import {ViewPlugin, MeasureRequest, ViewUpdate} from "./extension"

const setDropCursorPos = StateEffect.define<number | null>({
  map(pos, mapping) { return pos == null ? null : mapping.mapPos(pos) }
})

const dropCursorPos = StateField.define<number | null>({
  create() { return null },
  update(pos, tr) {
    if (pos != null) pos = tr.changes.mapPos(pos)
    return tr.effects.reduce((pos, e) => e.is(setDropCursorPos) ? e.value : pos, pos)
  }
})

const drawDropCursor = ViewPlugin.fromClass(class {
  cursor: HTMLElement | null = null
  measureReq: MeasureRequest<{left: number, top: number, height: number} | null>

  constructor(readonly view: EditorView) {
    this.measureReq = {read: this.readPos.bind(this), write: this.drawCursor.bind(this)}
  }

  update(update: ViewUpdate) {
    let cursorPos = update.state.field(dropCursorPos)
    if (cursorPos == null) {
      if (this.cursor != null) {
        this.cursor?.remove()
        this.cursor = null
      }
    } else {
      if (!this.cursor) {
        this.cursor = this.view.scrollDOM.appendChild(document.createElement("div"))
        this.cursor!.className = "cm-dropCursor"
      }
      if (update.startState.field(dropCursorPos) != cursorPos || update.docChanged || update.geometryChanged)
        this.view.requestMeasure(this.measureReq)
    }
  }

  readPos(): {left: number, top: number, height: number} | null {
    let pos = this.view.state.field(dropCursorPos)
    let rect = pos != null && this.view.coordsAtPos(pos)
    if (!rect) return null
    let outer = this.view.scrollDOM.getBoundingClientRect()
    return { 
      left: rect.left - outer.left + this.view.scrollDOM.scrollLeft,
      top: rect.top - outer.top + this.view.scrollDOM.scrollTop,
      height: rect.bottom - rect.top
    }
  }

  drawCursor(pos: {left: number, top: number, height: number} | null) {
    if (this.cursor) {
      if (pos) {
        this.cursor.style.left = pos.left + "px"
        this.cursor.style.top = pos.top + "px"
        this.cursor.style.height = pos.height + "px"
      } else {
        this.cursor.style.left = "-100000px"
      }
    }
  }

  destroy() {
    if (this.cursor) this.cursor.remove()
  }

  setDropPos(pos: number | null) {
    if (this.view.state.field(dropCursorPos) != pos)
      this.view.dispatch({effects: setDropCursorPos.of(pos)})
  }
}, {
  eventHandlers: {
    dragover(event) {
      this.setDropPos(this.view.posAtCoords({x: event.clientX, y: event.clientY}))
    },
    dragleave(event) {
      if (event.target == this.view.contentDOM || !this.view.contentDOM.contains(event.relatedTarget as HTMLElement))
        this.setDropPos(null)
    },
    dragend() {
      this.setDropPos(null)
    },
    drop() {
      this.setDropPos(null)
    }
  }
})

/// Draws a cursor at the current drop position when something is
/// dragged over the editor.
export function dropCursor(): Extension {
  return [dropCursorPos, drawDropCursor]
}
