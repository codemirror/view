import {Text} from "@codemirror/text"
import {EditorState, ChangeSet, ChangeDesc, SelectionRange} from "@codemirror/state"
import {RangeSet} from "@codemirror/rangeset"
import {Rect} from "./dom"
import {HeightMap, HeightOracle, BlockInfo, MeasuredHeights, QueryType, heightRelevantDecoChanges} from "./heightmap"
import {decorations, ViewUpdate, UpdateFlag, ChangedRange} from "./extension"
import {WidgetType, Decoration, DecorationSet} from "./decoration"
import {DocView} from "./docview"
import {Direction} from "./bidi"

function visiblePixelRange(dom: HTMLElement, paddingTop: number): Rect {
  let rect = dom.getBoundingClientRect()
  let left = Math.max(0, rect.left), right = Math.min(innerWidth, rect.right)
  let top = Math.max(0, rect.top), bottom = Math.min(innerHeight, rect.bottom)
  for (let parent = dom.parentNode as any; parent;) { // (Cast to any because TypeScript is useless with Node types)
    if (parent.nodeType == 1) {
      let style = window.getComputedStyle(parent)
      if ((parent.scrollHeight > parent.clientHeight || parent.scrollWidth > parent.clientWidth) &&
          style.overflow != "visible") {
        let parentRect = parent.getBoundingClientRect()
        left = Math.max(left, parentRect.left)
        right = Math.min(right, parentRect.right)
        top = Math.max(top, parentRect.top)
        bottom = Math.min(bottom, parentRect.bottom)
      }
      parent = style.position == "absolute" || style.position == "fixed" ? parent.offsetParent : parent.parentNode
    } else if (parent.nodeType == 11) { // Shadow root
      parent = parent.host
    } else {
      break
    }
  }
  
  return {left: left - rect.left, right: right - rect.left,
          top: top - (rect.top + paddingTop), bottom: bottom - (rect.top + paddingTop)}
}

const enum VP {
  // FIXME look into appropriate value of this through benchmarking etc
  Margin = 1000,
  // coveredBy requires at least this many extra pixels to be covered
  MinCoverMargin = 10,
  MaxCoverMargin = VP.Margin / 4,
  // Beyond this size, DOM layout starts to break down in browsers
  // because they use fixed-precision numbers to store dimensions.
  MaxDOMHeight = 7e6
}

// Line gaps are placeholder widgets used to hide pieces of overlong
// lines within the viewport, as a kludge to keep the editor
// responsive when a ridiculously long line is loaded into it.
export class LineGap {
  constructor(readonly from: number, readonly to: number, readonly size: number) {}

  static same(a: readonly LineGap[], b: readonly LineGap[]) {
    if (a.length != b.length) return false
    for (let i = 0; i < a.length; i++) {
      let gA = a[i], gB = b[i]
      if (gA.from != gB.from || gA.to != gB.to || gA.size != gB.size) return false
    }
    return true
  }

  draw(wrapping: boolean) {
    return Decoration.replace({widget: new LineGapWidget(this.size, wrapping)}).range(this.from, this.to)
  }
}

class LineGapWidget extends WidgetType {
  constructor(readonly size: number,
              readonly vertical: boolean) { super() }

  eq(other: LineGapWidget) { return other.size == this.size && other.vertical == this.vertical }

  toDOM() {
    let elt = document.createElement("div")
    if (this.vertical) {
      elt.style.height = this.size + "px"
    } else {
      elt.style.width = this.size + "px"
      elt.style.height = "2px"
      elt.style.display = "inline-block"
    }
    return elt
  }

  get estimatedHeight() { return this.vertical ? this.size : -1 }
}

const enum LG { Margin = 10000, HalfMargin = LG.Margin >> 1,  MinViewPort = LG.Margin * 1.5 }

export class ViewState {
  // These are contentDOM-local coordinates
  pixelViewport: Rect = {left: 0, right: window.innerWidth, top: 0, bottom: 0}
  inView = true

  paddingTop = 0
  paddingBottom = 0
  contentWidth = 0

