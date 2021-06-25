import {EditorView, ViewPlugin, PluginField, ViewUpdate, BlockType, BlockInfo, Direction} from "@codemirror/view"
import {RangeValue, RangeSet, RangeCursor} from "@codemirror/rangeset"
import {combineConfig, MapMode, Facet, Extension, EditorState} from "@codemirror/state"

/// A gutter marker represents a bit of information attached to a line
/// in a specific gutter. Your own custom markers have to extend this
/// class.
export abstract class GutterMarker extends RangeValue {
  /// @internal
  compare(other: GutterMarker) {
    return this == other || this.constructor == other.constructor && this.eq(other)
  }

  /// Compare this marker to another marker of the same type.
  eq(other: GutterMarker): boolean { return false }

  /// Render the DOM node for this marker, if any.
  toDOM?(_view: EditorView): Node

  /// This property can be used to add CSS classes to the gutter
  /// element that contains this marker.
  elementClass!: string
}

GutterMarker.prototype.elementClass = ""
GutterMarker.prototype.toDOM = undefined
GutterMarker.prototype.mapMode = MapMode.TrackBefore
GutterMarker.prototype.point = true

/// Facet used to add a class to all gutter elements for a given line.
/// Markers given to this facet should _only_ define an
/// [`elementclass`](#gutter.GutterMarker.elementClass), not a
/// [`toDOM`](#gutter.GutterMarker.toDOM) (or the marker will appear
/// in all gutters for the line).
export const gutterLineClass = Facet.define<RangeSet<GutterMarker>>()

type Handlers = {[event: string]: (view: EditorView, line: BlockInfo, event: any) => boolean}

interface GutterConfig {
  /// An extra CSS class to be added to the wrapper (`cm-gutter`)
  /// element.
  class?: string
  /// Controls whether empty gutter elements should be rendered.
  /// Defaults to false.
  renderEmptyElements?: boolean
  /// Retrieve a set of markers to use in this gutter from the
  /// current editor state.
  markers?: (view: EditorView) => (RangeSet<GutterMarker> | readonly RangeSet<GutterMarker>[])
  /// Can be used to optionally add a single marker to every line.
  lineMarker?: (view: EditorView, line: BlockInfo, otherMarkers: readonly GutterMarker[]) => GutterMarker | null
  /// Add a hidden spacer element that gives the gutter its base
  /// width.
  initialSpacer?: null | ((view: EditorView) => GutterMarker)
  /// Update the spacer element when the view is updated.
  updateSpacer?: null | ((spacer: GutterMarker, update: ViewUpdate) => GutterMarker)
  /// Supply event handlers for DOM events on this gutter.
  domEventHandlers?: Handlers
}

const defaults = {
  class: "",
  renderEmptyElements: false,
  elementStyle: "",
  markers: () => RangeSet.empty,
  lineMarker: () => null,
  initialSpacer: null,
  updateSpacer: null,
  domEventHandlers: {}
}

const activeGutters = Facet.define<Required<GutterConfig>>()

/// Define an editor gutter. The order in which the gutters appear is
/// determined by their extension priority.
export function gutter(config: GutterConfig): Extension {
  return [gutters(), activeGutters.of({...defaults, ...config})]
}

const baseTheme = EditorView.baseTheme({
  ".cm-gutters": {
    display: "flex",
    height: "100%",
    boxSizing: "border-box",
    left: 0,
    zIndex: 200
  },

  "&light .cm-gutters": {
    backgroundColor: "#f5f5f5",
    color: "#999",
    borderRight: "1px solid #ddd"
  },

  "&dark .cm-gutters": {
    backgroundColor: "#333338",
    color: "#ccc"
  },

  ".cm-gutter": {
    display: "flex !important", // Necessary -- prevents margin collapsing
    flexDirection: "column",
    flexShrink: 0,
    boxSizing: "border-box",
    height: "100%",
    overflow: "hidden"
  },

  ".cm-gutterElement": {
    boxSizing: "border-box"
  },

  ".cm-lineNumbers .cm-gutterElement": {
    padding: "0 3px 0 5px",
    minWidth: "20px",
    textAlign: "right",
    whiteSpace: "nowrap"
  },

  "&light .cm-activeLineGutter": {
    backgroundColor: "#e2f2ff"
  },

  "&dark .cm-activeLineGutter": {
    backgroundColor: "#222227"
  }
})

