import {Text as DocText} from "@codemirror/state"
import {ContentView, DOMPos, ViewFlag, mergeChildrenInto, noChildren} from "./contentview"
import {WidgetType, MarkDecoration} from "./decoration"
import {Rect, flattenRect, textRange, clientRectsFor, clearAttributes} from "./dom"
import {DocView} from "./docview"
import browser from "./browser"
import {EditorView} from "./editorview"

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

  sync(view: EditorView, track?: {node: Node, written: boolean}) {
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
    if ((this.flags & ViewFlag.Composition) ||
        source && (!(source instanceof TextView) ||
                   this.length - (to - from) + source.length > MaxJoinLen ||
                   (source.flags & ViewFlag.Composition)))
      return false
    this.text = this.text.slice(0, from) + (source ? source.text : "") + this.text.slice(to)
    this.markDirty()
    return true
  }

  split(from: number) {
    let result = new TextView(this.text.slice(from))
    this.text = this.text.slice(0, from)
    this.markDirty()
    result.flags |= this.flags & ViewFlag.Composition
    return result
  }

  localPosFromDOM(node: Node, offset: number): number {
    return node == this.dom ? offset : offset ? this.text.length : 0
  }

  domAtPos(pos: number) { return new DOMPos(this.dom!, pos) }

  domBoundsAround(_from: number, _to: number, offset: number) {
    return {from: offset, to: offset + this.length, startDOM: this.dom, endDOM: this.dom!.nextSibling}
  }

  coordsAt(pos: number, side: number): Rect | null {
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

  canReuseDOM(other: ContentView) {
    return super.canReuseDOM(other) && !((this.flags | other.flags) & ViewFlag.Composition)
  }

  reuseDOM(node: Node) {
    if (node.nodeName == this.mark.tagName.toUpperCase()) {
      this.setDOM(node)
      this.flags |= ViewFlag.AttrsDirty | ViewFlag.NodeDirty
    }
  }

  sync(view: EditorView, track?: {node: Node, written: boolean}) {
    if (!this.dom) this.setDOM(this.setAttrs(document.createElement(this.mark.tagName)))
    else if (this.flags & ViewFlag.AttrsDirty) this.setAttrs(this.dom)
    super.sync(view, track)
  }

  merge(from: number, to: number, source: ContentView | null, _hasStart: boolean, openStart: number, openEnd: number): boolean {
    if (source && (!(source instanceof MarkView && source.mark.eq(this.mark)) ||
                   (from && openStart <= 0) || (to < this.length && openEnd <= 0)))
      return false
    mergeChildrenInto(this, from, to, source ? source.children.slice() : [], openStart - 1, openEnd - 1)
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
    return inlineDOMAtPos(this, pos)
  }

  coordsAt(pos: number, side: number): Rect | null {
    return coordsInChildren(this, pos, side)
  }
}

function textCoords(text: Text, pos: number, side: number): Rect | null {
  let length = text.nodeValue!.length
  if (pos > length) pos = length
  let from = pos, to = pos, flatten = 0
  if (pos == 0 && side < 0 || pos == length && side >= 0) {
    if (!(browser.chrome || browser.gecko)) { // These browsers reliably return valid rectangles for empty ranges
      if (pos) { from--; flatten = 1 } // FIXME this is wrong in RTL text
      else if (to < length) { to++; flatten = -1 }
    }
  } else {
    if (side < 0) from--; else if (to < length) to++
  }
  let rects = textRange(text, from, to).getClientRects()
  if (!rects.length) return null
  let rect = rects[(flatten ? flatten < 0 : side >= 0) ? 0 : rects.length - 1]
  if (browser.safari && !flatten && rect.width == 0) rect = Array.prototype.find.call(rects, r => r.width) || rect
  return flatten ? flattenRect(rect!, flatten < 0) : rect || null
}

// Also used for collapsed ranges that don't have a placeholder widget!
export class WidgetView extends ContentView {
  children!: ContentView[]
  dom!: HTMLElement | null
  prevWidget: WidgetType | null = null

  static create(widget: WidgetType, length: number, side: number) {
    return new WidgetView(widget, length, side)
  }

  constructor(public widget: WidgetType, public length: number, readonly side: number) {
    super()
  }

  split(from: number) {
    let result = WidgetView.create(this.widget, this.length - from, this.side)
    this.length -= from
    return result
  }