  heightOracle: HeightOracle = new HeightOracle
  heightMap: HeightMap
  // See VP.MaxDOMHeight
  scaler = IdScaler

  scrollTo: SelectionRange | null = null
  // Briefly set to true when printing, to disable viewport limiting
  printing = false

  // The main viewport for the visible part of the document
  viewport: Viewport
  // If the main selection starts or ends outside of the main
  // viewport, extra single-line viewports are created for these
  // points, so that the DOM selection doesn't fall in a gap.
  viewports!: readonly Viewport[]
  visibleRanges: readonly {from: number, to: number}[] = []
  lineGaps: readonly LineGap[]
  lineGapDeco: DecorationSet

  // Cursor 'assoc' is only significant when the cursor is on a line
  // wrap point, where it must stick to the character that it is
  // associated with. Since browsers don't provide a reasonable
  // interface to set or query this, when a selection is set that
  // might cause this to be significant, this flag is set. The next
  // measure phase will check whether the cursor is on a line-wrapping
  // boundary and, if so, reset it to make sure it is positioned in
  // the right place.
  mustEnforceCursorAssoc = false

  constructor(public state: EditorState) {
    this.heightMap = HeightMap.empty().applyChanges(state.facet(decorations), Text.empty, this.heightOracle.setDoc(state.doc),
                                                    [new ChangedRange(0, 0, 0, state.doc.length)])
    this.viewport = this.getViewport(0, null)
    this.updateForViewport()
    this.lineGaps = this.ensureLineGaps([])
    this.lineGapDeco = Decoration.set(this.lineGaps.map(gap => gap.draw(false)))
    this.computeVisibleRanges()
  }

  updateForViewport() {
    let viewports = [this.viewport], {main} = this.state.selection
    for (let i = 0; i <= 1; i++) {
      let pos = i ? main.head : main.anchor
      if (!viewports.some(({from, to}) => pos >= from && pos <= to)) {
        let {from, to} = this.lineAt(pos, 0)
        viewports.push(new Viewport(from, to))
      }
    }
    this.viewports = viewports.sort((a, b) => a.from - b.from)

    this.scaler = this.heightMap.height <= VP.MaxDOMHeight ? IdScaler :
      new BigScaler(this.heightOracle.doc, this.heightMap, this.viewports)
  }

  update(update: ViewUpdate, scrollTo: SelectionRange | null = null) {
    let prev = this.state
    this.state = update.state
    let newDeco = this.state.facet(decorations)
    let contentChanges = update.changedRanges
    
    let heightChanges = ChangedRange.extendWithRanges(contentChanges, heightRelevantDecoChanges(
      update.startState.facet(decorations), newDeco, update ? update.changes : ChangeSet.empty(this.state.doc.length)))
    let prevHeight = this.heightMap.height
    this.heightMap = this.heightMap.applyChanges(newDeco, prev.doc, this.heightOracle.setDoc(this.state.doc), heightChanges)
    if (this.heightMap.height != prevHeight) update.flags |= UpdateFlag.Height

    let viewport = heightChanges.length ? this.mapViewport(this.viewport, update.changes) : this.viewport
    if (scrollTo && (scrollTo.head < viewport.from || scrollTo.head > viewport.to) || !this.viewportIsAppropriate(viewport))
      viewport = this.getViewport(0, scrollTo)
    this.viewport = viewport
    this.updateForViewport()
    if (this.lineGaps.length || this.viewport.to - this.viewport.from > LG.MinViewPort)
      this.updateLineGaps(this.ensureLineGaps(this.mapLineGaps(this.lineGaps, update.changes)))
    update.flags |= this.computeVisibleRanges()

    if (scrollTo) this.scrollTo = scrollTo

    if (!this.mustEnforceCursorAssoc && update.selectionSet && update.view.lineWrapping &&
        update.state.selection.main.empty && update.state.selection.main.assoc)
      this.mustEnforceCursorAssoc = true
  }

