import {Tile, DocTile, CompositeTile, LineTile, MarkTile, BlockWrapperTile,
        WidgetTile, TextTile, WidgetBufferTile, Reused, TileFlag, TilePointer} from "./tile"
import {ChangedRange} from "./extension"
import {Decoration, DecorationSet, MarkDecoration, PointDecoration, WidgetType} from "./decoration"
import {RangeSet, TextIterator, SpanIterator} from "@codemirror/state"
import {EditorView} from "./editorview"
import {Composition} from "./docview"
import browser from "./browser"

const enum Buf { No = 0, Yes = 1, IfCursor = 2 }

const enum T { Chunk = 512 }

const LOG_builder = true

export class TileBuilder {
  old: TilePointer
  oldLen: number
  new: CompositeTile
  newRoot: CompositeTile
  reused: Map<Tile, Reused> = new Map
  // After a replace, if a widget at the end of the replace stuck out
  // after the replaced range, this holds the tile for it
  openWidget: WidgetTile | null = null

  // Used by the builder to run through document text
  cursor: TextIterator
  text: string = ""
  textOff: number = 0
  skip: number = 0

  constructor(readonly view: EditorView,
              old: DocTile,
              // FIXME readonly blockRanges: RangeCursor<BlockWrapper>,
              readonly decorations: readonly DecorationSet[],
              readonly disallowBlockEffectsFor: boolean[]) {
    this.cursor = view.state.doc.iter()
    this.old = new TilePointer(old)
    this.oldLen = old.length
    this.new = this.newRoot = new DocTile(old.dom)
  }

  run(changes: readonly ChangedRange[], composition: Composition | null) {
    LOG_builder && console.log("Build with changes", JSON.stringify(changes))
    LOG_builder && composition && console.log("Composition", JSON.stringify(composition.range), composition.text.nodeValue)
    LOG_builder && console.log("<<< " + this.old.tile)

    for (let posA = 0, posB = 0, i = 0;;) {
      let next = i < changes.length ? changes[i++] : null
      let skipA = next ? next.fromA : this.oldLen
      if (skipA > posA) {
        LOG_builder && console.log("Preserve", posA, "to", skipA)
        let len = skipA - posA
        this.preserve(len, !i, !next)
        LOG_builder && console.log("@ " + this.new + " / " + this.old.tile, this.old.index)
        posA = skipA
        posB += len
      }
      if (!next) break
      if (composition && next == composition.range) {
        LOG_builder && console.log("Composition", posB, "to", next.toB, "over", posA, "to", next.toA)
        this.emit(posB, posB, 0, false)
        this.composition(composition)
        this.emit(next.toB, next.toB, 0)
      } else {
        LOG_builder && console.log("Emit", posB, "to", next.toB, "over", posA, "to", next.toA)
        this.emit(posB, next.toB, next.toA - posA)
      }
      LOG_builder && console.log("@ " + this.new + " / " + this.old.tile, this.old.index)
      posB = next.toB
      posA = next.toA
    }
    while (this.new.parent) this.leaveTile()
    LOG_builder && console.log(">>> " + this.new)
    return this.new
  }

  preserve(length: number, incStart: boolean, incEnd: boolean) {
    this.old.advance(length, incEnd ? 1 : -1, {
      skip: (tile, from, to) => {
        let openWidget = this.getOpenWidget()
        if (openWidget && tile instanceof WidgetTile) {
          openWidget.length += to - from
          this.openWidget = null
        } else if (from > 0 || to < tile.length) { // Partial leaf node
          if (tile instanceof TextTile) {
            this.addText(tile.text.slice(from, to))
          } else if (tile instanceof WidgetTile) {
            this.addTile(WidgetTile.of(tile.widget, this.view, to - from, tile.side, this.maybeReuse(tile)))
          }
        } else if (!this.reused.has(tile)) {
          this.reused.set(tile, Reused.Full)
          this.addTile(tile)
        } else {
          if (!(tile instanceof CompositeTile)) throw new Error("Double use of leaf tile")
          let copy = tile.clone()
          for (let ch of tile.children) {
            this.reused.set(ch, Reused.Full)
            copy.append(ch)
          }
          this.addTile(copy)
        }
      },
      enter: (tile) => {
        this.enterTile(tile.clone(this.maybeReuse(tile)))
      },
      leave: (tile) => {
        this.leaveTile()
      },
      break: () => {
        this.new.lastChild!.breakAfter = 1
      },
    })
    this.skipText(length)
  }

