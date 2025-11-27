import {Text as DocText} from "@codemirror/state"
import {WidgetType, BlockWrapper, MarkDecoration} from "./decoration"
import {Attrs, setAttrs} from "./attributes"
import {type EditorView} from "./editorview"
import {Rect, textRange, maxOffset, domIndex, flattenRect, clientRectsFor, DOMPos} from "./dom"
import browser from "./browser"

export const enum TileFlag {
  BreakAfter = 1,
  Synced = 2,
  AttrsDirty = 4,
  Composition = 8
}

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

  get children() { return noChildren }

  isWidget(): this is WidgetTile { return false }

  get isHidden() { return false }

  get isPointBefore() { return false }

  get isPointAfter() { return false }

  isComposite(): this is CompositeTile { return false }

  isLine(): this is LineTile { return false }

  isText(): this is TextTile { return false }

  isBlock() { return false }

  sync() {
    this.flags |= TileFlag.Synced
  }

  toString() {
    return this.constructor.name + (this.children.length ? `(${this.children})` : "") + (this.breakAfter ? "#" : "")
  }

  destroy() { this.parent = null }

  setDOM(dom: this["dom"]) {
    this.dom = dom
    ;(dom as any).cmTile = this
  }

  get posAtStart(): number {
    return this.parent ? this.parent.posBefore(this) : 0
  }

  get posAtEnd(): number {
    return this.posAtStart + this.length
  }

  posBefore(tile: Tile): number {
    let pos = this.posAtStart
    for (let child of this.children) {
      if (child == tile) return pos
      pos += child.length + child.breakAfter
    }
    throw new RangeError("Invalid child in posBefore")
  }

  posAfter(tile: Tile): number {
    return this.posBefore(tile) + tile.length
  }

  covers(side: -1 | 1) { return true }

  coordsIn(pos: number, side: number): Rect | null { return null }

  domPosFor(off: number, side: number) {
    let index = domIndex(this.dom)
    let after = this.length ? off > 0 : side > 0
    return new DOMPos(this.parent!.dom, index + (after ? 1 : 0), off == 0 || off == this.length)
  }

  markDirty(attrs: boolean) {
    // FIXME handle dirty attrs on non-line tiles somehow
    this.flags &= ~TileFlag.Synced
    if (this.parent) this.parent.markDirty(false)
  }

  get overrideDOMText(): DocText | null { return null }

  get root(): DocTile | null {
    for (let t: Tile | null = this; t; t = t.parent) if (t instanceof DocTile) return t
    return null
  }

  static get(dom: Node) {
    return (dom as any).cmTile as Tile | undefined
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
    if (this.flags & TileFlag.Synced) throw new Error("Adding to synced tile " + this)
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
  constructor(readonly view: EditorView, dom: HTMLElement) {
    super(dom)
  }

  clone(dom?: HTMLElement) { return new DocTile(this.view, dom!) }

  resolve(pos: number, side: -1 | 1) {
    return new TilePointer(this).advance(pos, side)
  }

  owns(tile: Tile | null) {
    for (; tile; tile = tile.parent) if (tile == this) return true
    return false
  }

  isBlock() { return true }

  nearest(dom: Node | null): Tile | null {
    for (;;) {
      if (!dom) return null
      let tile = Tile.get(dom)
      if (tile && this.owns(tile)) return tile
      dom = dom.parentNode
    }
  }

  blockTiles<T>(f: (tile: WidgetTile | LineTile, pos: number) => T | undefined) {
    for (let stack: number[] = [], cur: CompositeTile = this, i = 0, pos = 0;;) {
      if (i == cur.children.length) {
        if (!stack.length) return
        cur = cur.parent!
        if (cur.breakAfter) pos++
        i = stack.pop()!
      } else {
        let next = cur.children[i++]
        if (next instanceof BlockWrapperTile) {
          stack.push(i)
          cur = next
          i = 0
        } else {
          let end = pos + next.length
          let result = f(next as WidgetTile | LineTile, pos)
          if (result !== undefined) return result
          pos = end + next.breakAfter
        }
      }
    }
  }

  // Find the block at the given position. If side < -1, make sure to
  // stay before block widgets at that position, if side > 1, after
  // such widgets (used for selection drawing, which needs to be able
  // to get coordinates for positions that aren't valid cursor positions).
  resolveBlock(pos: number, side: number): {tile: LineTile | WidgetTile, offset: number} {
    let before: LineTile | WidgetTile | undefined, beforeOff = -1, after: LineTile | WidgetTile | undefined, afterOff = -1
    this.blockTiles((tile, off) => {
      let end = off + tile.length
      if (pos >= off && pos <= end) {
        if (tile.isWidget() && side >= -1 && side <= 1) {
          if (tile.side & Side.After) return true
          if (tile.side & Side.Before) before = undefined
        }
        if ((off < pos || pos == end && (side < -1 ? tile.length : tile.covers(1))) &&
            (!before || !tile.isWidget() && before.isWidget())) {
          before = tile
          beforeOff = pos - off
        }
        if ((end > pos || pos == off && (side > 1 ? tile.length : tile.covers(-1))) &&
            (!after || !tile.isWidget() && after.isWidget())) {
          after = tile
          afterOff = pos - off
        }
      }
    })
    if (!before && !after) throw new Error("No tile at position " + pos)
    return before && side < 0 || !after ? {tile: before!, offset: beforeOff} : {tile: after, offset: afterOff}
  }
}