  measure(docView: DocView, repeated: boolean) {
    let dom = docView.dom, whiteSpace = "", direction: Direction = Direction.LTR

    let result = 0

    if (!repeated) {
      // Vertical padding
      let style = window.getComputedStyle(dom)
      whiteSpace = style.whiteSpace!, direction = (style.direction == "rtl" ? Direction.RTL : Direction.LTR) as any
      let paddingTop = parseInt(style.paddingTop!) || 0, paddingBottom = parseInt(style.paddingBottom!) || 0
      if (this.paddingTop != paddingTop || this.paddingBottom != paddingBottom) {
        result |= UpdateFlag.Geometry
        this.paddingTop = paddingTop
        this.paddingBottom = paddingBottom
      }
    }

    // Pixel viewport
    let pixelViewport = this.printing ? {top: -1e8, bottom: 1e8, left: -1e8, right: 1e8} : visiblePixelRange(dom, this.paddingTop)
    let dTop = pixelViewport.top - this.pixelViewport.top, dBottom = pixelViewport.bottom - this.pixelViewport.bottom
    this.pixelViewport = pixelViewport
    this.inView = this.pixelViewport.bottom > this.pixelViewport.top && this.pixelViewport.right > this.pixelViewport.left
    if (!this.inView) return 0

    let lineHeights = docView.measureVisibleLineHeights()
    let refresh = false, bias = 0, oracle = this.heightOracle

    if (!repeated) {
      let contentWidth = docView.dom.clientWidth
      if (oracle.mustRefresh(lineHeights, whiteSpace, direction) ||
          oracle.lineWrapping && Math.abs(contentWidth - this.contentWidth) > oracle.charWidth) {
        let {lineHeight, charWidth} = docView.measureTextSize()
        refresh = oracle.refresh(whiteSpace, direction, lineHeight, charWidth, contentWidth / charWidth, lineHeights)
        if (refresh) {
          docView.minWidth = 0
          result |= UpdateFlag.Geometry
        }
      }
      if (this.contentWidth != contentWidth) {
        this.contentWidth = contentWidth
        result |= UpdateFlag.Geometry
      }

      if (dTop > 0 && dBottom > 0) bias = Math.max(dTop, dBottom)
      else if (dTop < 0 && dBottom < 0) bias = Math.min(dTop, dBottom)
    }

    oracle.heightChanged = false
    this.heightMap = this.heightMap.updateHeight(
      oracle, 0, refresh, new MeasuredHeights(this.viewport.from, lineHeights))

    if (oracle.heightChanged) result |= UpdateFlag.Height
    if (!this.viewportIsAppropriate(this.viewport, bias) ||
        this.scrollTo && (this.scrollTo.head < this.viewport.from || this.scrollTo.head > this.viewport.to))
      this.viewport = this.getViewport(bias, this.scrollTo)

    this.updateForViewport()
    if (this.lineGaps.length || this.viewport.to - this.viewport.from > LG.MinViewPort)
      this.updateLineGaps(this.ensureLineGaps(refresh ? [] : this.lineGaps))
    result |= this.computeVisibleRanges()

    if (this.mustEnforceCursorAssoc) {
      this.mustEnforceCursorAssoc = false
      // This is done in the read stage, because moving the selection
      // to a line end is going to trigger a layout anyway, so it
      // can't be a pure write. It should be rare that it does any
      // writing.
      docView.enforceCursorAssoc()
    }

    return result
  }

  get visibleTop() { return this.scaler.fromDOM(this.pixelViewport.top, 0) }
  get visibleBottom() { return this.scaler.fromDOM(this.pixelViewport.bottom, 0) }

