import {EditorSelection, SelectionRange, Extension, Facet, combineConfig, Prec, EditorState} from "@codemirror/state"
import {BlockType} from "./decoration"
import {BlockInfo} from "./heightmap"
import {ViewUpdate, nativeSelectionHidden} from "./extension"
import {EditorView} from "./editorview"
import {layer, PlainLayerMarker} from "./layer"
import {Direction} from "./bidi"
import browser from "./browser"

const CanHidePrimary = !browser.ios // FIXME test IE

// Added to selection rectangles vertical extent to prevent rounding
// errors from introducing gaps in the rendered content.
const enum C { Epsilon = 0.01 }

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

function configChanged(update: ViewUpdate) {
  return update.startState.facet(selectionConfig) != update.startState.facet(selectionConfig)
}

const cursorLayer = layer({
  above: true,
  markers(view) {
    let {state} = view, conf = state.facet(selectionConfig)
    let cursors = []
    for (let r of state.selection.ranges) {
      let prim = r == state.selection.main
      if (r.empty ? !prim || CanHidePrimary : conf.drawRangeCursor) {
        let piece = measureCursor(view, r, prim)
        if (piece) cursors.push(piece)
      }
    }
    return cursors
  },
  update(update, dom) {
    if (update.transactions.some(tr => tr.scrollIntoView))
      dom.style.animationName = dom.style.animationName == "cm-blink" ? "cm-blink2" : "cm-blink"
    let confChange = configChanged(update)
    if (confChange) setBlinkRate(update.state, dom)
    return update.docChanged || update.selectionSet || confChange
  },
  mount(dom, view) {
    dom.setAttribute("aria-hidden", "true")
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
    return view.state.selection.ranges.map(r => r.empty ? [] : measureRange(view, r)).reduce((a, b) => a.concat(b))
  },
  update(update, dom) {
    return update.docChanged || update.selectionSet || update.viewportChanged || configChanged(update)
  },
  mount(dom) {
    dom.setAttribute("aria-hidden", "true")
  },
  class: "cm-selectionLayer"
})

const themeSpec = {
  ".cm-line": {
    "& ::selection": {backgroundColor: "transparent !important"},
    "&::selection": {backgroundColor: "transparent !important"}
  }
}
if (CanHidePrimary) (themeSpec as any)[".cm-line"].caretColor = "transparent !important"
const hideNativeSelection = Prec.highest(EditorView.theme(themeSpec))

function getBase(view: EditorView) {
  let rect = view.scrollDOM.getBoundingClientRect()
  let left = view.textDirection == Direction.LTR ? rect.left : rect.right - view.scrollDOM.clientWidth
  return {left: left - view.scrollDOM.scrollLeft, top: rect.top - view.scrollDOM.scrollTop}
}

function wrappedLine(view: EditorView, pos: number, inside: {from: number, to: number}) {
  let range = EditorSelection.cursor(pos)
  return {from: Math.max(inside.from, view.moveToLineBoundary(range, false, true).from),
          to: Math.min(inside.to, view.moveToLineBoundary(range, true, true).from),
          type: BlockType.Text}
}

function blockAt(view: EditorView, pos: number): BlockInfo {
  let line = view.lineBlockAt(pos)
  if (Array.isArray(line.type)) for (let l of line.type) {
    if (l.to > pos || l.to == pos && (l.to == line.to || l.type == BlockType.Text)) return l
  }
  return line as any
}

