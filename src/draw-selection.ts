import {EditorSelection, Extension, Facet, combineConfig, Prec, EditorState} from "@codemirror/state"
import {StyleSpec} from "style-mod"
import {ViewUpdate, nativeSelectionHidden} from "./extension"
import {EditorView} from "./editorview"
import {layer, RectangleMarker} from "./layer"
import browser from "./browser"

const CanHidePrimary = !browser.ios // FIXME test IE

type SelectionConfig = {
  /// The length of a full cursor blink cycle, in milliseconds.
  /// Defaults to 1200. Can be set to 0 to disable blinking.
  cursorBlinkRate?: number
  /// Whether to show a cursor for non-empty ranges. Defaults to
  /// true.
  drawRangeCursor?: boolean
}

const selectionConfig = Facet.define<SelectionConfig, Required<SelectionConfig>>({
  combine(configs) {
    return combineConfig(configs, {
      cursorBlinkRate: 1200,
      drawRangeCursor: true
    }, {
      cursorBlinkRate: (a, b) => Math.min(a, b),
      drawRangeCursor: (a, b) => a || b
    })
  }
})

/// Returns an extension that hides the browser's native selection and
/// cursor, replacing the selection with a background behind the text
/// (with the `cm-selectionBackground` class), and the
/// cursors with elements overlaid over the code (using
/// `cm-cursor-primary` and `cm-cursor-secondary`).
///
/// This allows the editor to display secondary selection ranges, and
/// tends to produce a type of selection more in line with that users
/// expect in a text editor (the native selection styling will often
/// leave gaps between lines and won't fill the horizontal space after
/// a line when the selection continues past it).
///
/// It does have a performance cost, in that it requires an extra DOM
/// layout cycle for many updates (the selection is drawn based on DOM
/// layout information that's only available after laying out the
/// content).
export function drawSelection(config: SelectionConfig = {}): Extension {
  return [
    selectionConfig.of(config),
    cursorLayer,
    selectionLayer,
    hideNativeSelection,
    nativeSelectionHidden.of(true)
  ]
}

/// Retrieve the [`drawSelection`](#view.drawSelection) configuration
/// for this state. (Note that this will return a set of defaults even
/// if `drawSelection` isn't enabled.)
export function getDrawSelectionConfig(state: EditorState): SelectionConfig {
  return state.facet(selectionConfig)
}

function configChanged(update: ViewUpdate) {
  return update.startState.facet(selectionConfig) != update.state.facet(selectionConfig)
}

const cursorLayer = layer({
  above: true,
  markers(view) {
    let {state} = view, conf = state.facet(selectionConfig)
    let cursors = []
    for (let r of state.selection.ranges) {
      let prim = r == state.selection.main
      if (r.empty ? !prim || CanHidePrimary : conf.drawRangeCursor) {
        let className = prim ? "cm-cursor cm-cursor-primary" : "cm-cursor cm-cursor-secondary"
        let cursor = r.empty ? r : EditorSelection.cursor(r.head, r.head > r.anchor ? -1 : 1)
        for (let piece of RectangleMarker.forRange(view, className, cursor)) cursors.push(piece)
      }
    }
    return cursors
  },
  update(update, dom) {
    if (update.transactions.some(tr => tr.selection))
      dom.style.animationName = dom.style.animationName == "cm-blink" ? "cm-blink2" : "cm-blink"
    let confChange = configChanged(update)
    if (confChange) setBlinkRate(update.state, dom)
    return update.docChanged || update.selectionSet || confChange
  },
  mount(dom, view) {
    setBlinkRate(view.state, dom)
  },
  class: "cm-cursorLayer"
})

function setBlinkRate(state: EditorState, dom: HTMLElement) {
  dom.style.animationDuration = state.facet(selectionConfig).cursorBlinkRate + "ms"
}

const selectionLayer = layer({
  above: false,
  markers(view) {
    return view.state.selection.ranges.map(r => r.empty ? [] : RectangleMarker.forRange(view, "cm-selectionBackground", r))
      .reduce((a, b) => a.concat(b))
  },
  update(update, dom) {
    return update.docChanged || update.selectionSet || update.viewportChanged || configChanged(update)
  },
  class: "cm-selectionLayer"
})

const themeSpec: {[selector: string]: StyleSpec} = {
  ".cm-line": {
    "& ::selection, &::selection": {backgroundColor: "transparent !important"},
  },
  ".cm-content": {
    "& :focus": {
      caretColor: "initial !important",
      "&::selection, & ::selection": {
        backgroundColor: "Highlight !important"
      }
    }
  }
}
if (CanHidePrimary)
  themeSpec[".cm-line"].caretColor = themeSpec[".cm-content"].caretColor = "transparent !important"
const hideNativeSelection = Prec.highest(EditorView.theme(themeSpec))