  getViewport(bias: number, scrollTo: SelectionRange | null): Viewport {
    // This will divide VP.Margin between the top and the
    // bottom, depending on the bias (the change in viewport position
    // since the last update). It'll hold a number between 0 and 1
    let marginTop = 0.5 - Math.max(-0.5, Math.min(0.5, bias / VP.Margin / 2))
    let map = this.heightMap, doc = this.state.doc, {visibleTop, visibleBottom} = this
    let viewport = new Viewport(map.lineAt(visibleTop - marginTop * VP.Margin, QueryType.ByHeight, doc, 0, 0).from,
                                map.lineAt(visibleBottom + (1 - marginTop) * VP.Margin, QueryType.ByHeight, doc, 0, 0).to)
    // If scrollTo is given, make sure the viewport includes that position
    if (scrollTo) {
      if (scrollTo.head < viewport.from) {
        let {top: newTop} = map.lineAt(scrollTo.head, QueryType.ByPos, doc, 0, 0)
        viewport = new Viewport(map.lineAt(newTop - VP.Margin / 2, QueryType.ByHeight, doc, 0, 0).from,
                                map.lineAt(newTop + (visibleBottom - visibleTop) + VP.Margin / 2, QueryType.ByHeight, doc, 0, 0).to)
      } else if (scrollTo.head > viewport.to) {
        let {bottom: newBottom} = map.lineAt(scrollTo.head, QueryType.ByPos, doc, 0, 0)
        viewport = new Viewport(map.lineAt(newBottom - (visibleBottom - visibleTop) - VP.Margin / 2,
                                           QueryType.ByHeight, doc, 0, 0).from,
                                map.lineAt(newBottom + VP.Margin / 2, QueryType.ByHeight, doc, 0, 0).to)
      }
    }
    return viewport
  }

  mapViewport(viewport: Viewport, changes: ChangeDesc) {
    let from = changes.mapPos(viewport.from, -1), to = changes.mapPos(viewport.to, 1)
    return new Viewport(this.heightMap.lineAt(from, QueryType.ByPos, this.state.doc, 0, 0).from,
                        this.heightMap.lineAt(to, QueryType.ByPos, this.state.doc, 0, 0).to)
  }

  // Checks if a given viewport covers the visible part of the
  // document and not too much beyond that.
  viewportIsAppropriate({from, to}: Viewport, bias = 0) {
    let {top} = this.heightMap.lineAt(from, QueryType.ByPos, this.state.doc, 0, 0)
    let {bottom} = this.heightMap.lineAt(to, QueryType.ByPos, this.state.doc, 0, 0)
    let {visibleTop, visibleBottom} = this
    return (from == 0 || top <= visibleTop - Math.max(VP.MinCoverMargin, Math.min(-bias, VP.MaxCoverMargin))) &&
      (to == this.state.doc.length ||
       bottom >= visibleBottom + Math.max(VP.MinCoverMargin, Math.min(bias, VP.MaxCoverMargin))) &&
      (top > visibleTop - 2 * VP.Margin && bottom < visibleBottom + 2 * VP.Margin)
  }

  mapLineGaps(gaps: readonly LineGap[], changes: ChangeSet) {
    if (!gaps.length || changes.empty) return gaps
    let mapped = []
    for (let gap of gaps) if (!changes.touchesRange(gap.from, gap.to))
      mapped.push(new LineGap(changes.mapPos(gap.from), changes.mapPos(gap.to), gap.size))
    return mapped
  }

  // Computes positions in the viewport where the start or end of a
  // line should be hidden, trying to reuse existing line gaps when
  // appropriate to avoid unneccesary redraws.
  // Uses crude character-counting for the positioning and sizing,
  // since actual DOM coordinates aren't always available and
  // predictable. Relies on generous margins (see LG.Margin) to hide
  // the artifacts this might produce from the user.
  ensureLineGaps(current: readonly LineGap[]) {
    let gaps: LineGap[] = []
    // This won't work at all in predominantly right-to-left text.
    if (this.heightOracle.direction != Direction.LTR) return gaps
    this.heightMap.forEachLine(this.viewport.from, this.viewport.to, this.state.doc, 0, 0, line => {
      if (line.length < LG.Margin) return
      let structure = lineStructure(line.from, line.to, this.state)
      if (structure.total < LG.Margin) return
      let viewFrom, viewTo
      if (this.heightOracle.lineWrapping) {
        if (line.from != this.viewport.from) viewFrom = line.from
        else viewFrom = findPosition(structure, (this.visibleTop - line.top) / line.height)
        if (line.to != this.viewport.to) viewTo = line.to
        else viewTo = findPosition(structure, (this.visibleBottom - line.top) / line.height)
      } else {
        let totalWidth = structure.total * this.heightOracle.charWidth
        viewFrom = findPosition(structure, this.pixelViewport.left / totalWidth)
        viewTo = findPosition(structure, this.pixelViewport.right / totalWidth)
      }
      let sel = this.state.selection.main
      // Make sure the gap doesn't cover a selection end
      if (sel.from <= viewFrom && sel.to >= line.from) viewFrom = sel.from
      if (sel.from <= line.to && sel.to >= viewTo) viewTo = sel.to
      let gapTo = viewFrom - LG.Margin, gapFrom = viewTo + LG.Margin
      if (gapTo > line.from + LG.HalfMargin)
        gaps.push(find(current, gap => gap.from == line.from && gap.to > gapTo - LG.HalfMargin && gap.to < gapTo + LG.HalfMargin) ||
                  new LineGap(line.from, gapTo, this.gapSize(line, gapTo, true, structure)))
      if (gapFrom < line.to - LG.HalfMargin)
        gaps.push(find(current, gap => gap.to == line.to && gap.from > gapFrom - LG.HalfMargin &&
                       gap.from < gapFrom + LG.HalfMargin) ||
                  new LineGap(gapFrom, line.to, this.gapSize(line, gapFrom, false, structure)))
    })
    return gaps
  }