export class BlockWrapperTile extends CompositeTile {
  declare dom: HTMLElement
  constructor(dom: HTMLElement, readonly wrapper: BlockWrapper) {
    super(dom)
  }

  clone(dom?: HTMLElement) { return BlockWrapperTile.of(this.wrapper, dom) }

  isBlock() { return true }

  covers(side: -1 | 1) {
    if (!this.children.length) return false
    return side < 0 ? this.children[0].covers(-1) : this.lastChild!.covers(1)
  }

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

  sync() {
    super.sync()
    if (this.flags & TileFlag.AttrsDirty) {
      this.flags &= ~TileFlag.AttrsDirty
      setAttrs(this.dom, this.attrs)
    }
  }

  isLine(): this is LineTile { return true }

  clone(dom?: HTMLElement) { return LineTile.start(this.attrs, dom) }

  static start(attrs: Attrs, dom?: HTMLElement, keepAttrs?: boolean) {
    let line = new LineTile(dom || document.createElement("div"), attrs)
    if (!dom || !keepAttrs) line.flags |= TileFlag.AttrsDirty
    return line
  }

  markDirty(attrs: boolean) {
    if (attrs) this.flags |= TileFlag.AttrsDirty
    super.markDirty(attrs)
  }

  resolveInline(pos: number, side: number, forCoords?: boolean): {
    tile: TextTile | WidgetTile | WidgetBufferTile,
    offset: number
  } | null {
    let before: Tile | null = null, beforeOff = -1, after: Tile | null = null, afterOff = -1
    function scan(tile: Tile, pos: number) {
      for (let i = 0, off = 0; i < tile.children.length && off <= pos; i++) {
        let child = tile.children[i], end = off + child.length
        if (end >= pos) {
          if (child.isComposite()) {
            scan(child, pos - off)
          } else if ((!after || after.isHidden && (side > 0 || forCoords && onSameLine(after, child))) &&
                     (end > pos || child.isPointAfter)) {
            after = child
            afterOff = pos - off
          } else if (off < pos || child.isPointBefore && !child.isHidden) {
            before = child
            beforeOff = pos - off
          }
        }
        off = end
      }
    }
    scan(this, pos)
    let target = ((side < 0 ? before : after) || before || after) as TextTile | WidgetTile | WidgetBufferTile | null
    return target ? {tile: target, offset: target == before ? beforeOff : afterOff} : null
  }

  coordsIn(pos: number, side: number) {
    let found = this.resolveInline(pos, side, true)
    if (!found) return fallbackRect(this)
    return found.tile.coordsIn(Math.max(0, found.offset), side)
  }

  domIn(pos: number, side: number) {
    let found = this.resolveInline(pos, side)
    if (found) {
      let {tile, offset} = found
      if (this.dom.contains(tile.dom)) {
        if (tile.isText()) return new DOMPos(tile.dom, Math.min(tile.dom.nodeValue!.length, offset))
        return tile.domPosFor(offset, side)
      }
      let parent = found.tile.parent!, saw = false, last: Tile | undefined
      for (let ch of parent.children) {
        if (saw) return new DOMPos(ch.dom, 0)
        if (ch == found.tile) {
          if (last) return new DOMPos(last.dom, maxOffset(last.dom))
          else saw = true
        }
      }
    }
    return new DOMPos(this.dom, 0)
  }
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

