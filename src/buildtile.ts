import {Tile, CompositeTile, DocTile, LineTile, MarkTile, BlockWrapperTile, Side,
        WidgetTile, WidgetBufferTile, TextTile, TileFlag, TilePointer} from "./tile"
import {ChangedRange} from "./extension"
import {Attrs, getAttrs, combineAttrs} from "./attributes"
import {DecorationSet, MarkDecoration, PointDecoration, LineDecoration, WidgetType} from "./decoration"
import {RangeSet, TextIterator, Text as DocText} from "@codemirror/state"
import {EditorView} from "./editorview"
import {Composition} from "./docview"
import browser from "./browser"

// FIXME investigate vertical motion bug (type on long line, arrow down skips multiple short lines)
// FIXME comments
// FIXME see which assertions I want to keep in the code

const LOG_builder = true

export const enum Reused { Full = 1, DOM = 2 }

const enum T { Chunk = 512 }

class TileBuilder {
  curLine: LineTile | null = null
  lastBlock: LineTile | WidgetTile | null = null
  afterWidget: WidgetTile | null = null
  pos = 0

  constructor(readonly root: DocTile) {}

  addText(text: string, marks: MarkDecoration[], openStart: number, old?: TextTile | null) {
    this.flushBuffer()
    let parent = this.ensureMarks(marks, openStart)
    let prev = parent.lastChild
    if (prev && prev.isText() && !(prev.flags & TileFlag.Composition)) {
      // FIXME this.reused.set(last, Reused.DOM)
      let tile = parent.children[parent.children.length - 1] = new TextTile(prev.dom, prev.text + text)
      tile.parent = parent
    } else {
      parent.append(TextTile.of(text))
    }
    this.pos += text.length
    this.afterWidget = null
  }

  // FIXME implement addCompositionText

  addInlineWidget(widget: WidgetTile, marks: MarkDecoration[], openStart: number) {
    // Adjacent same-side-facing non-replacing widgets don't need buffers between them
    let noSpace = this.afterWidget && (widget.side & (Side.Before | Side.After)) && this.afterWidget.side == widget.side
    if (!noSpace) this.flushBuffer()
    let parent = this.ensureMarks(marks, openStart)
    if (!noSpace && !(widget.side & Side.Before)) parent.append(new WidgetBufferTile(1))
    parent.append(widget)
    this.pos += widget.length
    this.afterWidget = widget
  }

  addBlockWidget(widget: WidgetTile) {
    this.getBlockPos().append(widget)
    this.pos += widget.length
    this.lastBlock = widget
    this.endLine()
  }

  continueWidget(length: number) {
    let widget = this.afterWidget || this.lastBlock
    if (!widget?.isWidget()) throw new Error("No widget to continue")
    widget.length += length
    this.pos += length
  }

  addLineStart(attrs: Attrs | null, dom?: HTMLElement) {
    this.getBlockPos().append(this.lastBlock = this.curLine = LineTile.start(attrs || lineBaseAttrs, dom))
  }

  addLine(tile: LineTile) {
    this.getBlockPos().append(tile)
    this.pos += tile.length
    this.lastBlock = tile
    this.endLine()
  }

  addBreak() {
    let target = this.root.lastChild
    while (target && target instanceof BlockWrapperTile) target = target.lastChild
    if (!target) throw new Error("No block to add break to")
    target.flags |= TileFlag.BreakAfter
    this.endLine()
    this.pos++
  }

  addLineStartIfNotCovered(attrs: Attrs | null) {
    if (!this.blockPosCovered()) this.addLineStart(attrs)
  }

  ensureLine(attrs: Attrs | null) {
    if (!this.curLine) this.addLineStart(attrs)
  }

  ensureMarks(marks: MarkDecoration[], openStart: number) {
    let parent: CompositeTile | null = this.curLine
    if (!parent) throw new Error("Not in a line")
    for (let i = marks.length - 1; i >= 0; i--) {
      let mark = marks[i], last
      if (openStart > 0 && (last = parent.lastChild) && last instanceof MarkTile && last.mark.eq(mark)) {
        parent = last
        openStart--
      } else {
        let tile = MarkTile.of(mark) // FIXME reuse
        parent.append(tile)
        parent = tile
        openStart = 0
      }
    }
    return parent
  }

  endLine() {
    if (this.curLine) {
      this.flushBuffer()
      let last = this.curLine.lastChild
      if (!last || !hasContent(this.curLine, false) ||
          last.dom.nodeName != "BR" && last.isWidget() && !(browser.ios && hasContent(this.curLine, true)))
        this.curLine.append(new WidgetTile(BreakWidget.toDOM(), 0, BreakWidget, Side.After))
      this.curLine = this.afterWidget = null
    }
  }

  getBlockPos() {
    // FIXME sync block wrappers
    return this.root
  }