  gapSize(line: BlockInfo, pos: number, start: boolean,
          structure: {total: number, ranges: {from: number, to: number}[]}) {
    if (this.heightOracle.lineWrapping) {
      let height = line.height * findFraction(structure, pos)
      return start ? height : line.height - height
    } else {
      let ratio = findFraction(structure, pos)
      return structure.total * this.heightOracle.charWidth * (start ? ratio : 1 - ratio)
    }
  }

  updateLineGaps(gaps: readonly LineGap[]) {
    if (!LineGap.same(gaps, this.lineGaps)) {
      this.lineGaps = gaps
      this.lineGapDeco = Decoration.set(gaps.map(gap => gap.draw(this.heightOracle.lineWrapping)))
    }
  }

  computeVisibleRanges() {
    let deco = this.state.facet(decorations)
    if (this.lineGaps.length) deco = deco.concat(this.lineGapDeco)
    let ranges: {from: number, to: number}[] = []
    RangeSet.spans(deco, this.viewport.from, this.viewport.to, {
      span(from, to) { ranges.push({from, to}) },
      point() {}
    }, 20)
    let changed = ranges.length != this.visibleRanges.length ||
      this.visibleRanges.some((r, i) => r.from != ranges[i].from || r.to != ranges[i].to)
    this.visibleRanges = ranges
    return changed ? UpdateFlag.Viewport : 0
  }

  lineAt(pos: number, editorTop: number): BlockInfo {
    editorTop += this.paddingTop
    return scaleBlock(this.heightMap.lineAt(pos, QueryType.ByPos, this.state.doc, editorTop, 0),
                      this.scaler, editorTop)
  }

  lineAtHeight(height: number, editorTop: number): BlockInfo {
    editorTop += this.paddingTop
    return scaleBlock(this.heightMap.lineAt(this.scaler.fromDOM(height, editorTop), QueryType.ByHeight,
                                            this.state.doc, editorTop, 0), this.scaler, editorTop)
  }

  blockAtHeight(height: number, editorTop: number): BlockInfo {
    editorTop += this.paddingTop
    return scaleBlock(this.heightMap.blockAt(this.scaler.fromDOM(height, editorTop), this.state.doc, editorTop, 0),
                      this.scaler, editorTop)
  }

  forEachLine(from: number, to: number, f: (line: BlockInfo) => void, editorTop: number) {
    editorTop += this.paddingTop
    return this.heightMap.forEachLine(from, to, this.state.doc, editorTop, 0,
                                      this.scaler.scale == 1 ? f : b => f(scaleBlock(b, this.scaler, editorTop)))
  }

  get contentHeight() {
    return this.domHeight + this.paddingTop + this.paddingBottom
  }

  get domHeight() {
    return this.scaler.toDOM(this.heightMap.height, this.paddingTop)
  }
}

export class Viewport {
  constructor(readonly from: number, readonly to: number) {}
}