const unfixGutters = Facet.define<boolean, boolean>({
  combine: values => values.some(x => x)
})

/// The gutter-drawing plugin is automatically enabled when you add a
/// gutter, but you can use this function to explicitly configure it.
///
/// Unless `fixed` is explicitly set to `false`, the gutters are
/// fixed, meaning they don't scroll along with the content
/// horizontally (except on Internet Explorer, which doesn't support
/// CSS [`position:
/// sticky`](https://developer.mozilla.org/en-US/docs/Web/CSS/position#sticky)).
export function gutters(config?: {fixed?: boolean}): Extension {
  let result = [
    gutterView,
    baseTheme
  ]
  if (config && config.fixed === false) result.push(unfixGutters.of(true))
  return result
}

const gutterView = ViewPlugin.fromClass(class {
  gutters: SingleGutterView[]
  dom: HTMLElement
  fixed: boolean

  constructor(readonly view: EditorView) {
    this.dom = document.createElement("div")
    this.dom.className = "cm-gutters"
    this.dom.setAttribute("aria-hidden", "true")
    this.gutters = view.state.facet(activeGutters).map(conf => new SingleGutterView(view, conf))
    for (let gutter of this.gutters) this.dom.appendChild(gutter.dom)
    this.fixed = !view.state.facet(unfixGutters)
    if (this.fixed) {
      // FIXME IE11 fallback, which doesn't support position: sticky,
      // by using position: relative + event handlers that realign the
      // gutter (or just force fixed=false on IE11?)
      this.dom.style.position = "sticky"
    }
    view.scrollDOM.insertBefore(this.dom, view.contentDOM)
    this.syncGutters()
  }

  update(update: ViewUpdate) {
    if (this.updateGutters(update)) this.syncGutters()
  }

  syncGutters() {
    let lineClasses = RangeSet.iter(this.view.state.facet(gutterLineClass), this.view.viewport.from)
    let classSet: GutterMarker[] = []
    let contexts = this.gutters.map(gutter => new UpdateContext(gutter, this.view.viewport))
    this.view.viewportLines(line => {
      let text: BlockInfo | undefined
      if (Array.isArray(line.type)) {
        for (let b of line.type) if (b.type == BlockType.Text) { text = b; break }
      } else {
        text = line.type == BlockType.Text ? line : undefined
      }
      if (!text) return

      if (classSet.length) classSet = []
      advanceCursor(lineClasses, classSet, line.from)
      for (let cx of contexts) cx.line(this.view, text, classSet)
    }, 0)
    for (let cx of contexts) cx.finish()
    this.dom.style.minHeight = this.view.contentHeight + "px"
    if (this.view.state.facet(unfixGutters) != !this.fixed) {
      this.fixed = !this.fixed
      this.dom.style.position = this.fixed ? "sticky" : ""
    }
  }

  updateGutters(update: ViewUpdate) {
    let prev = update.startState.facet(activeGutters), cur = update.state.facet(activeGutters)
    let change = update.docChanged || update.heightChanged || update.viewportChanged ||
      !RangeSet.eq(update.startState.facet(gutterLineClass), update.state.facet(gutterLineClass),
                   update.view.viewport.from, update.view.viewport.to)
    if (prev == cur) {
      for (let gutter of this.gutters) if (gutter.update(update)) change = true
    } else {
      change = true
      let gutters = []
      for (let conf of cur) {
        let known = prev.indexOf(conf)
        if (known < 0) {
          gutters.push(new SingleGutterView(this.view, conf))
        } else {
          this.gutters[known].update(update)
          gutters.push(this.gutters[known])
        }
      }
      for (let g of this.gutters) g.dom.remove()
      for (let g of gutters) this.dom.appendChild(g.dom)
      this.gutters = gutters
    }
    return change
  }

  destroy() {
    this.dom.remove()
  }
}, {
  provide: PluginField.scrollMargins.from(value => {
    if (value.gutters.length == 0 || !value.fixed) return null
    return value.view.textDirection == Direction.LTR ? {left: value.dom.offsetWidth} : {right: value.dom.offsetWidth}
  })
})

