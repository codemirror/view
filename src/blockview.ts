import {ContentView, DOMPos, Dirty, noChildren, mergeChildrenInto} from "./contentview"
import {DocView} from "./docview"
import {TextView, MarkView, inlineDOMAtPos, joinInlineInto, coordsInChildren} from "./inlineview"
import {clientRectsFor, Rect, clearAttributes} from "./dom"
import {LineDecoration, WidgetType, BlockType} from "./decoration"
import {Attrs, combineAttrs, attrsEq, updateAttrs} from "./attributes"
import browser from "./browser"
import {Text} from "@codemirror/state"

export interface BlockView extends ContentView {
  type: BlockType
  dom: HTMLElement | null
}

export class LineView extends ContentView implements BlockView {
  children: ContentView[] = []
  length: number = 0
  dom!: HTMLElement | null
  prevAttrs: Attrs | null | undefined = undefined
  attrs: Attrs | null = null
  breakAfter = 0

  // Consumes source
  merge(from: number, to: number, source: BlockView | null, hasStart: boolean, openStart: number, openEnd: number): boolean {
    if (source) {
      if (!(source instanceof LineView)) return false
      if (!this.dom) source.transferDOM(this) // Reuse source.dom when appropriate
    }
    if (hasStart) this.setDeco(source ? source.attrs : null)
    mergeChildrenInto(this, from, to, source ? source.children : [], openStart, openEnd)
    return true
  }

  split(at: number) {
    let end = new LineView
    end.breakAfter = this.breakAfter
    if (this.length == 0) return end
    let {i, off} = this.childPos(at)
    if (off) {
      end.append(this.children[i].split(off), 0)
      this.children[i].merge(off, this.children[i].length, null, false, 0, 0)
      i++
    }
    for (let j = i; j < this.children.length; j++) end.append(this.children[j], 0)
    while (i > 0 && this.children[i - 1].length == 0) this.children[--i].destroy()
    this.children.length = i
    this.markDirty()
    this.length = at
    return end
  }

  transferDOM(other: LineView) {
    if (!this.dom) return
    other.setDOM(this.dom)
    other.prevAttrs = this.prevAttrs === undefined ? this.attrs : this.prevAttrs
    this.prevAttrs = undefined
    this.dom = null
  }

  setDeco(attrs: Attrs | null) {
    if (!attrsEq(this.attrs, attrs)) {
      if (this.dom) {
        this.prevAttrs = this.attrs
        this.markDirty()
      }
      this.attrs = attrs
    }
  }

  append(child: ContentView, openStart: number) {
    joinInlineInto(this, child, openStart)
  }

  // Only called when building a line view in ContentBuilder
  addLineDeco(deco: LineDecoration) {
    let attrs = deco.spec.attributes, cls = deco.spec.class
    if (attrs) this.attrs = combineAttrs(attrs, this.attrs || {})
    if (cls) this.attrs = combineAttrs({class: cls}, this.attrs || {});
  }

  domAtPos(pos: number): DOMPos {
    return inlineDOMAtPos(this.dom!, this.children, pos)
  }

  reuseDOM(node: Node) {
    if (node.nodeName == "DIV") {
      this.setDOM(node)
      this.dirty |= Dirty.Attrs | Dirty.Node
    }
  }

  sync(track?: {node: Node, written: boolean}) {
    if (!this.dom) {
      this.setDOM(document.createElement("div"))
      this.dom!.className = "cm-line"
      this.prevAttrs = this.attrs ? null : undefined
    } else if (this.dirty & Dirty.Attrs) {
      clearAttributes(this.dom)
      this.dom!.className = "cm-line"
      this.prevAttrs = this.attrs ? null : undefined
    }
    if (this.prevAttrs !== undefined) {
      updateAttrs(this.dom!, this.prevAttrs, this.attrs)
      this.dom!.classList.add("cm-line")
      this.prevAttrs = undefined
    }
    super.sync(track)
    let last = this.dom!.lastChild
    while (last && ContentView.get(last) instanceof MarkView)
      last = last.lastChild
    if (!last ||
        last.nodeName != "BR" && ContentView.get(last)?.isEditable == false &&
        (!browser.ios || !this.children.some(ch => ch instanceof TextView))) {
      let hack = document.createElement("BR")
      ;(hack as any).cmIgnore = true
      this.dom!.appendChild(hack)
    }
  }

  measureTextSize(): {lineHeight: number, charWidth: number} | null {
    if (this.children.length == 0 || this.length > 20) return null
    let totalWidth = 0
    for (let child of this.children) {
      if (!(child instanceof TextView)) return null
      let rects = clientRectsFor(child.dom!)
      if (rects.length != 1) return null
      totalWidth += rects[0].width
    }
    return {lineHeight: this.dom!.getBoundingClientRect().height,
            charWidth: totalWidth / this.length}
  }

  coordsAt(pos: number, side: number): Rect | null {
    return coordsInChildren(this, pos, side)
  }

  become(_other: ContentView) { return false }

  get type() { return BlockType.Text }

  static find(docView: DocView, pos: number): LineView | null {
    for (let i = 0, off = 0; i < docView.children.length; i++) {
      let block = docView.children[i], end = off + block.length
      if (end >= pos) {
        if (block instanceof LineView) return block
        if (end > pos) break
      }
      off = end + block.breakAfter
    }
    return null
  }
}

export class BlockWidgetView extends ContentView implements BlockView {
  dom!: HTMLElement | null
  parent!: DocView | null
  breakAfter = 0

  constructor(public widget: WidgetType, public length: number, public type: BlockType) {
    super()
  }

  merge(from: number, to: number, source: ContentView | null, _takeDeco: boolean, openStart: number, openEnd: number): boolean {
    if (source && (!(source instanceof BlockWidgetView) || !this.widget.compare(source.widget) ||
                   from > 0 && openStart <= 0 || to < this.length && openEnd <= 0))
      return false
    this.length = from + (source ? source.length : 0) + (this.length - to)
    return true
  }

  domAtPos(pos: number) {
    return pos == 0 ? DOMPos.before(this.dom!) : DOMPos.after(this.dom!, pos == this.length)
  }

  split(at: number) {
    let len = this.length - at
    this.length = at
    let end = new BlockWidgetView(this.widget, len, this.type)
    end.breakAfter = this.breakAfter
    return end
  }

  get children() { return noChildren }

  sync() {
    if (!this.dom || !this.widget.updateDOM(this.dom)) {
      this.setDOM(this.widget.toDOM(this.editorView))
      this.dom!.contentEditable = "false"
    }
  }

  get overrideDOMText() {
    return this.parent ? this.parent!.view.state.doc.slice(this.posAtStart, this.posAtEnd) : Text.empty
  }

  domBoundsAround() { return null }

  become(other: ContentView) {
    if (other instanceof BlockWidgetView && other.type == this.type &&
        other.widget.constructor == this.widget.constructor) {
      if (!other.widget.eq(this.widget)) this.markDirty(true)
      this.widget = other.widget
      this.length = other.length
      this.breakAfter = other.breakAfter
      return true
    }
    return false
  }

  ignoreMutation(): boolean { return true }
  ignoreEvent(event: Event): boolean { return this.widget.ignoreEvent(event) }

  destroy() {
    super.destroy()
    if (this.dom) this.widget.destroy(this.dom)
  }
}
