import {Tile, DocTile, CompositeTile, LineTile, MarkTile, BlockWidgetTile, BlockWrapperTile,
        WidgetTile, TextTile, WidgetBufferTile, TileFlag, Reused} from "./tile"
import {ChangedRange} from "./extension"
import {Decoration, DecorationSet, MarkDecoration, PointDecoration, WidgetType, addRange} from "./decoration"
import {RangeSet, TextIterator, SpanIterator, ChangeSet} from "@codemirror/state"
import {EditorView} from "./editorview"
import {ViewUpdate, decorations} from "./extension"
import browser from "./browser"

const enum Buf { No = 0, Yes = 1, IfCursor = 2 }

const enum T { Chunk = 512 }

// FIXME move to tile.ts
interface TileWalker {
  enter(tile: CompositeTile): void
  leave(tile: CompositeTile): void
  skip(tile: Tile, from: number, to: number): void
  break(): void
  early(n: number): void
}

class TilePointer {
  constructor(
    readonly tile: CompositeTile | TextTile,
    // For text tiles this is the offset into the text. For composite
    // tiles, this is (2 * the index) + 1 in most cases, and (2 * the
    // index) + 0 when pointing in front of the break after the child
    // at index - 1.
    readonly offset: number,
    readonly parent: TilePointer | null
  ) {}

  static start(doc: DocTile) {
    return new TilePointer(doc, 1, null)
  }

  get nextTile() {
    if (this.tile instanceof TextTile || !(this.offset & 1) || (this.offset >> 1) == this.tile.children.length) return null
    return this.tile.children[this.offset >> 1]
  }

  skipNext(tile: Tile) {
    return new TilePointer(this.tile, this.offset + 2 - tile.breakAfter, this.parent)
  }

  advance(dist: number, side: -1 | 1, walker?: TileWalker) {
    let {tile, offset, parent} = this
    while (dist || side > 0) {
      if (tile instanceof TextTile) {
        if (offset == tile.length) {
          ;({tile, offset, parent} = parent!)
          offset += 2
        } else if (!dist) {
          break
        } else {
          let take = Math.min(dist, tile.length - offset)
          if (walker) walker.skip(tile, offset, offset + take)
          dist -= take
          offset += take
        }
      } else if (offset == (tile.children.length << 1) + 1) {
        if (!parent && !dist) break
        if (walker) walker.leave(tile)
        let brk = tile.breakAfter
        ;({tile, offset, parent} = parent!)
        offset += 2 - brk
      } else if (!(offset & 1)) { // Low bit not set, are in front of break
        if (!dist) break
        if (walker) walker.break()
        offset++
        dist--
      } else {
        let next = tile.children[offset >> 1]
        if (side > 0 ? next.length <= dist : next.length < dist) {
          if (walker) walker.skip(next, 0, next.length)
          offset += 2 - next.breakAfter
          dist -= next.length
        } else if (next instanceof CompositeTile || next instanceof TextTile) {
          parent = new TilePointer(tile, offset, parent)
          tile = next
          if (next instanceof TextTile) {
            offset = 0
          } else {
            offset = 1
            if (walker) walker.enter(next)
          }
        } else if (dist < next.length) {
          if (dist && walker) walker.early(dist)
          break
        } else {
          if (walker) walker.skip(next, 0, dist)
          offset += 2 - next.breakAfter
          break
        }
      }
    }
    return new TilePointer(tile, offset, parent)
  }
}

const fullPointRanges = {fullPointRanges: true}

export class TileBuilder {
  new: CompositeTile
  old: TilePointer
  reused: Map<Tile, Reused> = new Map

  // Used by the builder to run through document text
  cursor: TextIterator
  text: string = ""
  textOff: number = 0
  skip: number = 0

  constructor(readonly view: EditorView,
              old: DocTile,
//              readonly blockRanges: RangeCursor<BlockWrapper>,
              readonly decorations: readonly DecorationSet[],
              readonly disallowBlockEffectsFor: boolean[]) {
    this.cursor = view.state.doc.iter()
    this.old = TilePointer.start(old)
    this.new = new DocTile(old.dom)
  }