function asArray<T>(val: T | readonly T[]) { return (Array.isArray(val) ? val : [val]) as readonly T[] }

function advanceCursor(cursor: RangeCursor<GutterMarker>, collect: GutterMarker[], pos: number) {
  while (cursor.value && cursor.from <= pos) {
    if (cursor.from == pos) collect.push(cursor.value)
    cursor.next()
  }
}

class UpdateContext {
  cursor: RangeCursor<GutterMarker>
  localMarkers: GutterMarker[] = []
  i = 0
  height = 0

  constructor(readonly gutter: SingleGutterView, viewport: {from: number, to: number}) {
    this.cursor = RangeSet.iter(gutter.markers, viewport.from)
  }

  line(view: EditorView, line: BlockInfo, extraMarkers: readonly GutterMarker[]) {
    if (this.localMarkers.length) this.localMarkers = []
    advanceCursor(this.cursor, this.localMarkers, line.from)
    let localMarkers = extraMarkers.length ? this.localMarkers.concat(extraMarkers) : this.localMarkers
    let forLine = this.gutter.config.lineMarker(view, line, localMarkers)
    if (forLine) localMarkers.unshift(forLine)

    let gutter = this.gutter
    if (localMarkers.length == 0 && !gutter.config.renderEmptyElements) return

    let above = line.top - this.height
    if (this.i == gutter.elements.length) {
      let newElt = new GutterElement(view, line.height, above, localMarkers)
      gutter.elements.push(newElt)
      gutter.dom.appendChild(newElt.dom)
    } else {
      let elt = gutter.elements[this.i]
      if (sameMarkers(localMarkers, elt.markers)) localMarkers = elt.markers as GutterMarker[]
      elt.update(view, line.height, above, localMarkers)
    }
    this.height = line.bottom
    this.i++
  }

  finish() {
    let gutter = this.gutter
    while (gutter.elements.length > this.i) gutter.dom.removeChild(gutter.elements.pop()!.dom)
  }
}

class SingleGutterView {
  dom: HTMLElement
  elements: GutterElement[] = []
  markers: readonly RangeSet<GutterMarker>[]
  spacer: GutterElement | null = null

  constructor(public view: EditorView, public config: Required<GutterConfig>) {
    this.dom = document.createElement("div")
    this.dom.className = "cm-gutter" + (this.config.class ? " " + this.config.class : "")
    for (let prop in config.domEventHandlers) {
      this.dom.addEventListener(prop, (event: Event) => {
        let line = view.visualLineAtHeight((event as MouseEvent).clientY, view.contentDOM.getBoundingClientRect().top)
        if (config.domEventHandlers[prop](view, line, event)) event.preventDefault()
      })
    }
    this.markers = asArray(config.markers(view))
    if (config.initialSpacer) {
      this.spacer = new GutterElement(view, 0, 0, [config.initialSpacer(view)])
      this.dom.appendChild(this.spacer.dom)
      this.spacer.dom.style.cssText += "visibility: hidden; pointer-events: none"
    }
  }

  update(update: ViewUpdate) {
    let prevMarkers = this.markers
    this.markers = asArray(this.config.markers(update.view))
    if (this.spacer && this.config.updateSpacer) {
      let updated = this.config.updateSpacer(this.spacer.markers[0], update)
      if (updated != this.spacer.markers[0]) this.spacer.update(update.view, 0, 0, [updated])
    }
    let vp = update.view.viewport
    return !RangeSet.eq(this.markers, prevMarkers, vp.from, vp.to)
  }
}

class GutterElement {
  dom: HTMLElement
  height: number = -1
  above: number = 0
  markers!: readonly GutterMarker[]

  constructor(view: EditorView, height: number, above: number, markers: readonly GutterMarker[]) {
    this.dom = document.createElement("div")
    this.update(view, height, above, markers)
  }

