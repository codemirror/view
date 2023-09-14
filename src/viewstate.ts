import {Text, EditorState, ChangeSet, ChangeDesc, RangeSet, EditorSelection} from "@codemirror/state"
import {Rect, isScrolledToBottom} from "./dom"
import {HeightMap, HeightOracle, BlockInfo, MeasuredHeights, QueryType, heightRelevantDecoChanges} from "./heightmap"
import {decorations, ViewUpdate, UpdateFlag, ChangedRange, ScrollTarget, nativeSelectionHidden,
        contentAttributes} from "./extension"
import {WidgetType, Decoration, DecorationSet} from "./decoration"
import {EditorView} from "./editorview"
import {Direction} from "./bidi"

function visiblePixelRange(dom: HTMLElement, paddingTop: number): Rect {
  let rect = dom.getBoundingClientRect()
  let doc = dom.ownerDocument, win = doc.defaultView || window
  let left = Math.max(0, rect.left), right = Math.min(win.innerWidth, rect.right)
  let top = Math.max(0, rect.top), bottom = Math.min(win.innerHeight, rect.bottom)
  for (let parent = dom.parentNode as Node | null; parent && parent != doc.body;) {
    if (parent.nodeType == 1) {
      let elt = parent as HTMLElement
      let style = window.getComputedStyle(elt)
      if ((elt.scrollHeight > elt.clientHeight || elt.scrollWidth > elt.clientWidth) &&
          style.overflow != "visible") {
        let parentRect = elt.getBoundingClientRect()
        left = Math.max(left, parentRect.left)
        right = Math.min(right, parentRect.right)
        top = Math.max(top, parentRect.top)
        bottom = parent == dom.parentNode ? parentRect.bottom : Math.min(bottom, parentRect.bottom)
      }
      parent = style.position == "absolute" || style.position == "fixed" ? elt.offsetParent : elt.parentNode
    } else if (parent.nodeType == 11) { // Shadow root
      parent = (parent as ShadowRoot).host
    } else {
      break
    }
  }

  return {left: left - rect.left, right: Math.max(left, right) - rect.left,
          top: top - (rect.top + paddingTop), bottom: Math.max(top, bottom) - (rect.top + paddingTop)}
}