  run(changes: readonly ChangedRange[]) {
    for (let posA = 0, posB = 0, i = 0;;) {
      let next = i < changes.length ? changes[i++] : null
      let skipB = next ? next.fromB : this.view.state.doc.length
      if (skipB > posB) {
        let len = this.preserve(skipB - posB, i == 0, !next)
        posA += len
        posB += len
      }
      if (!next) break
      if (next.toB >= posB) {
        let len = this.emit(posB, next.toB, next.toA - posA)
        posB += len
        posA = next.toA + (posB - next.toB)
      }
    }
    while (this.new.parent) this.leaveTile()
    return this.new
  }

  preserve(length: number, incStart: boolean, incEnd: boolean) {
    if (!incStart) this.syncBlockContext()
    this.old = this.old.advance(length, incEnd ? 1 : -1, {
      skip: (tile, from, to) => {
        if (tile instanceof TextTile && (from > 0 || to < tile.length)) {
          this.addText(tile.text.slice(from, to))
        } else {
          this.addTile(tile)
          this.reused.set(tile, Reused.Full)
        }
      },
      enter: (tile) => {
        let reuse = !this.reused.has(tile)
        if (reuse) this.reused.set(tile, Reused.DOM)
        if (tile instanceof LineTile) {
          this.enterTile(LineTile.start(tile.attrs, reuse ? tile.dom : undefined, true))
        } else if (tile instanceof MarkTile) {
          this.enterTile(MarkTile.of(tile.mark, reuse ? tile.dom : undefined))
        } else {
          throw new Error("FIXME")
        }
      },
      leave: (tile) => {
        this.leaveTile()
      },
      break: () => {
        this.new.lastChild!.breakAfter = 1
      },
      early: n => length -= n
    })
    this.skipText(length)
    return length
  }

