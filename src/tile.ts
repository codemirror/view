import {WidgetType, BlockWrapper, MarkDecoration, LineDecoration} from "./decoration"
import {Attrs, setAttrs, combineAttrs} from "./attributes"
import {domIndex} from "./dom"
import {EditorView} from "./editorview"

export const enum TileFlag {
  BreakAfter = 1,
  Synced = 2,
  AttrsDirty = 4,
  Composition = 8
}

export const enum Reused { Full = 1, DOM = 2 }

const noChildren: readonly Tile[] = []

export abstract class Tile {
  parent: CompositeTile | null = null
  flags = 0 as TileFlag

  constructor(
    public dom: HTMLElement | Text,
    public length: number
  ) {
    ;(dom as any).cmTile = this
  }

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

  setDOM(dom: this["dom"]) {
    this.dom = dom
    ;(dom as any).cmTile = this
  }

  static get(dom: Node) {
    return (dom as any).cmTile
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

  resolve(pos: number, side: -1 | 1) {
    return new TilePointer(this).advance(pos, side)
  }

  resolveDOM(node: Node, offset: number) {
    return TilePointer.fromDOM(this, node, offset)
  }

  owns(tile: Tile | null) {
    for (; tile; tile = tile.parent) if (tile == this) return true
    return false
  }
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


interface TileWalker {
  enter(tile: CompositeTile): void
  leave(tile: CompositeTile): void
  skip(tile: Tile, from: number, to: number): void
  break(): void
}

export class TilePointer {
  public tile: Tile
  public index: number = 0
  public beforeBreak: boolean = false
  readonly parents: {tile: CompositeTile, index: number}[] = []

  constructor(top: DocTile) {
    this.tile = top
  }

  // Advance by the given distance. If side is -1, stop leaving or
  // entering tiles, or skipping zero-length tiles, once the distance
  // has been traversed. When side is 1, leave, enter, or skip
  // everything at the end position.
  advance(dist: number, side: -1 | 1, walker?: TileWalker) {
    let {tile, index, beforeBreak, parents} = this
    while (dist || side > 0) {
      if (!tile.isComposite()) {
        if (index == tile.length) {
          beforeBreak = !!tile.breakAfter
          ;({tile, index} = parents.pop()!)
          index++
        } else if (!dist) {
          break
        } else {
          let take = Math.min(dist, tile.length - index)
          if (walker) walker.skip(tile, index, index + take)
          dist -= take
          index += take
        }
      } else if (beforeBreak) {
        if (!dist) break
        if (walker) walker.break()
        dist--
        beforeBreak = false
      } else if (index == tile.children.length) {
        if (!dist && !parents.length) break
        if (walker) walker.leave(tile)
        beforeBreak = !!tile.breakAfter
        ;({tile, index} = parents.pop()!)
        index++
      } else {
        let next = tile.children[index]
        if (side > 0 ? next.length <= dist : next.length < dist) {
          if (walker) walker.skip(next, 0, next.length)
          index++
          dist -= next.length
        } else {
          parents.push({tile, index})
          tile = next
          index = 0
          if (walker && next.isComposite()) walker.enter(next)
        }
      }
    }
    this.tile = tile
    this.index = index
    this.beforeBreak = beforeBreak
    return this
  }

  findReusableAfter<Cls extends Tile>(cls: new (...args: any) => Cls, test: (a: Cls) => boolean): Cls | null {
    if (this.beforeBreak) return null
    outer: for (let i = this.parents.length, {tile, index} = this;;) {
      if (tile instanceof CompositeTile) {
        while (index < tile.children.length) {
          let next = tile.children[index++]
          if (next instanceof cls && test(next)) return next
          if (next.length || next.breakAfter) return null
        }
      }
      if (!i) return null
      ;({tile, index} = this.parents[--i])
    }
  }

  findReusableBefore<Cls extends Tile>(cls: new (...args: any) => Cls, test: (a: Cls) => boolean): Cls | null {
    outer: for (let i = this.parents.length, {tile, index, beforeBreak} = this;;) {
      if (tile instanceof CompositeTile) {
        while (index > 0) {
          let prev = tile.children[--index]
          if (!beforeBreak && prev.breakAfter) return null
          if (prev instanceof cls && test(prev)) return prev
          if (prev.length) return null
        }
      }
      if (!i) return null
      beforeBreak = false
      ;({tile, index} = this.parents[--i])
    }
  }

  get root() { return (this.parents.length ? this.parents[0].tile : this.tile) as DocTile }

  static fromDOM(doc: DocTile, node: Node, offset: number) {
    let ptr = new TilePointer(doc), tile: Tile | undefined
    for (let cur: Node = node;;) {
      tile = Tile.get(cur)
      if (tile && doc.owns(tile)) break
      let parent = cur.parentNode
      if (!parent) break
      offset = domIndex(cur)
      cur = parent
    }
    if (!tile) return ptr
    if (tile instanceof TextTile) {
      ptr.tile = tile
      ptr.index = offset
    } else if (tile instanceof CompositeTile) {
      ptr.tile = tile
      if (offset > 0) {
        let before = node.childNodes[offset - 1]
        for (let i = 0; i < tile.children.length; i++) {
          if (tile.children[i].dom.compareDocumentPosition(before) & 2 /* PRECEDING */) ptr.index++
          else break
        }
      }
    } else {
      ptr.tile = tile.parent!
      ptr.index = ptr.tile.children.indexOf(tile) + (offset ? 1 : 0)
    }
    for (let t = ptr.tile;;) {
      let parent = t.parent
      if (!parent) break
      ptr.parents.unshift({tile: parent, index: parent.children.indexOf(t)})
      t = parent
    }
    return ptr
  }
}
