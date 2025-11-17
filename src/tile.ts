import {WidgetType, BlockWrapper, MarkDecoration, LineDecoration} from "./decoration"
import {Attrs, updateAttrs, combineAttrs} from "./attributes"
import {EditorView} from "./editorview"

export const enum TileFlag {
  BreakAfter = 1,
  Synced = 2,
  AttrsDirty = 4
}

const noChildren: readonly Tile[] = []

export class Tile {
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

  sync() {
    this.flags |= TileFlag.Synced
  }

  synced() { // FIXME is this a good idea?
    this.flags |= TileFlag.Synced
    return this
  }
}

export class CompositeTile extends Tile {
  declare dom: HTMLElement
  _children: Tile[] = []

  constructor(dom: HTMLElement) {
    super(dom, 0)
  }

  get children() { return this._children }

  get lastChild() { return this.children.length ? this.children[this.children.length - 1] : null }

  append(child: Tile) {
    this.children.push(child)
    child.parent = this
    this.length += child.length + child.breakAfter
  }

  sync() {
    if (this.flags & TileFlag.Synced) return
    super.sync()
    let parent = this.dom, prev: Node | null = null, next
    for (let child of this.children) {
      child.sync()
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
  }
}

// Remove a DOM node and return its next sibling.
function rm(dom: Node): Node | null {
  let next = dom.nextSibling
  dom.parentNode!.removeChild(dom)
  return next
}

export class DocTile extends CompositeTile {
  declare dom: HTMLElement
}

export class BlockWidgetTile extends Tile {
  declare dom: HTMLElement
  constructor(dom: HTMLElement, readonly widget: WidgetType, length: number, readonly side: number) {
    super(dom, length)
  }

  get isEditable() { return false }

  static of(widget: WidgetType, view: EditorView, length: number, side: number) {
    return new BlockWidgetTile(widget.toDOM(view), widget, length, side).synced()
  }
}

export class BlockWrapperTile extends CompositeTile {
  declare dom: HTMLElement
  constructor(dom: HTMLElement, readonly wrapper: BlockWrapper) {
    super(dom)
  }
}

export class LineTile extends CompositeTile {
  declare dom: HTMLElement
  constructor(dom: HTMLElement, public attrs: Attrs | null) {
    super(dom)
  }

  // Only called when building a line view in ContentBuilder
  addLineDeco(deco: LineDecoration) {
    let attrs = deco.spec.attributes, cls = deco.spec.class
    if (attrs) this.attrs = combineAttrs(attrs, this.attrs || {})
    if (cls) this.attrs = combineAttrs({class: cls}, this.attrs || {});
    if (attrs || cls) this.flags |= TileFlag.AttrsDirty
  }

  sync() {
    super.sync()
    if (this.flags & TileFlag.AttrsDirty) {
      this.flags &= ~TileFlag.AttrsDirty
      // FIXME proper update, possibly compare to DOM
      updateAttrs(this.dom, null, this.attrs)
      this.dom.classList.add("cm-line")
    }
  }

  static start() {
    let line = new LineTile(document.createElement("div"), null)
    line.dom.className = "cm-line"
    return line
  }
}

export class MarkTile extends CompositeTile {
  declare dom: HTMLElement
  constructor(dom: HTMLElement, readonly mark: MarkDecoration) {
    super(dom)
  }

  static of(mark: MarkDecoration) {
    // FIXME incremental DOM updates
    let dom = document.createElement(mark.tagName)
    if (mark.class) dom.className = mark.class
    if (mark.attrs) for (let name in mark.attrs) dom.setAttribute(name, mark.attrs[name])
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

  static of(text: string) {
    return new TextTile(document.createTextNode(text), text).synced()
  }
}

export class WidgetTile extends Tile {
  constructor(dom: HTMLElement | Text, length: number, readonly widget: WidgetType, readonly side: number) {
    super(dom, length)
  }

  get isEditable() { return false }

  static of(widget: WidgetType, view: EditorView, length: number, side: number) {
    return new WidgetTile(widget.toDOM(view), length, widget, side).synced()
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