  emit(from: number, to: number, lenA: number) {
    // FIXME this can be more liberal
    let reusable: Tile[] = []
    for (let scan = this.old; scan.parent; scan = scan.parent!) {
      let next = scan.nextTile
      while (next && next.length == 0) {
        reusable.push(next)
        scan = scan.skipNext(next)
        next = scan.nextTile
      }
      if (next && to > from) reusable.push(next)
    }
    this.old = this.old.advance(lenA, 1)
    if (!(this.old.tile instanceof TextTile)) for (let {tile, offset} = this.old; offset > 1; offset -= 2) {
      let prev = tile.children[(offset >> 1) - 1]
      if (prev.length || prev.breakAfter || reusable.includes(prev)) break
      reusable.push(prev)
    }
    let iter = new TileDecoIterator(this, reusable)
    RangeSet.spans(this.decorations, from, to, iter, fullPointRanges)
    iter.finish()
    if (iter.pointEnd > to) {
      // FIXME if the point at the end of the iterated range covers another change, this isn't valid
      this.old = this.old.advance(iter.pointEnd - to, 1)
      to = iter.pointEnd
    }
    return to - from
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

  leaveTile() {
    if (this.new instanceof LineTile) {
      let last = this.new.lastChild
      if (!last || !hasContent(this.new, false) ||
          last.dom.nodeName != "BR" && !last.isEditable && !(browser.ios && hasContent(this.new, true)))
        this.new.append(WidgetTile.of(BreakWidget, this.view, 0, 1))
    }
    this.new = this.new.parent!
  }

  enterTile(tile: CompositeTile) {
    this.new.append(tile)
    this.new = tile
  }

  syncBlockContext() {
    // FIXME handle block wrappers
    let inLine = false
    for (let cur = this.old as TilePointer | null; cur; cur = cur.parent) {
      if (cur.tile instanceof LineTile) inLine = true
    }
    while (!inLine && !(this.new instanceof DocTile)) this.leaveTile()
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
}

// FIXME DOM reuse
class TileDecoIterator implements SpanIterator<Decoration> {
  pointEnd: number = -1
  // Set to false directly after a widget that covers the position after it
  atCursorPos = true
  curLine: LineTile | null = null
  pendingBuffer = Buf.No
  bufferMarks: readonly MarkDecoration[] = []

  constructor(readonly build: TileBuilder, readonly reusable: Tile[]) {
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
    from = Math.max(this.pointEnd, from)
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

    if (to > from) this.build.skipText(to - from)
    this.pointEnd = to
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
      return last && !last.breakAfter && (last instanceof BlockWidgetTile ? last.side > 0 : true)
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
    // FIXME go through leaveTile/enterTile somehow?
    this.build.new = parent
  }

  addBlockWidget(view: BlockWidgetTile, start: number) {
    this.flushBuffer()
    this.curLine = null
    this.endLine()
    this.build.new.append(view)
  }

  finish() {
    this.flushBuffer()
    if (!this.blockPosCovered()) this.getLine()
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
    }
  }

  buildPoint(from: number, to: number, deco: PointDecoration, active: readonly MarkDecoration[], openStart: number) {
    if (deco.block) {
      if (deco.startSide > 0 && !this.blockPosCovered()) this.getLine()
      let widget = deco.widget || NullWidget.block
      let reuse = this.findReusable(BlockWidgetTile, t => t.widget.eq(widget))
      this.addBlockWidget(BlockWidgetTile.of(widget, this.build.view, to - from, from == to ? deco.startSide : 0, reuse?.dom), from)
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

  findReusable<Cls>(cls: new (...args: any) => Cls, test?: (a: Cls) => boolean): Cls | null {
    for (let i = 0; i < this.reusable.length; i++) {
      let tile = this.reusable[i]
      if (tile instanceof cls && !this.build.reused.has(tile) && (!test || test(tile))) {
        this.build.reused.set(tile, Reused.DOM)
        this.reusable.splice(i, 1)
        return tile
      }
    }
    return null
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

// FIXME put in own file? Better name?
export class TileManager {
  decorations: readonly DecorationSet[]
  tile: DocTile

  constructor(readonly view: EditorView) {
    this.decorations = this.getDecorations()
    let build = new TileBuilder(view, new DocTile(document.createElement("div")), this.decorations, [])
    build.run([new ChangedRange(0, 0, 0, view.state.doc.length)])
    build.new.sync()
    this.tile = build.new
  }

  update(update: ViewUpdate) {
    let changedRanges = update.changedRanges
    // FIXME track minWidth somewhere
    // FIXME this.updateEditContextFormatting(update)
    // FIXME composition should probably be passed in
    // FIXME manage selection

    let prevDeco = this.decorations
    this.decorations = this.getDecorations()
    let decoDiff = findChangedDeco(prevDeco, this.decorations, update.changes)
    changedRanges = ChangedRange.extendWithRanges(changedRanges, decoDiff)

    if (!changedRanges.length && (this.tile.flags & TileFlag.Synced)) return false

    let builder = new TileBuilder(this.view, this.tile, this.decorations, [])
    for (let ch of this.tile.children) ch.destroyDropped(builder.reused)
    this.tile = builder.run(changedRanges)
    this.tile.sync()
  }

  getDecorations() {
    // FIXME add spacers and such
    return this.view.state.facet(decorations).map(d => typeof d == "function" ? d(this.view) : d)
  }
}

class DecorationComparator {
  changes: number[] = []
  compareRange(from: number, to: number) { addRange(from, to, this.changes) }
  comparePoint(from: number, to: number) { addRange(from, to, this.changes) }
  boundChange(pos: number) { addRange(pos, pos, this.changes) }
}

function findChangedDeco(a: readonly DecorationSet[], b: readonly DecorationSet[], diff: ChangeSet) {
  let comp = new DecorationComparator
  RangeSet.compare(a, b, diff, comp)
  return comp.changes
}
