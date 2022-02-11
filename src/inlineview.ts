import {Text as DocText} from "@codemirror/text"
import {ContentView, DOMPos, Dirty, mergeChildrenInto, noChildren} from "./contentview"
import {WidgetType, MarkDecoration} from "./decoration"
import {Rect, Rect0, flattenRect, textRange, clientRectsFor, clearAttributes} from "./dom"
import {CompositionWidget} from "./docview"
import browser from "./browser"

const MaxJoinLen = 256

export class TextView extends ContentView {
  children!: ContentView[]
  dom!: Text | null

  constructor(public text: string) {
    super()
  }

  get length() { return this.text.length }

  createDOM(textDOM?: Node) {
    this.setDOM(textDOM || document.createTextNode(this.text))
  }

  sync(track?: {node: Node, written: boolean}) {
    if (!this.dom) this.createDOM()
    if (this.dom!.nodeValue != this.text) {
      if (track && track.node == this.dom) track.written = true
      this.dom!.nodeValue = this.text
    }
  }

  reuseDOM(dom: Node) {
    if (dom.nodeType == 3) this.createDOM(dom)
  }

  merge(from: number, to: number, source: ContentView | null): boolean {
    if (source && (!(source instanceof TextView) || this.length - (to - from) + source.length > MaxJoinLen))
      return false
    this.text = this.text.slice(0, from) + (source ? source.text : "") + this.text.slice(to)
    this.markDirty()
    return true
  }

  split(from: number) {
    let result = new TextView(this.text.slice(from))
    this.text = this.text.slice(0, from)
    this.markDirty()
    return result
  }

  localPosFromDOM(node: Node, offset: number): number {
    return node == this.dom ? offset : offset ? this.text.length : 0
  }

  domAtPos(pos: number) { return new DOMPos(this.dom!, pos) }

  domBoundsAround(_from: number, _to: number, offset: number) {
    return {from: offset, to: offset + this.length, startDOM: this.dom, endDOM: this.dom!.nextSibling}
  }

  coordsAt(pos: number, side: number): Rect {
    return textCoords(this.dom!, pos, side)
  }
}

export class MarkView extends ContentView {
  dom!: HTMLElement | null

  constructor(readonly mark: MarkDecoration,
              public children: ContentView[] = [],
              public length = 0) {
    super()
    for (let ch of children) ch.setParent(this)
  }

  setAttrs(dom: HTMLElement) {
    clearAttributes(dom)
    if (this.mark.class) dom.className = this.mark.class
    if (this.mark.attrs) for (let name in this.mark.attrs) dom.setAttribute(name, this.mark.attrs[name])
    return dom
  }

  reuseDOM(node: Node) {
    if (node.nodeName == this.mark.tagName.toUpperCase()) {
      this.setDOM(node)
      this.dirty |= Dirty.Attrs | Dirty.Node
    }
  }

  sync(track?: {node: Node, written: boolean}) {
    if (!this.dom) this.setDOM(this.setAttrs(document.createElement(this.mark.tagName)))
    else if (this.dirty & Dirty.Attrs) this.setAttrs(this.dom)
    super.sync(track)
  }

  merge(from: number, to: number, source: ContentView | null, _hasStart: boolean, openStart: number, openEnd: number): boolean {
    if (source && (!(source instanceof MarkView && source.mark.eq(this.mark)) ||
                   (from && openStart <= 0) || (to < this.length && openEnd <= 0)))
      return false
    mergeChildrenInto(this, from, to, source ? source.children : [], openStart - 1, openEnd - 1)
    this.markDirty()
    return true
  }

  split(from: number) {
    let result = [], off = 0, detachFrom = -1, i = 0
    for (let elt of this.children) {
      let end = off + elt.length
      if (end > from) result.push(off < from ? elt.split(from - off) : elt)
      if (detachFrom < 0 && off >= from) detachFrom = i
      off = end
      i++
    }
    let length = this.length - from
    this.length = from
    if (detachFrom > -1) {
      this.children.length = detachFrom
      this.markDirty()
    }
    return new MarkView(this.mark, result, length)
  }

