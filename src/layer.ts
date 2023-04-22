import {Extension, Facet, EditorState, EditorSelection, SelectionRange} from "@codemirror/state"
import {ViewPlugin, ViewUpdate} from "./extension"
import {EditorView} from "./editorview"
import {Direction} from "./bidi"
import {BlockType} from "./decoration"
import {BlockInfo} from "./heightmap"

/// Markers shown in a [layer](#view.layer) must conform to this
/// interface. They are created in a measuring phase, and have to
/// contain all their positioning information, so that they can be
/// drawn without further DOM layout reading.
///
/// Markers are automatically absolutely positioned. Their parent
/// element has the same top-left corner as the document, so they
/// should be positioned relative to the document.
export interface LayerMarker {
  /// Compare this marker to a marker of the same type. Used to avoid
  /// unnecessary redraws.
  eq(other: LayerMarker): boolean
  /// Draw the marker to the DOM.
  draw(): HTMLElement
  /// Update an existing marker of this type to this marker.
  update?(dom: HTMLElement, oldMarker: LayerMarker): boolean
}

/// Implementation of [`LayerMarker`](#view.LayerMarker) that creates
/// a rectangle at a given set of coordinates.
export class RectangleMarker implements LayerMarker {
  /// Create a marker with the given class and dimensions. If `width`
  /// is null, the DOM element will get no width style.
  constructor(private className: string,
              private left: number, private top: number,
              private width: number | null, private height: number) {}

  draw() {
    let elt = document.createElement("div")
    elt.className = this.className
    this.adjust(elt)
    return elt
  }

  update(elt: HTMLElement, prev: RectangleMarker) {
    if (prev.className != this.className) return false
    this.adjust(elt)
    return true
  }

  private adjust(elt: HTMLElement) {
    elt.style.left = this.left + "px"
    elt.style.top = this.top + "px"
    if (this.width != null) elt.style.width = this.width + "px"
    elt.style.height = this.height + "px"
  }

  eq(p: RectangleMarker) {
    return this.left == p.left && this.top == p.top && this.width == p.width && this.height == p.height &&
      this.className == p.className
  }

  /// Create a set of rectangles for the given selection range,
  /// assigning them theclass`className`. Will create a single
  /// rectangle for empty ranges, and a set of selection-style
  /// rectangles covering the range's content (in a bidi-aware
  /// way) for non-empty ones.
  static forRange(view: EditorView, className: string, range: SelectionRange): readonly RectangleMarker[] {
    if (range.empty) {
      let pos = view.coordsAtPos(range.head, range.assoc || 1)
      if (!pos) return []
      let base = getBase(view)
      return [new RectangleMarker(className, pos.left - base.left, pos.top - base.top, null, pos.bottom - pos.top)]
    } else {
      return rectanglesForRange(view, className, range)
    }
  }
}

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

// Added to range rectangle's vertical extent to prevent rounding
// errors from introducing gaps in the rendered content.
const enum C { Epsilon = 0.01 }

function rectanglesForRange(view: EditorView, className: string, range: SelectionRange): RectangleMarker[] {
  if (range.to <= view.viewport.from || range.from >= view.viewport.to) return []
  let from = Math.max(range.from, view.viewport.from), to = Math.min(range.to, view.viewport.to)

  let ltr = view.textDirection == Direction.LTR
  let content = view.contentDOM, contentRect = content.getBoundingClientRect(), base = getBase(view)
  let lineElt = content.querySelector(".cm-line"), lineStyle = lineElt && window.getComputedStyle(lineElt)
  let leftSide = contentRect.left +
    (lineStyle ? parseInt(lineStyle.paddingLeft) + Math.min(0, parseInt(lineStyle.textIndent)) : 0)
  let rightSide = contentRect.right - (lineStyle ? parseInt(lineStyle.paddingRight) : 0)

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
    return new RectangleMarker(className, left - base.left, top - base.top - C.Epsilon,
                               right - left, bottom - top + C.Epsilon)
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
      let fromCoords = view.coordsAtPos(from, (from == line.to ? -2 : 2) as any)
      let toCoords = view.coordsAtPos(to, (to == line.from ? 2 : -2) as any)
      if (!fromCoords || !toCoords) return;
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

interface LayerConfig {
  /// Determines whether this layer is shown above or below the text.
  above: boolean,
  /// When given, this class is added to the DOM element that will
  /// wrap the markers.
  class?: string
  /// Called on every view update. Returning true triggers a marker
  /// update (a call to `markers` and drawing of those markers).
  update(update: ViewUpdate, layer: HTMLElement): boolean
  /// Build a set of markers for this layer, and measure their
  /// dimensions.
  markers(view: EditorView): readonly LayerMarker[]
  /// If given, this is called when the layer is created.
  mount?(layer: HTMLElement, view: EditorView): void
  /// If given, called when the layer is removed from the editor or
  /// the entire editor is destroyed.
  destroy?(layer: HTMLElement, view: EditorView): void
}

function sameMarker(a: LayerMarker, b: LayerMarker) {
  return a.constructor == b.constructor && a.eq(b)
}

class LayerView {
  measureReq: {read: () => readonly LayerMarker[], write: (markers: readonly LayerMarker[]) => void}
  dom: HTMLElement
  drawn: readonly LayerMarker[] = []

  constructor(readonly view: EditorView, readonly layer: LayerConfig) {
    this.measureReq = {read: this.measure.bind(this), write: this.draw.bind(this)}
    this.dom = view.scrollDOM.appendChild(document.createElement("div"))
    this.dom.classList.add("cm-layer")
    if (layer.above) this.dom.classList.add("cm-layer-above")
    if (layer.class) this.dom.classList.add(layer.class)
    this.dom.setAttribute("aria-hidden", "true")
    this.setOrder(view.state)
    view.requestMeasure(this.measureReq)
    if (layer.mount) layer.mount(this.dom, view)
  }

  update(update: ViewUpdate) {
    if (update.startState.facet(layerOrder) != update.state.facet(layerOrder))
      this.setOrder(update.state)
    if (this.layer.update(update, this.dom) || update.geometryChanged)
      update.view.requestMeasure(this.measureReq)
  }

  setOrder(state: EditorState) {
    let pos = 0, order = state.facet(layerOrder)
    while (pos < order.length && order[pos] != this.layer) pos++
    this.dom.style.zIndex = String((this.layer.above ? 150 : -1) - pos)
  }

  measure(): readonly LayerMarker[] {
    return this.layer.markers(this.view)
  }

  draw(markers: readonly LayerMarker[]) {
    if (markers.length != this.drawn.length || markers.some((p, i) => !sameMarker(p, this.drawn[i]))) {
      let old = this.dom.firstChild, oldI = 0
      for (let marker of markers) {
        if (marker.update && old && marker.constructor && this.drawn[oldI].constructor &&
            marker.update(old as HTMLElement, this.drawn[oldI])) {
          old = old.nextSibling
          oldI++
        } else {
          this.dom.insertBefore(marker.draw(), old)
        }
      }
      while (old) {
        let next = old.nextSibling
        old.remove()
        old = next
      }
      this.drawn = markers
    }
  }

  destroy() {
    if (this.layer.destroy) this.layer.destroy(this.dom, this.view)
    this.dom.remove()
  }
}

const layerOrder = Facet.define<LayerConfig>()

/// Define a layer.
export function layer(config: LayerConfig): Extension {
  return [
    ViewPlugin.define(v => new LayerView(v, config)),
    layerOrder.of(config)
  ]
}