  update(view: EditorView, height: number, above: number, markers: readonly GutterMarker[]) {
    if (this.height != height)
      this.dom.style.height = (this.height = height) + "px"
    if (this.above != above)
      this.dom.style.marginTop = (this.above = above) ? above + "px" : ""
    if (this.markers != markers) {
      this.markers = markers
      for (let ch; ch = this.dom.lastChild;) ch.remove()
      let cls = "cm-gutterElement"
      for (let m of markers) {
        if (m.toDOM) this.dom.appendChild(m.toDOM(view))
        let c = m.elementClass
        if (c) cls += " " + c
      }
      this.dom.className = cls
    }
  }
}

function sameMarkers(a: readonly GutterMarker[], b: readonly GutterMarker[]): boolean {
  if (a.length != b.length) return false
  for (let i = 0; i < a.length; i++) if (!a[i].compare(b[i])) return false
  return true
}

interface LineNumberConfig {
  /// How to display line numbers. Defaults to simply converting them
  /// to string.
  formatNumber?: (lineNo: number, state: EditorState) => string
  /// Supply event handlers for DOM events on this gutter.
  domEventHandlers?: Handlers
}

/// Facet used to provide markers to the line number gutter.
export const lineNumberMarkers = Facet.define<RangeSet<GutterMarker>>()

const lineNumberConfig = Facet.define<LineNumberConfig, Required<LineNumberConfig>>({
  combine(values) {
    return combineConfig<Required<LineNumberConfig>>(values, {formatNumber: String, domEventHandlers: {}}, {
      domEventHandlers(a: Handlers, b: Handlers) {
        let result: Handlers = Object.assign({}, a)
        for (let event in b) {
          let exists = result[event], add = b[event]
          result[event] = exists ? (view, line, event) => exists(view, line, event) || add(view, line, event) : add
        }
        return result
      }
    })
  }
})

class NumberMarker extends GutterMarker {
  constructor(readonly number: string) { super() }

  eq(other: NumberMarker) { return this.number == other.number }

  toDOM(_view: EditorView) { return document.createTextNode(this.number) }
}

function formatNumber(view: EditorView, number: number) {
  return view.state.facet(lineNumberConfig).formatNumber(number, view.state)
}

const lineNumberGutter = gutter({
  class: "cm-lineNumbers",
  markers(view: EditorView) { return view.state.facet(lineNumberMarkers) },
  lineMarker(view, line, others) {
    if (others.some(m => m.toDOM)) return null
    return new NumberMarker(formatNumber(view, view.state.doc.lineAt(line.from).number))
  },
  initialSpacer(view: EditorView) {
    return new NumberMarker(formatNumber(view, maxLineNumber(view.state.doc.lines)))
  },
  updateSpacer(spacer: GutterMarker, update: ViewUpdate) {
    let max = formatNumber(update.view, maxLineNumber(update.view.state.doc.lines))
    return max == (spacer as NumberMarker).number ? spacer : new NumberMarker(max)
  }
})

/// Create a line number gutter extension.
export function lineNumbers(config: LineNumberConfig = {}): Extension {
  return [
    lineNumberConfig.of(config),
    lineNumberGutter
  ]
}

function maxLineNumber(lines: number) {
  let last = 9
  while (last < lines) last = last * 10 + 9
  return last
}

const activeLineGutterMarker = new class extends GutterMarker {
  eq() { return true }
  elementClass = "cm-activeLineGutter"
}

const activeLineGutterHighlighter = gutterLineClass.compute(["selection"], state => {
  let marks = [], last = -1
  for (let range of state.selection.ranges) if (range.empty) {
    let linePos = state.doc.lineAt(range.head).from
    if (linePos > last) {
      last = linePos
      marks.push(activeLineGutterMarker.range(linePos))
    }
  }
  return RangeSet.of(marks)
})

/// Returns an extension that adds a `cm-activeLineGutter` class to
/// all gutter elements on the [active
/// line](#view.highlightActiveLine).
export function highlightActiveLineGutter() {
  return activeLineGutterHighlighter
}