  blockPosCovered() {
    let last = this.lastBlock
    return last != null && !last.breakAfter && (!last.isWidget() || (last.side & (Side.After | Side.IncEnd)) > 0)
  }

  flushBuffer() {
    if (this.afterWidget && !(this.afterWidget.side & Side.After)) {
      this.afterWidget.parent!.append(new WidgetBufferTile(-1)) // FIXME reuse
      this.afterWidget = null
    }
  }
}

class TextStream {
  cursor: TextIterator
  skipCount = 0
  text = ""
  textOff = 0

  constructor(doc: DocText) {
    this.cursor = doc.iter()
  }

  skip(len: number) {
    // Advance the iterator past the replaced content
    if (this.textOff + len <= this.text.length) {
      this.textOff += len
    } else {
      this.skipCount += len - (this.text.length - this.textOff)
      this.text = ""
      this.textOff = 0
    }
  }

  next(maxLen: number): null | string { // Null indicates a line break
    if (this.textOff == this.text.length) {
      let {value, lineBreak, done} = this.cursor.next(this.skipCount)
      this.skipCount = 0
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

export class TileUpdate {
  reused: Map<Tile, Reused> = new Map
  text: TextStream
  builder: TileBuilder
  old: TilePointer
  openWidget = false
  openMarks = 0

  constructor(
    readonly view: EditorView,
    old: DocTile,
    readonly decorations: readonly DecorationSet[],
    readonly disallowBlockEffectsFor: boolean[]
  ) {
    this.text = new TextStream(view.state.doc)
    this.builder = new TileBuilder(new DocTile(view, view.contentDOM))
    this.reused.set(old, Reused.DOM)
    this.old = new TilePointer(old)
  }

  run(changes: readonly ChangedRange[], composition: Composition | null) {
    LOG_builder && console.log("Build with changes", JSON.stringify(changes))
    LOG_builder && composition && console.log("Composition", JSON.stringify(composition.range), composition.text.nodeValue)
    LOG_builder && console.log("<<< " + this.old.tile)
    let compositionContext = composition && this.getCompositionContext(composition.text)

    for (let posA = 0, posB = 0, i = 0;;) {
      let next = i < changes.length ? changes[i++] : null
      let skipA = next ? next.fromA : this.old.root.length
      if (skipA > posA) {
        LOG_builder && console.log("Preserve", posA, "to", skipA)
        let len = skipA - posA
        this.preserve(len, !i, !next)
        posA = skipA
        posB += len
      }
      if (!next) break
      if (composition && next.fromA <= composition.range.fromA && next.toA >= composition.range.toA) {
        LOG_builder && console.log("Composition", posB, "to", next.toB, "over", posA, "to", next.toA)
        this.emit(posB, composition.range.fromB, composition.range.fromA - posA)
        this.composition(composition, compositionContext!)
        this.emit(composition.range.toB, next.toB, next.toA - composition.range.toA)
      } else {
        LOG_builder && console.log("Emit", posB, "to", next.toB, "over", posA, "to", next.toA)
        this.emit(posB, next.toB, next.toA - posA)
      }
      posB = next.toB
      posA = next.toA
    }
    LOG_builder && console.log(">>> " + this.builder.root)
    if (this.builder.curLine) this.builder.endLine()
    return this.builder.root
  }

  preserve(length: number, incStart: boolean, incEnd: boolean) {
    let activeMarks = getMarks(this.old), openMarks = this.openMarks

    this.old.advance(length, incEnd ? 1 : -1, {
      skip: (tile, from, to) => {
        if (tile.isWidget()) {
          if (this.openWidget) {
            this.builder.continueWidget(to - from)
          } else {
            let widget = to > 0 || from < tile.length
              ? WidgetTile.of(tile.widget, this.view, to - from, tile.side, this.maybeReuse(tile))
              : tile
            if (widget.side & Side.Block) {
              widget.flags &= ~TileFlag.BreakAfter
              this.builder.addBlockWidget(widget)
            } else {
              this.builder.addInlineWidget(widget, activeMarks, openMarks)
              openMarks = activeMarks.length
            }
          }
        } else if (tile.isText()) {
          this.builder.addText(tile.text.slice(from, to), activeMarks, openMarks, this.reused.has(tile) ? null : tile)
          openMarks = activeMarks.length
        } else if (tile.isLine()) {
          tile.flags &= ~TileFlag.BreakAfter
          this.builder.addLine(tile)
        }
        this.openWidget = false
      },
      enter: (tile) => {
        if (tile.isLine()) {
          this.builder.addLineStart(tile.attrs, this.maybeReuse(tile))
        } else if (tile instanceof MarkTile) {
          activeMarks.push(tile.mark) // FIXME reuse DOM
        }
        this.openWidget = false
      },
      leave: (tile) => {
        if (tile.isLine()) {
          if (activeMarks.length) activeMarks.length = openMarks = 0
        } else if (tile instanceof MarkTile) {
          activeMarks.pop()
          openMarks = Math.min(openMarks, activeMarks.length)
        }
      },
      break: () => {
        this.builder.addBreak()
        this.openWidget = false
      },
    })
    this.text.skip(length)
  }

  emit(from: number, to: number, lenA: number) {
    let pendingLineAttrs: Attrs | null = null
    let b = this.builder, markCount = 0

    let openEnd = RangeSet.spans(this.decorations, from, to, {
      point: (from, to, deco, active: MarkDecoration[], openStart, index) => {
        if (deco instanceof PointDecoration) {
          if (this.disallowBlockEffectsFor[index]) {
            if (deco.block)
              throw new RangeError("Block decorations may not be specified via plugins")
            if (to > this.view.state.doc.lineAt(from).to)
              throw new RangeError("Decorations that replace line breaks may not be specified via plugins")
          }
          markCount = active.length
          if (openStart > active.length) {
            b.continueWidget(to - from)
          } else {
            let tile = WidgetTile.of(deco.widget || (deco.block ? NullWidget.block : NullWidget.inline),
                                     this.view, to - from, widgetSide(deco))
            if (deco.block) {
              if (deco.startSide > 0) b.addLineStartIfNotCovered(pendingLineAttrs)
              b.addBlockWidget(tile)  // FIXME reuse
            } else {
              b.ensureLine(pendingLineAttrs)
              b.addInlineWidget(tile, active, openStart)
            }
          }
          pendingLineAttrs = null
        } else {
          pendingLineAttrs = addLineDeco(pendingLineAttrs, deco)
        }

        if (to > from) this.text.skip(to - from)
      },
      span: (from, to, active: MarkDecoration[], openStart) => {
        for (let pos = from; pos < to;) {
          let chars = this.text.next(Math.min(T.Chunk, to - pos))
          if (chars == null) { // Line break
            b.addLineStartIfNotCovered(pendingLineAttrs)
            b.addBreak()
            pos++
          } else {
            b.ensureLine(pendingLineAttrs)
            b.addText(chars, active, openStart) // FIXME reuse
            pos += chars.length
          }
          pendingLineAttrs = null
        }
      }
    })
    b.addLineStartIfNotCovered(pendingLineAttrs)
    this.old.advance(lenA, 1)
    this.openWidget = openEnd > markCount
    this.openMarks = openEnd
  }

  composition(composition: Composition, context: {marks: MarkTile[], line: LineTile}) {
    /* FIXME
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
    */
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
        line = new LineTile(parent, lineBaseAttrs)
      else
        marks.push(MarkTile.of(new MarkDecoration({tagName: parent.nodeName.toLowerCase(), attributes: getAttrs(parent)}), parent))
    }
    if (!line) throw new Error("not in a line")
    return {line, marks}
  }

  maybeReuse<T extends Tile>(tile: T): T["dom"] | undefined {
    if (this.reused.has(tile)) return undefined
    this.reused.set(tile, Reused.DOM)
    return tile.dom
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
  let flags = deco.isReplace ? (deco.startSide < 0 ? Side.IncStart : 0) | (deco.endSide > 0 ? Side.IncEnd : 0)
    : (deco.startSide > 0 ? Side.After : Side.Before)
  if (deco.block) flags |= Side.Block
  return flags
}

const lineBaseAttrs: Attrs = {class: "cm-line"}

function addLineDeco(value: Attrs | null, deco: LineDecoration) {
  let attrs = deco.spec.attributes, cls = deco.spec.class
  if (!attrs && !cls) return value
  if (!value) value = {class: "cm-line"}
  if (attrs) combineAttrs(attrs, value)
  if (cls) value.class += " " + cls
  return value
}

function getMarks(ptr: TilePointer) {
  let found: MarkDecoration[] = []
  for (let i = ptr.parents.length;; i--) {
    let tile = i == ptr.parents.length ? ptr.tile : ptr.parents[i].tile
    if (tile instanceof MarkTile) found.unshift(tile.mark)
    else if (!tile.isText()) return found
  }
}

class NullWidget extends WidgetType {
  constructor(readonly tag: string) { super() }
  eq(other: NullWidget) { return other.tag == this.tag }
  toDOM() { return document.createElement(this.tag) }
  updateDOM(elt: HTMLElement) { return elt.nodeName.toLowerCase() == this.tag }
  get isHidden() { return true }
  static inline = new NullWidget("span")
  static block = new NullWidget("div")
}

const BreakWidget = new class extends WidgetType {
  toDOM() { return document.createElement("br") }
  get isHidden() { return true }
  get editable() { return true }
}