  emit(from: number, to: number, lenA: number, sync = true) {
    let iter = new TileDecoIterator(this, () => this.old.advance(lenA, 1))
    let openEnd = RangeSet.spans(this.decorations, from, to, iter)
    iter.finish(openEnd)

    if (sync && to < this.view.state.doc.length) this.syncContext(openEnd)
  }

  composition(composition: Composition) {
    let marks: MarkTile[] = [], head: CompositeTile | undefined
    let ptr = this.old.root.resolveDOM(composition.text, 0)
    for (let tile = ptr.tile, depth = ptr.parents.length;;) {
      if (tile instanceof MarkTile) {
        marks.push(tile)
      } else if (tile instanceof LineTile) {
        head = tile
      }
      if (!depth) break
      tile = ptr.parents[--depth].tile
    }
    if (!head) throw new Error("not in a line")
    for (let i = marks.length - 1; i >= 0; i--) {
      let mark = marks[i]
      let last: Tile | null = head.lastChild
      if (last instanceof MarkTile && last.mark.eq(mark.mark)) {
        if (last.dom != mark.dom) last.setDOM(freeNode(mark.dom))
        head = last
      } else {
        if (this.reused.get(mark)) {
          let tile = Tile.get(mark.dom)
          if (tile) tile.setDOM(freeNode(mark.dom))
        }
        let nw = MarkTile.of(mark.mark, mark.dom)
        head.append(nw)
        head = nw
      }
      this.reused.set(mark, Reused.DOM)
    }
    let text = new TextTile(composition.text, composition.text.nodeValue!)
    text.flags |= TileFlag.Composition
    head.append(text)
    this.new = head
    this.old.advance(composition.range.toA - composition.range.fromA, -1)
  }

  addTile(tile: Tile) {
    let last
    if (tile instanceof TextTile && ((last = this.new.lastChild) instanceof TextTile)) {
      this.new.children[this.new.children.length - 1] = new TextTile(last.dom, last.text + tile.text)
    } else {
      this.new.append(tile)
    }
  }

  addText(text: string) {
    let last = this.new.lastChild
    if (last instanceof TextTile) {
      this.new.children[this.new.children.length - 1] = new TextTile(last.dom, last.text + text)
      this.new.length += text.length
    } else {
      this.addTile(TextTile.of(text))
    }
  }

  ensureBreak(tile: LineTile) {
    let last = tile.lastChild
    if (!last || !hasContent(tile, false) ||
        last.dom.nodeName != "BR" && !last.isEditable && !(browser.ios && hasContent(tile, true)))
      tile.append(WidgetTile.of(BreakWidget, this.view, 0, 1))
  }

  leaveTile() {
    if (this.new instanceof LineTile) this.ensureBreak(this.new)
    this.new = this.new.parent!
    if (!this.new) throw new Error("Left doc tile")
  }

  enterTile(tile: CompositeTile) {
    this.new.append(tile)
    this.new = tile
  }

  getOpenWidget() {
    if (this.openWidget && this.new.lastChild != this.openWidget) this.openWidget = null
    return this.openWidget
  }

  syncContext(open: number) {
    // FIXME handle block wrappers
    let nw = this.newRoot, line: LineTile | null = null
    if (this.old.parents.length) for (let i = 1;;) {
      let level = i == this.old.parents.length ? this.old : this.old.parents[i++]
      let {tile} = level, nwNext = nw.lastChild
      if (tile instanceof LineTile) {
        if (!nwNext || !(nwNext instanceof LineTile)) {
          nwNext = LineTile.start(LineTile.baseAttrs, this.maybeReuse(tile))
          nw.append(nwNext)
        } else {
          line = nwNext
        }
      } else if (tile instanceof MarkTile) {
        if (open <= 0 || !nwNext || !(nwNext instanceof MarkTile)) {
          nwNext = MarkTile.of(tile.mark, this.maybeReuse(tile))
          nw.append(nwNext)
        }
        open--
      } else {
        if (open > 0 && nwNext instanceof WidgetTile) this.openWidget = nwNext
        break
      }
      nw = nwNext as CompositeTile
      if (level == this.old) break
    }
    for (let scan: CompositeTile | null = this.new; scan; scan = scan.parent) {
      if (scan instanceof LineTile && scan != line) { this.ensureBreak(scan); break }
    }
    this.new = nw
  }

  skipText(len: number) {
    // Advance the iterator past the replaced content
    if (this.textOff + len <= this.text.length) {
      this.textOff += len
    } else {
      this.skip += len - (this.text.length - this.textOff)
      this.text = ""
      this.textOff = 0
    }
  }