  domAtPos(pos: number): DOMPos {
    return inlineDOMAtPos(this.dom!, this.children, pos)
  }

  coordsAt(pos: number, side: number): Rect | null {
    return coordsInChildren(this, pos, side)
  }
}

function textCoords(text: Text, pos: number, side: number): Rect {
  let length = text.nodeValue!.length
  if (pos > length) pos = length
  let from = pos, to = pos, flatten = 0
  if (pos == 0 && side < 0 || pos == length && side >= 0) {
    if (!(browser.chrome || browser.gecko)) { // These browsers reliably return valid rectangles for empty ranges
      if (pos) { from--; flatten = 1 } // FIXME this is wrong in RTL text
      else { to++; flatten = -1 }
    }
  } else {
    if (side < 0) from--; else to++
  }
  let rects = textRange(text, from, to).getClientRects()
  if (!rects.length) return Rect0
  let rect = rects[(flatten ? flatten < 0 : side >= 0) ? 0 : rects.length - 1]
  if (browser.safari && !flatten && rect.width == 0) rect = Array.prototype.find.call(rects, r => r.width) || rect
  return flatten ? flattenRect(rect!, flatten < 0) : rect || null
}

// Also used for collapsed ranges that don't have a placeholder widget!
export class WidgetView extends ContentView {
  children!: ContentView[]
  dom!: HTMLElement | null

  static create(widget: WidgetType, length: number, side: number) {
    return new (widget.customView || WidgetView)(widget, length, side)
  }

  constructor(public widget: WidgetType, public length: number, readonly side: number) {
    super()
  }

  split(from: number) {
    let result = WidgetView.create(this.widget, this.length - from, this.side)
    this.length -= from
    return result
  }

  sync() {
    if (!this.dom || !this.widget.updateDOM(this.dom)) {
      this.setDOM(this.widget.toDOM(this.editorView))
      this.dom!.contentEditable = "false"
    }
  }

  getSide() { return this.side }

  merge(from: number, to: number, source: ContentView | null, hasStart: boolean, openStart: number, openEnd: number) {
    if (source && (!(source instanceof WidgetView) || !this.widget.compare(source.widget) ||
                   from > 0 && openStart <= 0 || to < this.length && openEnd <= 0))
      return false
    this.length = from + (source ? source.length : 0) + (this.length - to)
    return true
  }

  become(other: ContentView): boolean {
    if (other.length == this.length && other instanceof WidgetView && other.side == this.side) {
      if (this.widget.constructor == other.widget.constructor) {
        if (!this.widget.eq(other.widget)) this.markDirty(true)
        this.widget = other.widget
        return true
      }
    }
    return false
  }

  ignoreMutation(): boolean { return true }
  ignoreEvent(event: Event): boolean { return this.widget.ignoreEvent(event) }

  get overrideDOMText(): DocText | null {
    if (this.length == 0) return DocText.empty
    let top: ContentView = this
    while (top.parent) top = top.parent
    let view = (top as any).editorView, text: DocText | undefined = view && view.state.doc, start = this.posAtStart
    return text ? text.slice(start, start + this.length) : DocText.empty
  }

  domAtPos(pos: number) {
    return pos == 0 ? DOMPos.before(this.dom!) : DOMPos.after(this.dom!, pos == this.length)
  }

  domBoundsAround() { return null }

  coordsAt(pos: number, side: number): Rect | null {
    let rects = this.dom!.getClientRects(), rect: Rect | null = null
    if (!rects.length) return Rect0
    for (let i = pos > 0 ? rects.length - 1 : 0;; i += (pos > 0 ? -1 : 1)) {
      rect = rects[i]
      if (pos > 0 ? i == 0 : i == rects.length - 1 || rect.top < rect.bottom) break
    }
    return (pos == 0 && side > 0 || pos == this.length && side <= 0) ? rect : flattenRect(rect, pos == 0)
  }

