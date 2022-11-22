import {Extension, Facet, EditorState} from "@codemirror/state"
import {ViewPlugin, ViewUpdate} from "./extension"
import {EditorView} from "./editorview"

export interface LayerMarker {
  eq(other: LayerMarker): boolean
  draw(): HTMLElement
  update?(dom: HTMLElement, oldMarker: LayerMarker): boolean
}

export class PlainLayerMarker implements LayerMarker {
  constructor(readonly className: string,
              readonly left: number, readonly top: number,
              readonly width: number, readonly height: number) {}

  draw() {
    let elt = document.createElement("div")
    elt.className = this.className
    this.adjust(elt)
    return elt
  }

  update(elt: HTMLElement, prev: PlainLayerMarker) {
    if (prev.className != this.className) return false
    this.adjust(elt)
    return true
  }

  adjust(elt: HTMLElement) {
    elt.style.left = this.left + "px"
    elt.style.top = this.top + "px"
    if (this.width >= 0) elt.style.width = this.width + "px"
    elt.style.height = this.height + "px"
  }

  eq(p: PlainLayerMarker) {
    return this.left == p.left && this.top == p.top && this.width == p.width && this.height == p.height &&
      this.className == p.className
  }
}

export interface LayerConfig {
  above: boolean,
  markers(view: EditorView): readonly LayerMarker[]
  class?: string
  mount?(layer: HTMLElement, view: EditorView): void
  update(update: ViewUpdate, layer: HTMLElement): boolean
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
    if (markers.length != this.drawn.length || markers.some((p, i) => !p.eq(this.drawn[i]))) {
      let old = this.dom.firstChild, oldI = 0
      for (let marker of markers) {
        if (marker.update && old && marker.update(old as HTMLElement, this.drawn[oldI])) {
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

export function layer(config: LayerConfig): Extension {
  return [
    ViewPlugin.define(v => new LayerView(v, config)),
    layerOrder.of(config)
  ]
}