function fullPixelRange(dom: HTMLElement, paddingTop: number): Rect {
  let rect = dom.getBoundingClientRect()
  return {left: 0, right: rect.right - rect.left,
          top: paddingTop, bottom: rect.bottom - (rect.top + paddingTop)}
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

  draw(viewState: ViewState, wrapping: boolean) {
    return Decoration.replace({
      widget: new LineGapWidget(this.size * (wrapping ? viewState.scaleY : viewState.scaleX), wrapping)
    }).range(this.from, this.to)
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

const enum LG {
  Margin = 2000,
  MarginWrap = 10000,
  SelectionMargin = 10,
}

export class ViewState {
  // These are contentDOM-local coordinates
  pixelViewport: Rect = {left: 0, right: window.innerWidth, top: 0, bottom: 0}
  inView = true

  paddingTop = 0 // Padding above the document, scaled
  paddingBottom = 0 // Padding below the document, scaled
  contentDOMWidth = 0 // contentDOM.getBoundingClientRect().width
  contentDOMHeight = 0 // contentDOM.getBoundingClientRect().height
  editorHeight = 0 // scrollDOM.clientHeight, unscaled
  editorWidth = 0 // scrollDOM.clientWidth, unscaled
  scrollTop = 0 // Last seen scrollDOM.scrollTop, scaled
  scrolledToBottom = true
  // The CSS-transformation scale of the editor (transformed size /
  // concrete size)
  scaleX = 1
  scaleY = 1
  // The vertical position (document-relative) to which to anchor the
  // scroll position. -1 means anchor to the end of the document.
  scrollAnchorPos = 0
  // The height at the anchor position. Set by the DOM update phase.
  // -1 means no height available.
  scrollAnchorHeight = -1

  heightOracle: HeightOracle
  heightMap: HeightMap
  // See VP.MaxDOMHeight
  scaler = IdScaler

  scrollTarget: ScrollTarget | null = null
  // Briefly set to true when printing, to disable viewport limiting
  printing = false
  // Flag set when editor content was redrawn, so that the next
  // measure stage knows it must read DOM layout
  mustMeasureContent = true

  stateDeco: readonly DecorationSet[]
  viewportLines!: BlockInfo[]
  defaultTextDirection: Direction = Direction.LTR

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
    let guessWrapping = state.facet(contentAttributes).some(v => typeof v != "function" && v.class == "cm-lineWrapping")
    this.heightOracle = new HeightOracle(guessWrapping)
    this.stateDeco = state.facet(decorations).filter(d => typeof d != "function") as readonly DecorationSet[]
    this.heightMap = HeightMap.empty().applyChanges(this.stateDeco, Text.empty, this.heightOracle.setDoc(state.doc),
                                                    [new ChangedRange(0, 0, 0, state.doc.length)])
    this.viewport = this.getViewport(0, null)
    this.updateViewportLines()
    this.updateForViewport()
    this.lineGaps = this.ensureLineGaps([])
    this.lineGapDeco = Decoration.set(this.lineGaps.map(gap => gap.draw(this, false)))
    this.computeVisibleRanges()
  }

  updateForViewport() {
    let viewports = [this.viewport], {main} = this.state.selection
    for (let i = 0; i <= 1; i++) {
      let pos = i ? main.head : main.anchor
      if (!viewports.some(({from, to}) => pos >= from && pos <= to)) {
        let {from, to} = this.lineBlockAt(pos)
        viewports.push(new Viewport(from, to))
      }
    }
    this.viewports = viewports.sort((a, b) => a.from - b.from)

    this.scaler = this.heightMap.height <= VP.MaxDOMHeight ? IdScaler :
      new BigScaler(this.heightOracle, this.heightMap, this.viewports)
  }

  updateViewportLines() {
    this.viewportLines = []
    this.heightMap.forEachLine(this.viewport.from, this.viewport.to, this.heightOracle.setDoc(this.state.doc),
                               0, 0, block => {
      this.viewportLines.push(this.scaler.scale == 1 ? block : scaleBlock(block, this.scaler))
    })
  }

  update(update: ViewUpdate, scrollTarget: ScrollTarget | null = null) {
    this.state = update.state
    let prevDeco = this.stateDeco
    this.stateDeco = this.state.facet(decorations).filter(d => typeof d != "function") as readonly DecorationSet[]
    let contentChanges = update.changedRanges
    
    let heightChanges = ChangedRange.extendWithRanges(contentChanges, heightRelevantDecoChanges(
      prevDeco, this.stateDeco, update ? update.changes : ChangeSet.empty(this.state.doc.length)))
    let prevHeight = this.heightMap.height
    let scrollAnchor = this.scrolledToBottom ? null : this.scrollAnchorAt(this.scrollTop)
    this.heightMap = this.heightMap.applyChanges(this.stateDeco, update.startState.doc,
                                                 this.heightOracle.setDoc(this.state.doc), heightChanges)
    if (this.heightMap.height != prevHeight) update.flags |= UpdateFlag.Height
    if (scrollAnchor) {
      this.scrollAnchorPos = update.changes.mapPos(scrollAnchor.from, -1)
      this.scrollAnchorHeight = scrollAnchor.top
    } else {
      this.scrollAnchorPos = -1
      this.scrollAnchorHeight = this.heightMap.height
    }

    let viewport = heightChanges.length ? this.mapViewport(this.viewport, update.changes) : this.viewport
    if (scrollTarget && (scrollTarget.range.head < viewport.from || scrollTarget.range.head > viewport.to) ||
        !this.viewportIsAppropriate(viewport))
      viewport = this.getViewport(0, scrollTarget)
    let updateLines = !update.changes.empty || (update.flags & UpdateFlag.Height) ||
      viewport.from != this.viewport.from || viewport.to != this.viewport.to
    this.viewport = viewport
    this.updateForViewport()
    if (updateLines) this.updateViewportLines()
    if (this.lineGaps.length || this.viewport.to - this.viewport.from > (LG.Margin << 1))
      this.updateLineGaps(this.ensureLineGaps(this.mapLineGaps(this.lineGaps, update.changes)))
    update.flags |= this.computeVisibleRanges()

    if (scrollTarget) this.scrollTarget = scrollTarget

    if (!this.mustEnforceCursorAssoc && update.selectionSet && update.view.lineWrapping &&
        update.state.selection.main.empty && update.state.selection.main.assoc &&
        !update.state.facet(nativeSelectionHidden))
      this.mustEnforceCursorAssoc = true
  }

  measure(view: EditorView) {
    let dom = view.contentDOM, style = window.getComputedStyle(dom)
    let oracle = this.heightOracle
    let whiteSpace = style.whiteSpace!
    this.defaultTextDirection = style.direction == "rtl" ? Direction.RTL : Direction.LTR

    let refresh = this.heightOracle.mustRefreshForWrapping(whiteSpace)
    let domRect = dom.getBoundingClientRect()
    let measureContent = refresh || this.mustMeasureContent || this.contentDOMHeight != domRect.height
    this.contentDOMHeight = domRect.height
    this.mustMeasureContent = false
    let result = 0, bias = 0

    if (domRect.width && domRect.height) {
      let scaleX = domRect.width / dom.offsetWidth
      let scaleY = domRect.height / dom.offsetHeight
      if (scaleX > 0.995 && scaleX < 1.005 || !isFinite(scaleX)) scaleX = 1
      if (scaleY > 0.995 && scaleY < 1.005 || !isFinite(scaleY)) scaleY = 1
      if (this.scaleX != scaleX || this.scaleY != scaleY) {
        this.scaleX = scaleX; this.scaleY = scaleY
        result |= UpdateFlag.Geometry
        refresh = measureContent = true
      }
    }

    // Vertical padding
    let paddingTop = (parseInt(style.paddingTop!) || 0) * this.scaleY
    let paddingBottom = (parseInt(style.paddingBottom!) || 0) * this.scaleY
    if (this.paddingTop != paddingTop || this.paddingBottom != paddingBottom) {
      this.paddingTop = paddingTop
      this.paddingBottom = paddingBottom
      result |= UpdateFlag.Geometry | UpdateFlag.Height
    }
    if (this.editorWidth != view.scrollDOM.clientWidth) {
      if (oracle.lineWrapping) measureContent = true
      this.editorWidth = view.scrollDOM.clientWidth
      result |= UpdateFlag.Geometry
    }
    let scrollTop = view.scrollDOM.scrollTop * this.scaleY
    if (this.scrollTop != scrollTop) {
      this.scrollAnchorHeight = -1
      this.scrollTop = scrollTop
    }
    this.scrolledToBottom = isScrolledToBottom(view.scrollDOM)

    // Pixel viewport
    let pixelViewport = (this.printing ? fullPixelRange : visiblePixelRange)(dom, this.paddingTop)
    let dTop = pixelViewport.top - this.pixelViewport.top, dBottom = pixelViewport.bottom - this.pixelViewport.bottom
    this.pixelViewport = pixelViewport
    let inView = this.pixelViewport.bottom > this.pixelViewport.top && this.pixelViewport.right > this.pixelViewport.left
    if (inView != this.inView) {
      this.inView = inView
      if (inView) measureContent = true
    }
    if (!this.inView && !this.scrollTarget) return 0

    let contentWidth = domRect.width
    if (this.contentDOMWidth != contentWidth || this.editorHeight != view.scrollDOM.clientHeight) {
      this.contentDOMWidth = domRect.width
      this.editorHeight = view.scrollDOM.clientHeight
      result |= UpdateFlag.Geometry
    }

    if (measureContent) {
      let lineHeights = view.docView.measureVisibleLineHeights(this.viewport)
      if (oracle.mustRefreshForHeights(lineHeights)) refresh = true
      if (refresh || oracle.lineWrapping && Math.abs(contentWidth - this.contentDOMWidth) > oracle.charWidth) {
        let {lineHeight, charWidth, textHeight} = view.docView.measureTextSize()
        refresh = lineHeight > 0 && oracle.refresh(whiteSpace, lineHeight, charWidth, textHeight,
                                                   contentWidth / charWidth, lineHeights)
        if (refresh) {
          view.docView.minWidth = 0
          result |= UpdateFlag.Geometry
        }
      }

      if (dTop > 0 && dBottom > 0) bias = Math.max(dTop, dBottom)
      else if (dTop < 0 && dBottom < 0) bias = Math.min(dTop, dBottom)

      oracle.heightChanged = false
      for (let vp of this.viewports) {
        let heights = vp.from == this.viewport.from ? lineHeights : view.docView.measureVisibleLineHeights(vp)
        this.heightMap = (
          refresh ? HeightMap.empty().applyChanges(this.stateDeco, Text.empty, this.heightOracle,
                                                   [new ChangedRange(0, 0, 0, view.state.doc.length)]) : this.heightMap
        ).updateHeight(oracle, 0, refresh, new MeasuredHeights(vp.from, heights))
      }
      if (oracle.heightChanged) result |= UpdateFlag.Height
    }

    let viewportChange = !this.viewportIsAppropriate(this.viewport, bias) ||
      this.scrollTarget && (this.scrollTarget.range.head < this.viewport.from ||
      this.scrollTarget.range.head > this.viewport.to)
    if (viewportChange) this.viewport = this.getViewport(bias, this.scrollTarget)
    this.updateForViewport()
    if ((result & UpdateFlag.Height) || viewportChange) this.updateViewportLines()

    if (this.lineGaps.length || this.viewport.to - this.viewport.from > (LG.Margin << 1))
      this.updateLineGaps(this.ensureLineGaps(refresh ? [] : this.lineGaps, view))
    result |= this.computeVisibleRanges()

    if (this.mustEnforceCursorAssoc) {
      this.mustEnforceCursorAssoc = false
      // This is done in the read stage, because moving the selection
      // to a line end is going to trigger a layout anyway, so it
      // can't be a pure write. It should be rare that it does any
      // writing.
      view.docView.enforceCursorAssoc()
    }

    return result
  }

  get visibleTop() { return this.scaler.fromDOM(this.pixelViewport.top) }
  get visibleBottom() { return this.scaler.fromDOM(this.pixelViewport.bottom) }

  getViewport(bias: number, scrollTarget: ScrollTarget | null): Viewport {
    // This will divide VP.Margin between the top and the
    // bottom, depending on the bias (the change in viewport position
    // since the last update). It'll hold a number between 0 and 1
    let marginTop = 0.5 - Math.max(-0.5, Math.min(0.5, bias / VP.Margin / 2))
    let map = this.heightMap, oracle = this.heightOracle
    let {visibleTop, visibleBottom} = this
    let viewport = new Viewport(map.lineAt(visibleTop - marginTop * VP.Margin, QueryType.ByHeight, oracle, 0, 0).from,
                                map.lineAt(visibleBottom + (1 - marginTop) * VP.Margin, QueryType.ByHeight, oracle, 0, 0).to)
    // If scrollTarget is given, make sure the viewport includes that position
    if (scrollTarget) {
      let {head} = scrollTarget.range
      if (head < viewport.from || head > viewport.to) {
        let viewHeight = Math.min(this.editorHeight, this.pixelViewport.bottom - this.pixelViewport.top)
        let block = map.lineAt(head, QueryType.ByPos, oracle, 0, 0), topPos
        if (scrollTarget.y == "center")
          topPos = (block.top + block.bottom) / 2 - viewHeight / 2
        else if (scrollTarget.y == "start" || scrollTarget.y == "nearest" && head < viewport.from)
          topPos = block.top
        else
          topPos = block.bottom - viewHeight
        viewport = new Viewport(map.lineAt(topPos - VP.Margin / 2, QueryType.ByHeight, oracle, 0, 0).from,
                                map.lineAt(topPos + viewHeight + VP.Margin / 2, QueryType.ByHeight, oracle, 0, 0).to)
      }
    }
    return viewport
  }

  mapViewport(viewport: Viewport, changes: ChangeDesc) {
    let from = changes.mapPos(viewport.from, -1), to = changes.mapPos(viewport.to, 1)
    return new Viewport(this.heightMap.lineAt(from, QueryType.ByPos, this.heightOracle, 0, 0).from,
                        this.heightMap.lineAt(to, QueryType.ByPos, this.heightOracle, 0, 0).to)
  }

  // Checks if a given viewport covers the visible part of the
  // document and not too much beyond that.
  viewportIsAppropriate({from, to}: Viewport, bias = 0) {
    if (!this.inView) return true
    let {top} = this.heightMap.lineAt(from, QueryType.ByPos, this.heightOracle, 0, 0)
    let {bottom} = this.heightMap.lineAt(to, QueryType.ByPos, this.heightOracle, 0, 0)
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
  ensureLineGaps(current: readonly LineGap[], mayMeasure?: EditorView) {
    let wrapping = this.heightOracle.lineWrapping
    let margin = wrapping ? LG.MarginWrap : LG.Margin, halfMargin = margin >> 1, doubleMargin = margin << 1
    // The non-wrapping logic won't work at all in predominantly right-to-left text.
    if (this.defaultTextDirection != Direction.LTR && !wrapping) return []
    let gaps: LineGap[] = []
    let addGap = (from: number, to: number, line: BlockInfo, structure: LineStructure) => {
      if (to - from < halfMargin) return
      let sel = this.state.selection.main, avoid = [sel.from]
      if (!sel.empty) avoid.push(sel.to)
      for (let pos of avoid) {
        if (pos > from && pos < to) {
          addGap(from, pos - LG.SelectionMargin, line, structure)
          addGap(pos + LG.SelectionMargin, to, line, structure)
          return
        }
      }
      let gap = find(current, gap => gap.from >= line.from && gap.to <= line.to &&
        Math.abs(gap.from - from) < halfMargin && Math.abs(gap.to - to) < halfMargin &&
        !avoid.some(pos => gap.from < pos && gap.to > pos))
      if (!gap) {
        // When scrolling down, snap gap ends to line starts to avoid shifts in wrapping
        if (to < line.to && mayMeasure && wrapping &&
          mayMeasure.visibleRanges.some(r => r.from <= to && r.to >= to)) {
          let lineStart = mayMeasure.moveToLineBoundary(EditorSelection.cursor(to), false, true).head
          if (lineStart > from) to = lineStart
        }
        gap = new LineGap(from, to, this.gapSize(line, from, to, structure))
      }
      gaps.push(gap)
    }

    for (let line of this.viewportLines) {
      if (line.length < doubleMargin) continue
      let structure = lineStructure(line.from, line.to, this.stateDeco)
      if (structure.total < doubleMargin) continue
      let target = this.scrollTarget ? this.scrollTarget.range.head : null
      let viewFrom, viewTo
      if (wrapping) {
        let marginHeight = (margin / this.heightOracle.lineLength) * this.heightOracle.lineHeight
        let top, bot
        if (target != null) {
          let targetFrac = findFraction(structure, target)
          let spaceFrac = ((this.visibleBottom - this.visibleTop) / 2 + marginHeight) / line.height
          top = targetFrac - spaceFrac
          bot = targetFrac + spaceFrac
        } else {
          top = (this.visibleTop - line.top - marginHeight) / line.height
          bot = (this.visibleBottom - line.top + marginHeight) / line.height
        }
        viewFrom = findPosition(structure, top)
        viewTo = findPosition(structure, bot)
      } else {
        let totalWidth = structure.total * this.heightOracle.charWidth
        let marginWidth = margin * this.heightOracle.charWidth
        let left, right
        if (target != null) {
          let targetFrac = findFraction(structure, target)
          let spaceFrac = ((this.pixelViewport.right - this.pixelViewport.left) / 2 + marginWidth) / totalWidth
          left = targetFrac - spaceFrac
          right = targetFrac + spaceFrac
        } else {
          left = (this.pixelViewport.left - marginWidth) / totalWidth
          right = (this.pixelViewport.right + marginWidth) / totalWidth
        }
        viewFrom = findPosition(structure, left)
        viewTo = findPosition(structure, right)
      }

      if (viewFrom > line.from) addGap(line.from, viewFrom, line, structure)
      if (viewTo < line.to) addGap(viewTo, line.to, line, structure)
    }
    return gaps
  }

  gapSize(line: BlockInfo, from: number, to: number, structure: LineStructure) {
    let fraction = findFraction(structure, to) - findFraction(structure, from)
    if (this.heightOracle.lineWrapping) {
      return line.height * fraction
    } else {
      return structure.total * this.heightOracle.charWidth * fraction
    }
  }

  updateLineGaps(gaps: readonly LineGap[]) {
    if (!LineGap.same(gaps, this.lineGaps)) {
      this.lineGaps = gaps
      this.lineGapDeco = Decoration.set(gaps.map(gap => gap.draw(this, this.heightOracle.lineWrapping)))
    }
  }

  computeVisibleRanges() {
    let deco = this.stateDeco
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

  lineBlockAt(pos: number): BlockInfo {
    return (pos >= this.viewport.from && pos <= this.viewport.to && this.viewportLines.find(b => b.from <= pos && b.to >= pos)) ||
      scaleBlock(this.heightMap.lineAt(pos, QueryType.ByPos, this.heightOracle, 0, 0), this.scaler)
  }

  lineBlockAtHeight(height: number): BlockInfo {
    return scaleBlock(this.heightMap.lineAt(this.scaler.fromDOM(height), QueryType.ByHeight, this.heightOracle, 0, 0), this.scaler)
  }

  scrollAnchorAt(scrollTop: number) {
    let block = this.lineBlockAtHeight(scrollTop + 8)
    return block.from >= this.viewport.from || this.viewportLines[0].top - scrollTop > 200 ? block : this.viewportLines[0]
  }

  elementAtHeight(height: number): BlockInfo {
    return scaleBlock(this.heightMap.blockAt(this.scaler.fromDOM(height), this.heightOracle, 0, 0), this.scaler)
  }

  get docHeight() {
    return this.scaler.toDOM(this.heightMap.height)
  }

  get contentHeight() {
    return this.docHeight + this.paddingTop + this.paddingBottom
  }
}

export class Viewport {
  constructor(readonly from: number, readonly to: number) {}
}

type LineStructure = {total: number, ranges: {from: number, to: number}[]}

function lineStructure(from: number, to: number, stateDeco: readonly DecorationSet[]): LineStructure {
  let ranges = [], pos = from, total = 0
  RangeSet.spans(stateDeco, from, to, {
    span() {},
    point(from, to) {
      if (from > pos) { ranges.push({from: pos, to: from}); total += from - pos }
      pos = to
    }
  }, 20) // We're only interested in collapsed ranges of a significant size
  if (pos < to) { ranges.push({from: pos, to}); total += to - pos }
  return {total, ranges}
}

function findPosition({total, ranges}: LineStructure, ratio: number): number {
  if (ratio <= 0) return ranges[0].from
  if (ratio >= 1) return ranges[ranges.length - 1].to
  let dist = Math.floor(total * ratio)
  for (let i = 0;; i++) {
    let {from, to} = ranges[i], size = to - from
    if (dist <= size) return from + dist
    dist -= size
  }
}

function findFraction(structure: LineStructure, pos: number) {
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
  toDOM(n: number): number
  fromDOM(n: number): number
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

  constructor(oracle: HeightOracle, heightMap: HeightMap, viewports: readonly Viewport[]) {
    let vpHeight = 0, base = 0, domBase = 0
    this.viewports = viewports.map(({from, to}) => {
      let top = heightMap.lineAt(from, QueryType.ByPos, oracle, 0, 0).top
      let bottom = heightMap.lineAt(to, QueryType.ByPos, oracle, 0, 0).bottom
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

  toDOM(n: number) {
    for (let i = 0, base = 0, domBase = 0;; i++) {
      let vp = i < this.viewports.length ? this.viewports[i] : null
      if (!vp || n < vp.top) return domBase + (n - base) * this.scale
      if (n <= vp.bottom) return vp.domTop + (n - vp.top)
      base = vp.bottom; domBase = vp.domBottom
    }
  }
  
  fromDOM(n: number) {
    for (let i = 0, base = 0, domBase = 0;; i++) {
      let vp = i < this.viewports.length ? this.viewports[i] : null
      if (!vp || n < vp.domTop) return base + (n - domBase) / this.scale
      if (n <= vp.domBottom) return vp.top + (n - vp.domTop)
      base = vp.bottom; domBase = vp.domBottom
    }
  }
}

function scaleBlock(block: BlockInfo, scaler: YScaler): BlockInfo {
  if (scaler.scale == 1) return block
  let bTop = scaler.toDOM(block.top), bBottom = scaler.toDOM(block.bottom)
  return new BlockInfo(block.from, block.length, bTop, bBottom - bTop,
                       Array.isArray(block._content) ? block._content.map(b => scaleBlock(b, scaler)) : block._content)
}