function measureRange(view: EditorView, range: SelectionRange): PlainLayerMarker[] {
  if (range.to <= view.viewport.from || range.from >= view.viewport.to) return []
  let from = Math.max(range.from, view.viewport.from), to = Math.min(range.to, view.viewport.to)

  let ltr = view.textDirection == Direction.LTR
  let content = view.contentDOM, contentRect = content.getBoundingClientRect(), base = getBase(view)
  let lineStyle = window.getComputedStyle(content.firstChild as HTMLElement)
  let leftSide = contentRect.left + parseInt(lineStyle.paddingLeft) + Math.min(0, parseInt(lineStyle.textIndent))
  let rightSide = contentRect.right - parseInt(lineStyle.paddingRight)

  let startBlock = blockAt(view, from), endBlock = blockAt(view, to)
  let visualStart: {from: number, to: number} | null = startBlock.type == BlockType.Text ? startBlock : null
  let visualEnd: {from: number, to: number} | null = endBlock.type == BlockType.Text ? endBlock : null
  if (view.lineWrapping) {
    if (visualStart) visualStart = wrappedLine(view, from, visualStart)
    if (visualEnd) visualEnd = wrappedLine(view, to, visualEnd)
  }
  if (visualStart && visualEnd && visualStart.from == visualEnd.from) {
    return pieces(drawForLine(range.from, range.to, visualStart))
  } else {
    let top = visualStart ? drawForLine(range.from, null, visualStart) : drawForWidget(startBlock, false)
    let bottom = visualEnd ? drawForLine(null, range.to, visualEnd) : drawForWidget(endBlock, true)
    let between = []
    if ((visualStart || startBlock).to < (visualEnd || endBlock).from - 1)
      between.push(piece(leftSide, top.bottom, rightSide, bottom.top))
    else if (top.bottom < bottom.top && view.elementAtHeight((top.bottom + bottom.top) / 2).type == BlockType.Text)
      top.bottom = bottom.top = (top.bottom + bottom.top) / 2
    return pieces(top).concat(between).concat(pieces(bottom))
  }

  function piece(left: number, top: number, right: number, bottom: number) {
    return new PlainLayerMarker("cm-selectionBackground",
                                left - base.left, top - base.top - C.Epsilon, right - left, bottom - top + C.Epsilon)
  }
  function pieces({top, bottom, horizontal}: {top: number, bottom: number, horizontal: number[]}) {
    let pieces = []
    for (let i = 0; i < horizontal.length; i += 2)
      pieces.push(piece(horizontal[i], top, horizontal[i + 1], bottom))
    return pieces
  }

  // Gets passed from/to in line-local positions
  function drawForLine(from: null | number, to: null | number, line: {from: number, to: number}) {
    let top = 1e9, bottom = -1e9, horizontal: number[] = []
    function addSpan(from: number, fromOpen: boolean, to: number, toOpen: boolean, dir: Direction) {
      // Passing 2/-2 is a kludge to force the view to return
      // coordinates on the proper side of block widgets, since
      // normalizing the side there, though appropriate for most
      // coordsAtPos queries, would break selection drawing.
      let fromCoords = view.coordsAtPos(from, (from == line.to ? -2 : 2) as any)!
      let toCoords = view.coordsAtPos(to, (to == line.from ? 2 : -2) as any)!
      top = Math.min(fromCoords.top, toCoords.top, top)
      bottom = Math.max(fromCoords.bottom, toCoords.bottom, bottom)
      if (dir == Direction.LTR)
        horizontal.push(ltr && fromOpen ? leftSide : fromCoords.left,
                        ltr && toOpen ? rightSide : toCoords.right)
      else
        horizontal.push(!ltr && toOpen ? leftSide : toCoords.left,
                        !ltr && fromOpen ? rightSide : fromCoords.right)
    }

    let start = from ?? line.from, end = to ?? line.to
    // Split the range by visible range and document line
    for (let r of view.visibleRanges) if (r.to > start && r.from < end) {
      for (let pos = Math.max(r.from, start), endPos = Math.min(r.to, end);;) {
        let docLine = view.state.doc.lineAt(pos)
        for (let span of view.bidiSpans(docLine)) {
          let spanFrom = span.from + docLine.from, spanTo = span.to + docLine.from
          if (spanFrom >= endPos) break
          if (spanTo > pos)
            addSpan(Math.max(spanFrom, pos), from == null && spanFrom <= start,
                    Math.min(spanTo, endPos), to == null && spanTo >= end, span.dir)
        }
        pos = docLine.to + 1
        if (pos >= endPos) break
      }
    }
    if (horizontal.length == 0) addSpan(start, from == null, end, to == null, view.textDirection)
 
    return {top, bottom, horizontal}
  }

  function drawForWidget(block: BlockInfo, top: boolean) {
    let y = contentRect.top + (top ? block.top : block.bottom)
    return {top: y, bottom: y, horizontal: []}
  }
}

function measureCursor(view: EditorView, cursor: SelectionRange, primary: boolean): PlainLayerMarker | null {
  let pos = view.coordsAtPos(cursor.head, cursor.assoc || 1)
  if (!pos) return null
  let base = getBase(view)
  return new PlainLayerMarker(primary ? "cm-cursor cm-cursor-primary" : "cm-cursor cm-cursor-secondary",
                              pos.left - base.left, pos.top - base.top, -1, pos.bottom - pos.top)
}
