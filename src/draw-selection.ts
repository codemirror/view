import {EditorSelection, SelectionRange, Extension, Facet, combineConfig, Prec} from "@codemirror/state"
import {BlockType} from "./decoration"
import {BlockInfo} from "./heightmap"
import {ViewPlugin, ViewUpdate} from "./extension"
import {EditorView} from "./editorview"
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
    drawSelectionPlugin,
    hideNativeSelection
  ]
}

type Measure = {rangePieces: Piece[], cursors: Piece[]}

class Piece {
  constructor(readonly left: number, readonly top: number,
              readonly width: number, readonly height: number,
              readonly className: string) {}

  draw() {
    let elt = document.createElement("div")
    elt.className = this.className
    this.adjust(elt)
    return elt
  }

  adjust(elt: HTMLElement) {
    elt.style.left = this.left + "px"
    elt.style.top = this.top + "px"
    if (this.width >= 0) elt.style.width = this.width + "px"
    elt.style.height = this.height + "px"
  }

  eq(p: Piece) {
    return this.left == p.left && this.top == p.top && this.width == p.width && this.height == p.height &&
      this.className == p.className
  }
}

const drawSelectionPlugin = ViewPlugin.fromClass(class {
  rangePieces: readonly Piece[] = []
  cursors: readonly Piece[] = []
  measureReq: {read: () => Measure, write: (value: Measure) => void}
  selectionLayer: HTMLElement
  cursorLayer: HTMLElement

  constructor(readonly view: EditorView) {
    this.measureReq = {read: this.readPos.bind(this), write: this.drawSel.bind(this)}
    this.selectionLayer = view.scrollDOM.appendChild(document.createElement("div"))
    this.selectionLayer.className = "cm-selectionLayer"
    this.selectionLayer.setAttribute("aria-hidden", "true")
    this.cursorLayer = view.scrollDOM.appendChild(document.createElement("div"))
    this.cursorLayer.className = "cm-cursorLayer"
    this.cursorLayer.setAttribute("aria-hidden", "true")
    view.requestMeasure(this.measureReq)
    this.setBlinkRate()
  }

  setBlinkRate() {
    this.cursorLayer.style.animationDuration = this.view.state.facet(selectionConfig).cursorBlinkRate + "ms"
  }

  update(update: ViewUpdate) {
    let confChanged = update.startState.facet(selectionConfig) != update.state.facet(selectionConfig)
    if (confChanged || update.selectionSet || update.geometryChanged || update.viewportChanged)
      this.view.requestMeasure(this.measureReq)
    if (update.transactions.some(tr => tr.scrollIntoView))
      this.cursorLayer.style.animationName = this.cursorLayer.style.animationName == "cm-blink" ? "cm-blink2" : "cm-blink"
    if (confChanged) this.setBlinkRate()
  }

  readPos(): Measure {
    let {state} = this.view, conf = state.facet(selectionConfig)
    let rangePieces = state.selection.ranges.map(r => r.empty ? [] : measureRange(this.view, r)).reduce((a, b) => a.concat(b))
    let cursors = []
    for (let r of state.selection.ranges) {
      let prim = r == state.selection.main
      if (r.empty ? !prim || CanHidePrimary : conf.drawRangeCursor) {
        let piece = measureCursor(this.view, r, prim)
        if (piece) cursors.push(piece)
      }
    }
    return {rangePieces, cursors}
  }

  drawSel({rangePieces, cursors}: Measure) {
    if (rangePieces.length != this.rangePieces.length || rangePieces.some((p, i) => !p.eq(this.rangePieces[i]))) {
      this.selectionLayer.textContent = ""
      for (let p of rangePieces) this.selectionLayer.appendChild(p.draw())
      this.rangePieces = rangePieces
    }
    if (cursors.length != this.cursors.length || cursors.some((c, i) => !c.eq(this.cursors[i]))) {
      let oldCursors = this.cursorLayer.children
      if (oldCursors.length !== cursors.length) {
        this.cursorLayer.textContent = ""
        for (const c of cursors)
          this.cursorLayer.appendChild(c.draw())
      } else {
        cursors.forEach((c, idx) => c.adjust(oldCursors[idx] as HTMLElement))
      }
      this.cursors = cursors
    }
  }

  destroy() {
    this.selectionLayer.remove()
    this.cursorLayer.remove()
  }
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

function measureRange(view: EditorView, range: SelectionRange): Piece[] {
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
    return new Piece(left - base.left, top - base.top - C.Epsilon, right - left, bottom - top + C.Epsilon,
                     "cm-selectionBackground")
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

function measureCursor(view: EditorView, cursor: SelectionRange, primary: boolean): Piece | null {
  let pos = view.coordsAtPos(cursor.head, cursor.assoc || 1)
  if (!pos) return null
  let base = getBase(view)
  return new Piece(pos.left - base.left, pos.top - base.top, -1, pos.bottom - pos.top,
                   primary ? "cm-cursor cm-cursor-primary" : "cm-cursor cm-cursor-secondary")
}