  nextChars(maxLen: number): null | string { // Null indicates a line break
    if (this.textOff == this.text.length) {
      let {value, lineBreak, done} = this.cursor.next(this.skip)
      this.skip = 0
      if (done) throw new Error("Ran out of text content when drawing inline views")
      this.text = value
      let len = this.textOff = Math.min(maxLen, value.length)
      return lineBreak ? null : value.slice(0, len)
    }
    let end = Math.min(this.text.length, this.textOff + maxLen)
    let chars = this.text.slice(this.textOff, end)
    this.textOff = end
    return chars
  }

  maybeReuse<T extends Tile>(tile: T): T["dom"] | undefined {
    if (this.reused.has(tile)) return undefined
    this.reused.set(tile, Reused.DOM)
    return tile.dom
  }
}

function freeNode<N extends HTMLElement | Text>(node: N): N {
  let tile = Tile.get(node)
  if (tile) tile.setDOM(node.cloneNode())
  return node
}

class TileDecoIterator implements SpanIterator<Decoration> {
  atStart = true
  // Set to false directly after a widget that covers the position after it
  atCursorPos = true
  curLine: LineTile | null = null
  pendingBuffer = Buf.No
  bufferMarks: readonly MarkDecoration[] = []

  constructor(readonly build: TileBuilder, public advanceOld: (() => void) | null) {
    for (let line = build.new;;) {
      if (line instanceof LineTile) {
        if (!line.breakAfter) this.curLine = line
        break
      }
      if (line.parent) line = line.parent
      else break
    }
  }

  span(from: number, to: number, active: readonly MarkDecoration[], openStart: number) {
    this.buildText(to - from, active, openStart)
  }

  point(from: number, to: number, deco: Decoration, active: readonly MarkDecoration[], openStart: number, index: number) {
    if (deco instanceof PointDecoration) {
      if (this.build.disallowBlockEffectsFor[index]) {
        if (deco.block)
          throw new RangeError("Block decorations may not be specified via plugins")
        if (to > this.build.view.state.doc.lineAt(from).to)
          throw new RangeError("Decorations that replace line breaks may not be specified via plugins")
      }
      this.buildPoint(from, to, deco, active, openStart)
    } else if ((this.curLine || (!this.blockPosCovered() && this.getLine())) &&
      !hasContent(this.curLine!, false)) { // Line decoration
      this.curLine!.addLineDeco(deco)
    }

    if (to > from) {
      this.atStart = false
      this.build.skipText(to - from)
    }
  }

  getLine() {
    if (!this.curLine) {
      let reuse = this.findReusable(LineTile)
      this.curLine = LineTile.start(LineTile.baseAttrs, reuse?.dom)
      this.build.enterTile(this.curLine)
      this.atCursorPos = true
    }
    return this.curLine
  }

  endLine() {
    let b = this.build
    while (b.new instanceof MarkTile) b.leaveTile()
    if (b.new instanceof LineTile) {
      let line = b.new
      while (b.new != line.parent) b.leaveTile()
      this.curLine = null
      return line
    }
    return b.new.lastChild
  }

  blockPosCovered() {
    let tile = this.build.new
    if (tile instanceof DocTile || tile instanceof BlockWrapperTile) {
      let last = tile.lastChild
      return last && !last.breakAfter && (last instanceof WidgetTile ? last.side >= 0 : true)
    } else {
      return true
    }
  }

  flushBuffer(active = this.bufferMarks) {
    if (this.pendingBuffer) {
      let line = this.getLine()
      this.syncInlineMarks(line, active, active.length)
      this.build.new.append(new WidgetBufferTile(-1))
      this.pendingBuffer = Buf.No
    }
  }

  syncInlineMarks(line: LineTile, active: readonly MarkDecoration[], openStart: number) {
    let parent: LineTile | MarkTile = line
    for (let i = active.length - 1; i >= 0; i--) {
      let mark = active[i], last
      if (parent && openStart > 0 && (last = parent.lastChild) && last instanceof MarkTile && last.mark.eq(mark)) {
        parent = last
        openStart--
      } else {
        let tile = MarkTile.of(mark, this.findReusable(MarkTile, t => t.mark.eq(mark))?.dom)
        parent.append(tile)
        parent = tile
        openStart = 0
      }
    }
    this.build.new = parent
  }

  addBlockWidget(view: WidgetTile, start: number) {
    this.flushBuffer()
    this.curLine = null
    this.endLine()
    this.build.new.append(view)
  }

  finish(openEnd: number) {
    if (openEnd <= this.bufferMarks.length) this.flushBuffer()
    // Start a line if current position isn't covered properly
    if (!this.blockPosCovered()) this.getLine()
    if (this.advanceOld) this.advanceOld()
  }

