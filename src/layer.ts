import {Extension, Facet, EditorState} from "@codemirror/state"
import {ViewPlugin, ViewUpdate} from "./extension"
import {EditorView} from "./editorview"

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
  /// Create a marker with the given class and dimensions.
  constructor(private className: string,
              private left: number, private top: number,
              private width: number, private height: number) {}

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
    if (this.width >= 0) elt.style.width = this.width + "px"
    elt.style.height = this.height + "px"
  }

  eq(p: RectangleMarker) {
    return this.left == p.left && this.top == p.top && this.width == p.width && this.height == p.height &&
      this.className == p.className
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