  isText(): this is TextTile { return true }

  toString() { return JSON.stringify(this.text) }

  coordsIn(pos: number, side: number) {
    let length = this.dom.nodeValue!.length
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
    let rects = textRange(this.dom, from, to).getClientRects()
    if (!rects.length) return null
    let rect = rects[(flatten ? flatten < 0 : side >= 0) ? 0 : rects.length - 1]
    if (browser.safari && !flatten && rect.width == 0) rect = Array.prototype.find.call(rects, r => r.width) || rect
    return flatten ? flattenRect(rect!, flatten < 0) : rect || null
  }

  static of(text: string, dom?: Text) {
    let tile = new TextTile(dom || document.createTextNode(text), text)
    if (!dom) tile.flags |= TileFlag.Synced
    return tile
  }
}

// FIXME rename
export const enum Side { Before = 1, After = 2, IncStart = 4, IncEnd = 8, Block = 16 }

export class WidgetTile extends Tile {
  declare dom: HTMLElement

  constructor(dom: HTMLElement, length: number, readonly widget: WidgetType, public side: Side) {
    super(dom, length)
  }

  isWidget(): this is WidgetTile { return true }

  get isHidden() { return this.widget.isHidden }
  
  get isPointBefore() { return (this.side & Side.Before) > 0 }

  get isPointAfter() { return (this.side & Side.After) > 0 }

  covers(side: -1 | 1) {
    if (this.side & (Side.Before | Side.After)) return false
    return (this.side & (side < 0 ? Side.IncStart : Side.IncEnd)) > 0
  }

  coordsIn(pos: number, side: number) { return this.coordsInWidget(pos, side, false) }

  coordsInWidget(pos: number, side: number, block: boolean) {
    let custom = this.widget.coordsAt(this.dom, pos, side)
    if (custom) return custom
    if (block) {
      return flattenRect(this.dom.getBoundingClientRect(), this.length ? pos == 0 : side <= 0)
    } else {
      let rects = this.dom!.getClientRects(), rect: Rect | null = null
      if (!rects.length) return null
      let fromBack = (this.side & Side.Before) ? true : (this.side & Side.After) ? false : pos > 0
      for (let i = fromBack ? rects.length - 1 : 0;; i += (fromBack ? -1 : 1)) {
        rect = rects[i]
        if (pos > 0 ? i == 0 : i == rects.length - 1 || rect.top < rect.bottom) break
      }
      return flattenRect(rect, !fromBack)
    }
  }

  get overrideDOMText() {
    if (!this.length) return DocText.empty
    let {root} = this
    if (!root) return DocText.empty
    let start = this.posAtStart
    return root.view.state.doc.slice(start, start + this.length)
  }

  destroy() {
    super.destroy()
    this.widget.destroy(this.dom)
  }

  static of(widget: WidgetType, view: EditorView, length: number, side: Side, dom?: HTMLElement | null) {
    if (!dom) {
      dom = widget.toDOM(view)
      if (!widget.editable) dom.contentEditable = "false"
    }
    return new WidgetTile(dom, length, widget, side)
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

  get isHidden() { return false }

  get isPointBefore() { return this.side < 0 }

  get isPointAfter() { return this.side > 0 }

  get overrideDOMText() { return DocText.empty }

  coordsIn(pos: number): Rect | null { return this.dom.getBoundingClientRect() }
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
          beforeBreak = !!next.breakAfter
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

  get root() { return (this.parents.length ? this.parents[0].tile : this.tile) as DocTile }
}

function fallbackRect(tile: Tile) {
  let last = tile.dom.lastChild
  if (!last) return (tile.dom as HTMLElement).getBoundingClientRect()
  let rects = clientRectsFor(last)
  return rects[rects.length - 1] || null
}

function onSameLine(a: Tile, b: Tile) {
  let posA = a.coordsIn(0, 1), posB = b.coordsIn(0, 1)
  return posA && posB && posB.top < posA.bottom
}