  buildText(length: number, active: readonly MarkDecoration[], openStart: number) {
    let b = this.build
    while (length > 0) {
      let chars = b.nextChars(Math.min(T.Chunk, length))
      if (chars == null) { // Line break
        if (!this.blockPosCovered()) this.getLine()
        // FIXME this.updateBlockWrappers(++this.pos)
        this.flushBuffer()
        this.endLine()!.breakAfter = 1
        this.atCursorPos = true
        length--
        openStart = 0
        this.atStart = false
        continue
      }
      let take = Math.min(chars.length, length)
      this.flushBuffer(active.slice(active.length - openStart))
      let line = this.getLine()
      this.syncInlineMarks(line, active, openStart)
      this.build.addText(chars)
      this.atCursorPos = true
      length -= take
      openStart = take == T.Chunk ? 0 : active.length
      this.atStart = false
    }
  }

  buildPoint(from: number, to: number, deco: PointDecoration, active: readonly MarkDecoration[], openStart: number) {
    if (openStart > active.length) { // Continued point
      let last = this.build.new.lastChild
      if (!(last instanceof WidgetTile)) throw new Error("Bad continued widget")
      last.length += to - from
      if (!deco.block) {
        this.pendingBuffer = deco.block || last.isEditable ? Buf.No : Buf.Yes
        if (this.pendingBuffer) this.bufferMarks = active.slice()
      }
    } else if (deco.block) {
      if (deco.startSide > 0 && !this.blockPosCovered()) this.getLine()
      let widget = deco.widget || NullWidget.block
      let reuse = this.findReusable(WidgetTile, t => t.widget.eq(widget))
      this.addBlockWidget(WidgetTile.of(widget, this.build.view, to - from, from == to ? deco.startSide : 0, reuse?.dom), from)
      if (reuse) this.build.reused.set(reuse, Reused.DOM)
    } else {
      let widget = deco.widget || NullWidget.inline
      let reuse = this.findReusable(WidgetTile, t => t.widget.eq(widget))
      let tile = WidgetTile.of(widget, this.build.view, to - from, from == to ? deco.startSide : 0, reuse?.dom)
      let cursorBefore = this.atCursorPos && !tile.isEditable && (from < to || deco.startSide > 0)
      let cursorAfter = !tile.isEditable && (from < to || deco.startSide <= 0)
      let line = this.getLine()
      if (this.pendingBuffer == Buf.IfCursor && !cursorBefore && !tile.isEditable) this.pendingBuffer = Buf.No
      else this.flushBuffer(active)
      this.syncInlineMarks(line, active, openStart)
      if (cursorBefore) this.build.new.append(new WidgetBufferTile(1))
      this.build.new.append(tile)
      this.atCursorPos = cursorAfter
      this.pendingBuffer = !cursorAfter ? Buf.No : from < to || openStart > active.length ? Buf.Yes : Buf.IfCursor
      if (this.pendingBuffer) this.bufferMarks = active.slice()
    }
  }

  findReusable<Cls extends Tile>(cls: new (...args: any) => Cls, test?: (a: Cls) => boolean): Cls | null {
    let found: Cls | null = null
    if (this.atStart) {
      found = this.build.old.findReusableAfter(cls, tile => !this.build.reused.has(tile) && (!test || test(tile)))
    } else if (cls as any == WidgetTile) {
      if (this.advanceOld) { this.advanceOld(); this.advanceOld = null }
      found = this.build.old.findReusableBefore(cls, tile => !this.build.reused.has(tile) && (!test || test(tile)))
    }
    if (found) this.build.reused.set(found, Reused.DOM)
    return found
  }
}

function hasContent(tile: Tile, requireText: boolean) {
  let scan = (tile: Tile) => {
    for (let ch of tile.children)
      if ((requireText ? ch instanceof TextTile : ch.length) || scan(ch)) return true
    return false
  }
  return scan(tile)
}

export class NullWidget extends WidgetType {
  constructor(readonly tag: string) { super() }
  eq(other: NullWidget) { return other.tag == this.tag }
  toDOM() { return document.createElement(this.tag) }
  updateDOM(elt: HTMLElement) { return elt.nodeName.toLowerCase() == this.tag }
  get isHidden() { return true }
  static inline = new NullWidget("span")
  static block = new NullWidget("div")
}

export const BreakWidget = new class extends WidgetType {
  toDOM() { return document.createElement("br") }
  get isHidden() { return true }
  get editable() { return true }
}