function lineStructure(from: number, to: number, state: EditorState) {
  let ranges = [], pos = from, total = 0
  RangeSet.spans(state.facet(decorations), from, to, {
    span() {},
    point(from, to) {
      if (from > pos) { ranges.push({from: pos, to: from}); total += from - pos }
      pos = to
    }
  }, 20) // We're only interested in collapsed ranges of a significant size
  if (pos < to) { ranges.push({from: pos, to}); total += to - pos }
  return {total, ranges}
}

function findPosition({total, ranges}: {total: number, ranges: {from: number, to: number}[]}, ratio: number): number {
  if (ratio <= 0) return ranges[0].from
  if (ratio >= 1) return ranges[ranges.length - 1].to
  let dist = Math.floor(total * ratio)
  for (let i = 0;; i++) {
    let {from, to} = ranges[i], size = to - from
    if (dist <= size) return from + dist
    dist -= size
  }
}

function findFraction(structure: {total: number, ranges: {from: number, to: number}[]}, pos: number) {
  let counted = 0
  for (let {from, to} of structure.ranges) {
    if (pos <= to) {
      counted += pos - from
      break
    }
    counted += to - from
  }
  return counted / structure.total
}

function find<T>(array: readonly T[], f: (value: T) => boolean): T | undefined {
  for (let val of array) if (f(val)) return val
  return undefined
}

// Convert between heightmap heights and DOM heights (see
// VP.MaxDOMHeight)
type YScaler = {
  toDOM(n: number, top: number): number
  fromDOM(n: number, top: number): number
  scale: number
}

// Don't scale when the document height is within the range of what
// the DOM can handle.
const IdScaler: YScaler = {
  toDOM(n: number) { return n },
  fromDOM(n: number) { return n },
  scale: 1
}

// When the height is too big (> VP.MaxDOMHeight), scale down the
// regions outside the viewports so that the total height is
// VP.MaxDOMHeight.
class BigScaler implements YScaler {
  scale: number
  viewports: {from: number, to: number, top: number, bottom: number, domTop: number, domBottom: number}[]

  constructor(doc: Text, heightMap: HeightMap, viewports: readonly Viewport[]) {
    let vpHeight = 0, base = 0, domBase = 0
    this.viewports = viewports.map(({from, to}) => {
      let top = heightMap.lineAt(from, QueryType.ByPos, doc, 0, 0).top
      let bottom = heightMap.lineAt(to, QueryType.ByPos, doc, 0, 0).bottom
      vpHeight += bottom - top
      return {from, to, top, bottom, domTop: 0, domBottom: 0}
    })
    this.scale = (VP.MaxDOMHeight - vpHeight) / (heightMap.height - vpHeight)
    for (let obj of this.viewports) {
      obj.domTop = domBase + (obj.top - base) * this.scale
      domBase = obj.domBottom = obj.domTop + (obj.bottom - obj.top)
      base = obj.bottom
    }
  }

  toDOM(n: number, top: number) {
    n -= top
    for (let i = 0, base = 0, domBase = 0;; i++) {
      let vp = i < this.viewports.length ? this.viewports[i] : null
      if (!vp || n < vp.top) return domBase + (n - base) * this.scale + top
      if (n <= vp.bottom) return vp.domTop + (n - vp.top) + top
      base = vp.bottom; domBase = vp.domBottom
    }
  }
  
  fromDOM(n: number, top: number) {
    n -= top
    for (let i = 0, base = 0, domBase = 0;; i++) {
      let vp = i < this.viewports.length ? this.viewports[i] : null
      if (!vp || n < vp.domTop) return base + (n - domBase) / this.scale + top
      if (n <= vp.domBottom) return vp.top + (n - vp.domTop) + top
      base = vp.bottom; domBase = vp.domBottom
    }
  }
}

function scaleBlock(block: BlockInfo, scaler: YScaler, top: number): BlockInfo {
  if (scaler.scale == 1) return block
  let bTop = scaler.toDOM(block.top, top), bBottom = scaler.toDOM(block.bottom, top)
  return new BlockInfo(block.from, block.length, bTop, bBottom - bTop,
                       Array.isArray(block.type) ? block.type.map(b => scaleBlock(b, scaler, top)) : block.type)
}
