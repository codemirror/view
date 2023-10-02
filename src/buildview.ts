import {SpanIterator, RangeSet, Text, TextIterator} from "@codemirror/state"
import {DecorationSet, Decoration, PointDecoration, LineDecoration, MarkDecoration, WidgetType} from "./decoration"
import {ContentView} from "./contentview"
import {BlockView, LineView, BlockWidgetView} from "./blockview"
import {WidgetView, TextView, MarkView, WidgetBufferView} from "./inlineview"

const enum T { Chunk = 512 }

const enum Buf { No = 0, Yes = 1, IfCursor = 2 }

export class ContentBuilder implements SpanIterator<Decoration> {
  content: BlockView[] = []
  curLine: LineView | null = null
  breakAtStart = 0
  pendingBuffer = Buf.No
  bufferMarks: readonly MarkDecoration[] = []
  // Set to false directly after a widget that covers the position after it
  atCursorPos = true
  openStart = -1
  openEnd = -1
  cursor: TextIterator
  text: string = ""
  skip: number
  textOff: number = 0

  constructor(private doc: Text, public pos: number, public end: number, readonly disallowBlockEffectsFor: boolean[]) {
    this.cursor = doc.iter()
    this.skip = pos
  }

  posCovered() {
    if (this.content.length == 0)
      return !this.breakAtStart && this.doc.lineAt(this.pos).from != this.pos
    let last = this.content[this.content.length - 1]
    return !(last.breakAfter || last instanceof BlockWidgetView && last.deco.endSide < 0)
  }

  getLine() {
    if (!this.curLine) {
      this.content.push(this.curLine = new LineView)
      this.atCursorPos = true
    }
    return this.curLine
  }

  flushBuffer(active = this.bufferMarks) {
    if (this.pendingBuffer) {
      this.curLine!.append(wrapMarks(new WidgetBufferView(-1), active), active.length)
      this.pendingBuffer = Buf.No
    }
  }

  addBlockWidget(view: BlockWidgetView) {
    this.flushBuffer()
    this.curLine = null
    this.content.push(view)
  }

  finish(openEnd: number) {
    if (this.pendingBuffer && openEnd <= this.bufferMarks.length) this.flushBuffer()
    else this.pendingBuffer = Buf.No
    if (!this.posCovered() &&
        !(openEnd && this.content.length && this.content[this.content.length - 1] instanceof BlockWidgetView))
      this.getLine()
  }

  buildText(length: number, active: readonly MarkDecoration[], openStart: number) {
    while (length > 0) {
      if (this.textOff == this.text.length) {
        let {value, lineBreak, done} = this.cursor.next(this.skip)
        this.skip = 0
        if (done) throw new Error("Ran out of text content when drawing inline views")
        if (lineBreak) {
          if (!this.posCovered()) this.getLine()
          if (this.content.length) this.content[this.content.length - 1].breakAfter = 1
          else this.breakAtStart = 1
          this.flushBuffer()
          this.curLine = null
          this.atCursorPos = true
          length--
          continue
        } else {
          this.text = value
          this.textOff = 0
        }
      }
      let take = Math.min(this.text.length - this.textOff, length, T.Chunk)
      this.flushBuffer(active.slice(active.length - openStart))
      this.getLine().append(wrapMarks(new TextView(this.text.slice(this.textOff, this.textOff + take)), active), openStart)
      this.atCursorPos = true
      this.textOff += take
      length -= take
      openStart = 0
    }
  }

  span(from: number, to: number, active: MarkDecoration[], openStart: number) {
    this.buildText(to - from, active, openStart)
    this.pos = to
    if (this.openStart < 0) this.openStart = openStart
  }

  point(from: number, to: number, deco: Decoration, active: MarkDecoration[], openStart: number, index: number) {
    if (this.disallowBlockEffectsFor[index] && deco instanceof PointDecoration) {
      if (deco.block)
        throw new RangeError("Block decorations may not be specified via plugins")
      if (to > this.doc.lineAt(this.pos).to)
        throw new RangeError("Decorations that replace line breaks may not be specified via plugins")
    }
    let len = to - from
    if (deco instanceof PointDecoration) {
      if (deco.block) {
        if (deco.startSide > 0 && !this.posCovered()) this.getLine()
        this.addBlockWidget(new BlockWidgetView(deco.widget || new NullWidget("div"), len, deco))
      } else {
        let view = WidgetView.create(deco.widget || new NullWidget("span"), len, len ? 0 : deco.startSide)
        let cursorBefore = this.atCursorPos && !view.isEditable && openStart <= active.length &&
          (from < to || deco.startSide > 0)
        let cursorAfter = !view.isEditable && (from < to || openStart > active.length || deco.startSide <= 0)
        let line = this.getLine()
        if (this.pendingBuffer == Buf.IfCursor && !cursorBefore && !view.isEditable) this.pendingBuffer = Buf.No
        this.flushBuffer(active)
        if (cursorBefore) {
          line.append(wrapMarks(new WidgetBufferView(1), active), openStart)
          openStart = active.length + Math.max(0, openStart - active.length)
        }
        line.append(wrapMarks(view, active), openStart)
        this.atCursorPos = cursorAfter
        this.pendingBuffer = !cursorAfter ? Buf.No : from < to || openStart > active.length ? Buf.Yes : Buf.IfCursor
        if (this.pendingBuffer) this.bufferMarks = active.slice()
      }
    } else if (this.doc.lineAt(this.pos).from == this.pos) { // Line decoration
      this.getLine().addLineDeco(deco as LineDecoration)
    }

    if (len) {
      // Advance the iterator past the replaced content
      if (this.textOff + len <= this.text.length) {
        this.textOff += len
      } else {
        this.skip += len - (this.text.length - this.textOff)
        this.text = ""
        this.textOff = 0
      }
      this.pos = to
    }
    if (this.openStart < 0) this.openStart = openStart
  }

  static build(text: Text, from: number, to: number, decorations: readonly DecorationSet[], dynamicDecorationMap: boolean[]):
    {content: BlockView[], breakAtStart: number, openStart: number, openEnd: number} {
    let builder = new ContentBuilder(text, from, to, dynamicDecorationMap)
    builder.openEnd = RangeSet.spans(decorations, from, to, builder)
    if (builder.openStart < 0) builder.openStart = builder.openEnd
    builder.finish(builder.openEnd)
    return builder
  }
}

function wrapMarks(view: ContentView, active: readonly MarkDecoration[]) {
  for (let mark of active) view = new MarkView(mark, [view], view.length)
  return view
}

class NullWidget extends WidgetType {
  constructor(readonly tag: string) { super() }
  eq(other: NullWidget) { return other.tag == this.tag }
  toDOM() { return document.createElement(this.tag) }
  updateDOM(elt: HTMLElement) { return elt.nodeName.toLowerCase() == this.tag }
  get isHidden() { return true }
}
