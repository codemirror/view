import {Tile, DocTile, CompositeTile, LineTile, MarkTile, BlockWrapperTile, Side,
        WidgetTile, TextTile, WidgetBufferTile, TileFlag, TilePointer} from "./tile"
import {ChangedRange} from "./extension"
import {getAttrs} from "./attributes"
import {Decoration, DecorationSet, MarkDecoration, PointDecoration, WidgetType, BlockWrapper} from "./decoration"
import {RangeSet, RangeCursor, TextIterator, SpanIterator} from "@codemirror/state"
import {EditorView} from "./editorview"
import {Composition} from "./docview"
import browser from "./browser"

// FIXME comments
// FIXME see which assertions I want to keep in the code

const LOG_builder = false

const enum Buf { No = 0, Yes = 1, IfCursor = 2 }

export const enum Reused { Full = 1, DOM = 2 }

const enum T { Chunk = 512 }

export class TileBuilder {
  old: TilePointer
  oldLen: number
  new: CompositeTile
  newRoot: CompositeTile
  reused: Map<Tile, Reused> = new Map
  // After a replace, if a widget at the end of the replace stuck out
  // after the replaced range, this holds the tile for it
  openWidget: WidgetTile | null = null
  // Set after a replace, so that preserve can properly sync when it
  // starts the next bloc (the inline content at the start of a preserve
  // may be wrapped differently in the old tree and the new)
  pendingWrappers: OpenWrapper[] | null = null

  // Used by the builder to run through document text
  cursor: TextIterator
  blockWrappers: RangeCursor<BlockWrapper>
  text: string = ""
  textOff: number = 0
  skip: number = 0

  constructor(readonly view: EditorView,
              old: DocTile,
              blockRanges: readonly RangeSet<BlockWrapper>[],
              readonly decorations: readonly DecorationSet[],
              readonly disallowBlockEffectsFor: boolean[]) {
    this.cursor = view.state.doc.iter()
    this.blockWrappers = RangeSet.iter(blockRanges)
    this.old = new TilePointer(old)
    this.oldLen = old.length
    this.new = this.newRoot = old.clone(old.dom)
    this.reused.set(old, Reused.DOM)
  }