  sync(view: EditorView) {
    if (!this.dom || !this.widget.updateDOM(this.dom, view)) {
      if (this.dom && this.prevWidget) this.prevWidget.destroy(this.dom)
      this.prevWidget = null
      this.setDOM(this.widget.toDOM(view))
      if (!this.widget.editable) this.dom!.contentEditable = "false"
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
    if (other instanceof WidgetView && other.side == this.side &&
        this.widget.constructor == other.widget.constructor) {
      if (!this.widget.compare(other.widget)) this.markDirty(true)
      if (this.dom && !this.prevWidget) this.prevWidget = this.widget
      this.widget = other.widget
      this.length = other.length
      return true
    }
    return false
  }

  ignoreMutation(): boolean { return true }
  ignoreEvent(event: Event): boolean { return this.widget.ignoreEvent(event) }

  get overrideDOMText(): DocText | null {
    if (this.length == 0) return DocText.empty
    let top: ContentView = this
    while (top.parent) top = top.parent
    let {view} = top as DocView, text: DocText | undefined = view && view.state.doc, start = this.posAtStart
    return text ? text.slice(start, start + this.length) : DocText.empty
  }

  domAtPos(pos: number) {
    return (this.length ? pos == 0 : this.side > 0)
      ? DOMPos.before(this.dom!)
      : DOMPos.after(this.dom!, pos == this.length)
  }

  domBoundsAround() { return null }

  coordsAt(pos: number, side: number): Rect | null {
    let custom = this.widget.coordsAt(this.dom!, pos, side)
    if (custom) return custom
    let rects = this.dom!.getClientRects(), rect: Rect | null = null
    if (!rects.length) return null
    let fromBack = this.side ? this.side < 0 : pos > 0
    for (let i = fromBack ? rects.length - 1 : 0;; i += (fromBack ? -1 : 1)) {
      rect = rects[i]
      if (pos > 0 ? i == 0 : i == rects.length - 1 || rect.top < rect.bottom) break
    }
    return flattenRect(rect, !fromBack)
  }

  get isEditable() { return false }

  get isWidget() { return true }

  get isHidden() { return this.widget.isHidden }

  destroy() {
    super.destroy()
    if (this.dom) this.widget.destroy(this.dom)
  }
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
      dom.setAttribute("aria-hidden", "true")
      this.setDOM(dom)
    }
  }

  getSide() { return this.side }

  domAtPos(pos: number) { return this.side > 0 ? DOMPos.before(this.dom!) : DOMPos.after(this.dom!) }

  localPosFromDOM() { return 0 }

  domBoundsAround() { return null }

  coordsAt(pos: number): Rect | null {
    return this.dom!.getBoundingClientRect()
  }

  get overrideDOMText() {
    return DocText.empty
  }

  get isHidden() { return true }
}

TextView.prototype.children = WidgetView.prototype.children = WidgetBufferView.prototype.children = noChildren

export function inlineDOMAtPos(parent: ContentView, pos: number) {
  let dom = parent.dom!, {children} = parent, i = 0
  for (let off = 0; i < children.length; i++) {
    let child = children[i], end = off + child.length
    if (end == off && child.getSide() <= 0) continue
    if (pos > off && pos < end && child.dom!.parentNode == dom) return child.domAtPos(pos - off)
    if (pos <= off) break
    off = end
  }
  for (let j = i; j > 0; j--) {
    let prev = children[j - 1]
    if (prev.dom!.parentNode == dom) return prev.domAtPos(prev.length)
  }
  for (let j = i; j < children.length; j++) {
    let next = children[j]
    if (next.dom!.parentNode == dom) return next.domAtPos(0)
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
  let before: ContentView | null = null, beforePos = -1, after: ContentView | null = null, afterPos = -1
  function scan(view: ContentView, pos: number) {
    for (let i = 0, off = 0; i < view.children.length && off <= pos; i++) {
      let child = view.children[i], end = off + child.length
      if (end >= pos) {
        if (child.children.length) {
          scan(child, pos - off)
        } else if ((!after || after.isHidden && side > 0) &&
                   (end > pos || off == end && child.getSide() > 0)) {
          after = child
          afterPos = pos - off
        } else if (off < pos || (off == end && child.getSide() < 0) && !child.isHidden) {
          before = child
          beforePos = pos - off
        }
      }
      off = end
    }
  }
  scan(view, pos)
  let target = (side < 0 ? before : after) || before || after
  if (target) return (target as ContentView).coordsAt(Math.max(0, target == before ? beforePos : afterPos), side)
  return fallbackRect(view)
}

function fallbackRect(view: ContentView) {
  let last = view.dom!.lastChild
  if (!last) return (view.dom as HTMLElement).getBoundingClientRect()
  let rects = clientRectsFor(last)
  return rects[rects.length - 1] || null
}
