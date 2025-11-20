import {WidgetType, BlockWrapper, MarkDecoration, LineDecoration} from "./decoration"
import {Attrs, setAttrs, combineAttrs} from "./attributes"
import {EditorView} from "./editorview"

export const enum TileFlag {
  BreakAfter = 1,
  Synced = 2,
  AttrsDirty = 4
}

export const enum Reused { Full = 1, DOM = 2 }

const noChildren: readonly Tile[] = []

export abstract class Tile {
  parent: CompositeTile | null = null
  flags = 0 as TileFlag

  constructor(
    readonly dom: HTMLElement | Text,
    public length: number
  ) {}

  get breakAfter(): 0 | 1 { return (this.flags & TileFlag.BreakAfter) as 0 | 1 }
  set breakAfter(value: 0 | 1) { this.flags |= value }

  get children() { return noChildren }

  get isEditable() { return true }
  isComposite(): this is CompositeTile { return false }

  sync() {
    this.flags |= TileFlag.Synced
  }

  synced() { // FIXME is this a good idea?
    this.flags |= TileFlag.Synced
    return this
  }

  toString() {
    return this.constructor.name + (this.children.length ? `(${this.children})` : "") + (this.breakAfter ? "#" : "")
  }

  destroy() {}

  destroyDropped(reused: Map<Tile, Reused>) {
    if (reused.get(this) != Reused.Full) {
      this.destroy()
      for (let ch of this.children) ch.destroyDropped(reused)
    }
  }
}

export abstract class CompositeTile extends Tile {
  declare dom: HTMLElement
  _children: Tile[] = []

  constructor(dom: HTMLElement) {
    super(dom, 0)
  }

  isComposite(): this is CompositeTile { return true }

  get children() { return this._children }

  get lastChild() { return this.children.length ? this.children[this.children.length - 1] : null }

  append(child: Tile) {
    if (this.flags & TileFlag.Synced) throw new Error("Adding to synced tile")
    this.children.push(child)
    child.parent = this
  }

  sync() {
    if (this.flags & TileFlag.Synced) return
    super.sync()
    let parent = this.dom, prev: Node | null = null, next
    let length = 0
    if (this instanceof DocTile) for (let i = 0; i < this.children.length; i++) for (let j = i + 1; j < this.children.length; j++) {
      if (this.children[i].dom == this.children[j].dom) console.log("DOUBLE DOM ", i, j, "" + this.children[i], this.children[i].dom)
    }
    for (let child of this.children) {
      child.sync()
      length += child.length + child.breakAfter
      next = prev ? prev.nextSibling : parent.firstChild
      if (child.dom!.parentNode == parent) {
        while (next && next != child.dom) next = rm(next)
      } else {
        parent.insertBefore(child.dom!, next)
      }
      prev = child.dom!
    }
    next = prev ? prev.nextSibling : parent.firstChild
    while (next) next = rm(next)
    this.length = length
  }

  abstract clone(dom?: HTMLElement): CompositeTile
}

// Remove a DOM node and return its next sibling.
function rm(dom: Node): Node | null {
  let next = dom.nextSibling
  dom.parentNode!.removeChild(dom)
  return next
}

export class DocTile extends CompositeTile {
  clone(dom?: HTMLElement) { return new DocTile(dom!) }
}

export class BlockWrapperTile extends CompositeTile {
  declare dom: HTMLElement
  constructor(dom: HTMLElement, readonly wrapper: BlockWrapper) {
    super(dom)
  }

  clone(dom?: HTMLElement) { return BlockWrapperTile.of(this.wrapper, dom) }

  static of(wrapper: BlockWrapper, dom?: HTMLElement) {
    if (!dom) {
      dom = document.createElement(wrapper.tagName)
      setAttrs(dom, wrapper.attributes)
    }
    return new BlockWrapperTile(dom, wrapper)
  }
}

export class LineTile extends CompositeTile {
  constructor(dom: HTMLElement, public attrs: Attrs) {
    super(dom)
  }

  // Only called when building a line view in ContentBuilder
  addLineDeco(deco: LineDecoration) {
    let attrs = deco.spec.attributes, cls = deco.spec.class
    if (attrs || cls) {
      if (this.attrs == LineTile.baseAttrs) this.attrs = {class: "cm-line"}
      if (attrs) combineAttrs(attrs, this.attrs)
      if (cls) this.attrs.class += " " + cls
      this.flags |= TileFlag.AttrsDirty
    }
  }

  sync() {
    super.sync()
    if (this.flags & TileFlag.AttrsDirty) {
      this.flags &= ~TileFlag.AttrsDirty
      // FIXME proper update, possibly compare to DOM
      setAttrs(this.dom, this.attrs)
    }
  }

  clone(dom?: HTMLElement) { return LineTile.start(this.attrs, dom) }

  static start(attrs: Attrs, dom?: HTMLElement, keepAttrs?: boolean) {
    let line = new LineTile(dom || document.createElement("div"), attrs)
    if (!dom || !keepAttrs) line.flags |= TileFlag.AttrsDirty
    return line
  }

  static baseAttrs = {class: "cm-line"}
}

export class MarkTile extends CompositeTile {
  constructor(dom: HTMLElement, readonly mark: MarkDecoration) {
    super(dom)
  }

  clone(dom?: HTMLElement) { return MarkTile.of(this.mark, dom) }

  static of(mark: MarkDecoration, dom?: HTMLElement) {
    if (!dom) {
      dom = document.createElement(mark.tagName)
      if (mark.class) dom.className = mark.class
      if (mark.attrs) for (let name in mark.attrs) dom.setAttribute(name, mark.attrs[name])
    }
    return new MarkTile(dom, mark)
  }
}

export class TextTile extends Tile {
  declare dom: Text
  constructor(dom: Text, readonly text: string) {
    super(dom, text.length)
  }

  sync() {
    if (this.flags & TileFlag.Synced) return
    super.sync()
    if (this.dom.nodeValue != this.text) this.dom.nodeValue = this.text
  }

  toString() { return JSON.stringify(this.text) }

  static of(text: string) {
    return new TextTile(document.createTextNode(text), text).synced()
  }
}

export class WidgetTile extends Tile {
  declare dom: HTMLElement

  constructor(dom: HTMLElement, length: number, readonly widget: WidgetType, readonly side: number) {
    super(dom, length)
  }

  get isEditable() { return false }

  destroy() { this.widget.destroy(this.dom) }

  static of(widget: WidgetType, view: EditorView, length: number, side: number, dom?: HTMLElement | null) {
    if (!dom) {
      dom = widget.toDOM(view)
      if (!widget.editable) dom.contentEditable = "false"
    }
    return new WidgetTile(dom, length, widget, side).synced()
  }
}

// These are drawn around uneditable widgets to avoid a number of
// browser bugs that show up when the cursor is directly next to
// uneditable inline content.
export class WidgetBufferTile extends Tile {
  declare dom: HTMLElement

  constructor(readonly side: number) {
    let img = document.createElement("img")
    img.className = "cm-widgetBuffer"
    img.setAttribute("aria-hidden", "true")
    super(img, 0)
  }
}