  get isEditable() { return false }

  destroy() {
    super.destroy()
    if (this.dom) this.widget.destroy(this.dom)
  }
}

export class CompositionView extends WidgetView {
  widget!: CompositionWidget

  domAtPos(pos: number) { return new DOMPos(this.widget.text, pos) }

  sync() { this.setDOM(this.widget.toDOM()) }

  localPosFromDOM(node: Node, offset: number): number {
    return !offset ? 0 : node.nodeType == 3 ? Math.min(offset, this.length) : this.length
  }

  ignoreMutation(): boolean { return false }

  get overrideDOMText() { return null }

  coordsAt(pos: number, side: number) { return textCoords(this.widget.text, pos, side) }

  get isEditable() { return true }
}

// These are drawn around uneditable widgets to avoid a number of
// browser bugs that show up when the cursor is directly next to
// uneditable inline content.
export class WidgetBufferView extends ContentView {
  children!: ContentView[]
  dom!: HTMLElement | null

  constructor(readonly side: number) { super() }

  get length() { return 0 }

  merge() { return false }

  become(other: ContentView): boolean {
    return other instanceof WidgetBufferView && other.side == this.side
  }

  split() { return new WidgetBufferView(this.side) }

  sync() {
    if (!this.dom) {
      let dom = document.createElement("img")
      dom.className = "cm-widgetBuffer"
      this.setDOM(dom)
    }
  }

  getSide() { return this.side }

  domAtPos(pos: number) { return DOMPos.before(this.dom!) }

  localPosFromDOM() { return 0 }

  domBoundsAround() { return null }

  coordsAt(pos: number): Rect | null {
    return this.dom!.getBoundingClientRect()
  }

  get overrideDOMText() {
    return DocText.empty
  }
}

TextView.prototype.children = WidgetView.prototype.children = WidgetBufferView.prototype.children = noChildren

export function inlineDOMAtPos(dom: HTMLElement, children: readonly ContentView[], pos: number) {
  let i = 0
  for (let off = 0; i < children.length; i++) {
    let child = children[i], end = off + child.length
    if (end == off && child.getSide() <= 0) continue
    if (pos > off && pos < end && child.dom!.parentNode == dom) return child.domAtPos(pos - off)
    if (pos <= off) break
    off = end
  }
  for (; i > 0; i--) {
    let before = children[i - 1].dom!
    if (before.parentNode == dom) return DOMPos.after(before)
  }
  return new DOMPos(dom, 0)
}

// Assumes `view`, if a mark view, has precisely 1 child.
export function joinInlineInto(parent: ContentView, view: ContentView, open: number) {
  let last, {children} = parent
  if (open > 0 && view instanceof MarkView && children.length &&
      (last = children[children.length - 1]) instanceof MarkView && last.mark.eq(view.mark)) {
    joinInlineInto(last, view.children[0], open - 1)
  } else {
    children.push(view)
    view.setParent(parent)
  }
  parent.length += view.length
}

export function coordsInChildren(view: ContentView, pos: number, side: number): Rect | null {
  for (let off = 0, i = 0; i < view.children.length; i++) {
    let child = view.children[i], end = off + child.length, next
    if ((side <= 0 || end == view.length || child.getSide() > 0 ? end >= pos : end > pos) &&
        (pos < end || i + 1 == view.children.length || (next = view.children[i + 1]).length || next.getSide() > 0)) {
      let flatten = 0
      if (end == off) {
        if (child.getSide() <= 0) continue
        flatten = side = -child.getSide()
      }
      let rect = child.coordsAt(pos - off, side)
      return flatten && rect ? flattenRect(rect, side < 0) : rect
    }
    off = end
  }
  let last = view.dom!.lastChild
  if (!last) return (view.dom as HTMLElement).getBoundingClientRect()
  let rects = clientRectsFor(last)
  return rects[rects.length - 1] || null
}