  run(changes: readonly ChangedRange[], composition: Composition | null) {
    LOG_builder && console.log("Build with changes", JSON.stringify(changes))
    LOG_builder && composition && console.log("Composition", JSON.stringify(composition.range), composition.text.nodeValue)
    LOG_builder && console.log("<<< " + this.old.tile)
    let compositionContext = composition && this.getCompositionContext(composition.text)

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
      if (composition && next.fromA <= composition.range.fromA && next.toA >= composition.range.toA) {
        LOG_builder && console.log("Composition", posB, "to", next.toB, "over", posA, "to", next.toA)
        this.emit(posB, composition.range.fromB, composition.range.fromA - posA, false)
        this.composition(composition, compositionContext!)
        this.emit(composition.range.toB, next.toB, next.toA - composition.range.toA)
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
    return this.new as DocTile
  }

  preserve(length: number, incStart: boolean, incEnd: boolean) {
    this.old.advance(length, incEnd ? 1 : -1, {
      skip: (tile, from, to) => {
        let openWidget = this.getOpenWidget()
        if (openWidget && tile instanceof WidgetTile) {
          openWidget.length += to - from
          this.openWidget = null
        } else if (from > 0 || to < tile.length) { // Partial leaf node
          if (tile.isText()) {
            this.addText(tile.text.slice(from, to), tile)
          } else if (tile instanceof WidgetTile) {
            this.addTile(WidgetTile.of(tile.widget, this.view, to - from, tile.side, this.maybeReuse(tile)))
          }
        } else if (!this.reused.has(tile)) {
          this.reused.set(tile, Reused.Full)
          tile.flags &= ~(TileFlag.BreakAfter | TileFlag.Composition)
          this.addTile(tile)
        } else {
          if (!(tile instanceof CompositeTile)) throw new Error("Double use of leaf tile " + tile)
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
        if (this.pendingWrappers && tile.isLine()) {
          this.syncTo(0 /* FIXME */, this.newRoot, 0, this.pendingWrappers, 0)
          this.pendingWrappers = null
        }
      },
      break: () => {
        console.log("break at " + this.new)
        this.new.lastChild!.breakAfter = 1
      },
    })
    this.skipText(length)
  }

  emit(from: number, to: number, lenA: number, sync = true) {
    this.blockWrappers.goto(from)
    let iter = new TileDecoIterator(this, lenA)
    let openEnd = RangeSet.spans(this.decorations, from, to, iter)
    iter.finish(to, openEnd)
    if (sync && to < this.view.state.doc.length) this.syncContext(to, iter.wrappers, openEnd)
  }

  composition(composition: Composition, context: {marks: MarkTile[], line: LineTile}) {
    let line: CompositeTile | null = this.new
    while (line && !line.isLine()) line = line.parent
    if (!line) throw new Error("Not in a line")

    if (line.dom != context.line.dom) {
      line.setDOM(this.reused.has(context.line) ? freeNode(context.line.dom) : context.line.dom)
      this.reused.set(context.line, Reused.DOM)
    }

    let head: CompositeTile = line
    for (let i = context.marks.length - 1; i >= 0; i--) {
      let mark = context.marks[i]
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

  getCompositionContext(text: Text) {
    let marks: MarkTile[] = [], line: LineTile | null = null
    for (let parent = text.parentNode as HTMLElement;; parent = parent.parentNode as HTMLElement) {
      let tile = Tile.get(parent)
      if (parent == this.view.contentDOM) break
      if (tile instanceof MarkTile)
        marks.push(tile)
      else if (tile?.isLine())
        line = tile
      else if (parent.nodeName == "DIV" && !line && parent != this.view.contentDOM)
        line = new LineTile(parent, LineTile.baseAttrs)
      else
        marks.push(MarkTile.of(new MarkDecoration({tagName: parent.nodeName.toLowerCase(), attributes: getAttrs(parent)}), parent))
    }
    if (!line) throw new Error("not in a line")
    return {line, marks}
  }

  addTile(tile: Tile) {
    let last
    if (tile.isText() && ((last = this.new.lastChild) instanceof TextTile) && !(last.flags & TileFlag.Composition)) {
      this.new.children[this.new.children.length - 1] = new TextTile(last.dom, last.text + tile.text)
    } else {
      this.new.append(tile)
    }
  }

  addText(text: string, source: TextTile | null) {
    let last = this.new.lastChild
    if (last?.isText() && !(last.flags & TileFlag.Composition)) {
      let tile = this.new.children[this.new.children.length - 1] = new TextTile(last.dom, last.text + text)
      this.reused.set(last, Reused.DOM)
      this.new.length += text.length
      tile.parent = this.new
    } else {
      this.addTile(TextTile.of(text, source ? this.maybeReuse(source) : undefined))
    }
  }

  ensureBreak(tile: LineTile) {
    let last = tile.lastChild
    if (!last || !hasContent(tile, false) ||
        last.dom.nodeName != "BR" && last.isWidget() && !(browser.ios && hasContent(tile, true)))
      tile.append(WidgetTile.of(BreakWidget, this.view, 0, Side.After))
  }

  leaveTile() {
    if (this.new.isLine()) this.ensureBreak(this.new)
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

  // FIXME call at the start of preserve instead?
  syncContext(pos: number, openWrappers: OpenWrapper[], openMarks: number) {
    let lineDepth = this.old.tile.isLine() ? this.old.parents.length : this.old.parents.findIndex(p => p.tile.isLine())
    let curLine: CompositeTile | null = this.new
    while (curLine && !curLine.isLine) curLine = curLine.parent

    if (lineDepth > -1 && curLine) {
      // Sync only the inline part
      this.pendingWrappers = openWrappers
      this.syncTo(pos, curLine, lineDepth, null, openMarks)
    } else {
      // Sync fully
      this.pendingWrappers = null
      this.syncTo(pos, this.newRoot, 0, openWrappers, openMarks)
    }
  }

  syncTo(pos: number, parent: CompositeTile, fromDepth: number, openWrappers: OpenWrapper[] | null, openMarks: number) {
    let line: LineTile | null = null
    for (let i = fromDepth + 1, wrapDepth = 0;;) {
      if (i > this.old.parents.length) break
      let level = i == this.old.parents.length ? this.old : this.old.parents[i++]
      let {tile} = level, next = parent.lastChild
      if (tile.isLine()) {
        if (!next || !next.isLine()) {
          parent.append(next = LineTile.start(LineTile.baseAttrs, this.maybeReuse(tile)))
        } else {
          line = next
        }
      } else if (tile instanceof BlockWrapperTile) {
        let open = openWrappers && wrapDepth < openWrappers.length && openWrappers[wrapDepth++].to >= pos
        if (!open || !(next instanceof BlockWrapperTile) || !next.wrapper.eq(tile.wrapper)) {
          parent.append(next = tile.clone(this.maybeReuse(tile)))
        }
      } else if (tile instanceof MarkTile) {
        if (openMarks <= 0 || !next || !(next instanceof MarkTile)) {
          parent.append(next = MarkTile.of(tile.mark, this.maybeReuse(tile)))
        }
        openMarks--
      } else {
        if (openMarks > 0 && next instanceof WidgetTile) this.openWidget = next
        break
      }
      parent = next as CompositeTile
    }
    for (let scan: CompositeTile | null = this.new; scan; scan = scan.parent) {
      if (scan.isLine() && scan != line) { this.ensureBreak(scan); break }
    }
    this.new = parent
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
  if (tile) tile.setDOM(node.cloneNode() as any)
  return node
}

class OpenWrapper {
  constructor(
    readonly from: number,
    readonly to: number,
    readonly wrapper: BlockWrapper,
    readonly rank: number
  ) {}
}

class TileDecoIterator implements SpanIterator<Decoration> {
  atStart = true
  // Set to false directly after a widget that covers the position after it
  atCursorPos = true
  curLine: LineTile | null = null
  pendingBuffer = Buf.No
  bufferMarks: readonly MarkDecoration[] = []
  wrappers: OpenWrapper[] = []

  constructor(readonly build: TileBuilder, public advanceDist: number) {
    for (let line = build.new;;) {
      if (line.isLine()) {
        if (!line.breakAfter) this.curLine = line
        break
      }
      if (line.parent) line = line.parent
      else break
    }
  }

  span(from: number, to: number, active: readonly MarkDecoration[], openStart: number) {
    this.buildText(from, to, active, openStart)
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
    } else if ((this.curLine || (!this.blockPosCovered() && this.getLine(from))) &&
      !hasContent(this.curLine!, false)) { // Line decoration
      this.curLine!.addLineDeco(deco)
    }

    if (to > from) {
      this.atStart = false
      this.build.skipText(to - from)
    }
  }

  getLine(pos: number) {
    if (!this.curLine) {
      this.syncBlockWrappers(pos)
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
    if (b.new.isLine()) {
      let line = b.new
      while (b.new != line.parent) b.leaveTile()
      this.curLine = null
      return line
    }
    return b.new.lastChild
  }

  syncBlockWrappers(pos: number) {
    // FIXME there is an issue if this adjusts the number of block
    // wrappers—iterating over their closing point will close too few
    // or too many tiles
    for (let i = this.wrappers.length - 1 ; i >= 0; i--)
      if (this.wrappers[i].to < pos) this.wrappers.splice(i, 1)
    let open = this.wrappers.length
    for (let cur = this.build.blockWrappers; cur.value && cur.from <= pos; cur.next()) if (cur.to >= pos) {
      let wrap = new OpenWrapper(cur.from, cur.to, cur.value, cur.rank), i = this.wrappers.length
      while (i > 0 && this.wrappers[i - 1].rank > wrap.rank) i--
      this.wrappers.splice(i, 0, wrap)
      open = Math.min(i, open)
    }
    let nw = this.build.newRoot
    for (let wrap of this.wrappers) {
      let last = nw.lastChild
      if (open > 0 && last instanceof BlockWrapperTile && last.wrapper.eq(wrap.wrapper)) {
        nw = last
      } else {
        let tile = BlockWrapperTile.of(wrap.wrapper, this.findReusable(BlockWrapperTile, t => t.wrapper.eq(wrap.wrapper))?.dom)
        nw.append(tile)
        nw = tile
      }
      open--
    }
    this.build.new = nw
  }

  blockPosCovered() {
    let tile = this.build.new
    if (tile instanceof DocTile || tile instanceof BlockWrapperTile) {
      let last = tile.lastChild
      return last && !last.breakAfter && (!last.isWidget() || (last.side & (Side.After | Side.IncEnd)) > 0)
    } else {
      return true
    }
  }

  flushBuffer(pos: number, active = this.bufferMarks) {
    if (this.pendingBuffer) {
      let line = this.getLine(pos)
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

  addBlockWidget(view: WidgetTile, pos: number) {
    this.flushBuffer(pos)
    this.curLine = null
    this.endLine()
    this.syncBlockWrappers(pos)
    this.build.new.append(view)
  }

  finish(pos: number, openEnd: number) {
    if (openEnd <= this.bufferMarks.length) this.flushBuffer(pos)
    // Start a line if current position isn't covered properly
    if (!this.blockPosCovered()) this.getLine(pos)
    this.advanceOld()
  }

  advanceOld() {
    if (this.advanceDist > -1) {
      this.build.old.advance(this.advanceDist, 1)
      this.advanceDist = -1
    }
  }

  buildText(from: number, to: number, active: readonly MarkDecoration[], openStart: number) {
    let b = this.build, pos = from
    while (pos < to) {
      let chars = b.nextChars(Math.min(T.Chunk, to - pos))
      if (chars == null) { // Line break
        if (!this.blockPosCovered()) this.getLine(pos)
        this.flushBuffer(pos)
        this.endLine()!.breakAfter = 1
        this.atCursorPos = true
        pos++
        // FIXME attach breakAfter here?
        openStart = 0
        this.atStart = false
        continue
      }
      let take = Math.min(chars.length, to - pos)
      this.flushBuffer(pos, active.slice(active.length - openStart))
      let line = this.getLine(pos)
      this.syncInlineMarks(line, active, openStart)
      this.build.addText(chars, this.atStart ? this.findReusableAtStart(TextTile) : null)
      this.atCursorPos = true
      pos += take
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
        this.pendingBuffer = deco.block || !last.isWidget() ? Buf.No : Buf.Yes
        if (this.pendingBuffer) this.bufferMarks = active.slice()
      }
    } else if (deco.block) {
      if (deco.startSide > 0 && !this.blockPosCovered()) this.getLine(from)
      let widget = deco.widget || NullWidget.block
      let reuse = this.findReusableWidget(widget)
      this.addBlockWidget(WidgetTile.of(widget, this.build.view, to - from, widgetSide(deco), reuse?.dom), from)
    } else {
      let widget = deco.widget || NullWidget.inline
      let reuse = this.findReusableWidget(widget)
      let tile = WidgetTile.of(widget, this.build.view, to - from, widgetSide(deco), reuse?.dom)
      let cursorBefore = this.atCursorPos && tile.isWidget() && (deco.isReplace || deco.startSide > 0)
      let cursorAfter = tile.isWidget() && (deco.isReplace || deco.startSide <= 0)
      let line = this.getLine(from)
      if (this.pendingBuffer == Buf.IfCursor && !cursorBefore && tile.isWidget()) this.pendingBuffer = Buf.No
      else this.flushBuffer(from, active)
      this.syncInlineMarks(line, active, openStart)
      if (cursorBefore) this.build.new.append(new WidgetBufferTile(1))
      this.build.new.append(tile)
      this.atCursorPos = cursorAfter
      this.pendingBuffer = !cursorAfter ? Buf.No : deco.isReplace ? Buf.Yes : Buf.IfCursor
      if (this.pendingBuffer) this.bufferMarks = active.slice()
    }
  }

  findReusableAtStart<Cls extends Tile>(cls: new (...args: any) => Cls, test?: (a: Cls) => boolean): Cls | null {
    let {tile, index, beforeBreak, parents} = this.build.old
    if (beforeBreak) return null
    for (let d = parents.length;;) {
      if (index == (tile.isComposite() ? tile.children.length : tile.length)) {
        if (!d) return null
        let parent = --d >= parents.length ? tile.parent! : parents[d].tile
        index = parent.children.indexOf(tile) + 1
        tile = parent
      } else if (tile.isComposite()) {
        let next = tile.children[index++]
        if ((next.isComposite() || this.advanceDist > 0 || !next.length) &&
            next instanceof cls &&
            !this.build.reused.has(next) &&
            (!test || test(next)))
          return next
        if (next.isComposite()) {
          d++
          tile = next
          index = 0
        } else if (next.length || next.breakAfter) {
          return null
        }
      } else {
        return null
      }
    }
  }

  findReusableAtEnd(widget: WidgetType): WidgetTile | null {
    this.advanceOld()
    for (let {tile, index, parents} = this.build.old, d = parents.length;;) {
      if (!index) {
        if (!d) return null
        let parent = d-- >= parents.length ? tile.parent! : parents[d].tile
        index = tile.parent!.children.indexOf(tile)
        tile = parent
      } else if (tile.isComposite()) {
        let prev = tile.children[--index]
        if (prev.breakAfter) return null
        if (prev.isWidget() && !this.build.reused.has(prev) && this.canReuseWidget(prev, widget))
          return prev
        if (prev.isComposite()) {
          tile = prev
          index = prev.children.length
          d++
        } else if (prev.length) {
          return null
        }
      } else {
        return null
      }
    }
    return null
  }

  findReusable<Cls extends Tile>(cls: new (...args: any) => Cls, test?: (a: Cls) => boolean): Cls | null {
    let found = this.atStart ? this.findReusableAtStart(cls, test) : null
    if (found) this.build.reused.set(found, Reused.DOM)
    return found
  }

  findReusableWidget(widget: WidgetType) {
    let found = this.atStart ? this.findReusableAtStart(WidgetTile, t => this.canReuseWidget(t, widget)) :
      this.findReusableAtEnd(widget)
    if (found) this.build.reused.set(found, Reused.DOM)
    return found
  }

  canReuseWidget(tile: WidgetTile, widget: WidgetType) {
    return tile.widget.constructor == widget.constructor && (tile.widget.eq(widget) || widget.updateDOM(tile.dom, this.build.view))
  }
}

function hasContent(tile: Tile, requireText: boolean) {
  let scan = (tile: Tile) => {
    for (let ch of tile.children)
      if ((requireText ? ch.isText() : ch.length) || scan(ch)) return true
    return false
  }
  return scan(tile)
}

function widgetSide(deco: PointDecoration) {
  return deco.isReplace ? (deco.startSide < 0 ? Side.IncStart : 0) | (deco.endSide > 0 ? Side.IncEnd : 0)
    : (deco.startSide > 0 ? Side.After : Side.Before)
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
