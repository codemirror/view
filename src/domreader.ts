import {ContentView} from "./contentview"
import {EditorState} from "@codemirror/state"

export const LineBreakPlaceholder = "\uffff"

export class DOMReader {
  text: string = ""
  lineSeparator: string | undefined

  constructor(private points: DOMPoint[], state: EditorState) {
    this.lineSeparator = state.facet(EditorState.lineSeparator)
  }

  append(text: string) {
    this.text += text
  }

  lineBreak() {
    this.text += LineBreakPlaceholder
  }

  readRange(start: Node | null, end: Node | null) {
    if (!start) return this
    let parent = start.parentNode!
    for (let cur = start;;) {
      this.findPointBefore(parent, cur)
      this.readNode(cur)
      let next: Node | null = cur.nextSibling
      if (next == end) break
      let view = ContentView.get(cur), nextView = ContentView.get(next!)
      if (view && nextView ? view.breakAfter :
          (view ? view.breakAfter : isBlockElement(cur)) ||
          (isBlockElement(next!) && (cur.nodeName != "BR" || (cur as any).cmIgnore)))
        this.lineBreak()
      cur = next!
    }
    this.findPointBefore(parent, end)
    return this
  }

  readTextNode(node: Text) {
    let text = node.nodeValue!
    for (let point of this.points)
      if (point.node == node)
        point.pos = this.text.length + Math.min(point.offset, text.length)

    for (let off = 0, re = this.lineSeparator ? null : /\r\n?|\n/g;;) {
      let nextBreak = -1, breakSize = 1, m
      if (this.lineSeparator) {
        nextBreak = text.indexOf(this.lineSeparator, off)
        breakSize = this.lineSeparator.length
      } else if (m = re!.exec(text)) {
        nextBreak = m.index
        breakSize = m[0].length
      }
      this.append(text.slice(off, nextBreak < 0 ? text.length : nextBreak))
      if (nextBreak < 0) break
      this.lineBreak()
      if (breakSize > 1) for (let point of this.points)
        if (point.node == node && point.pos > this.text.length) point.pos -= breakSize - 1
      off = nextBreak + breakSize
    }
  }

  readNode(node: Node) {
    if ((node as any).cmIgnore) return
    let view = ContentView.get(node)
    let fromView = view && view.overrideDOMText
    if (fromView != null) {
      this.findPointInside(node, fromView.length)
      for (let i = fromView.iter(); !i.next().done;) {
        if (i.lineBreak) this.lineBreak()
        else this.append(i.value)
      }
    } else if (node.nodeType == 3) {
      this.readTextNode(node as Text)
    } else if (node.nodeName == "BR") {
      if (node.nextSibling) this.lineBreak()
    } else if (node.nodeType == 1) {
      this.readRange(node.firstChild, null)
    }
  }

  findPointBefore(node: Node, next: Node | null) {
    for (let point of this.points)
      if (point.node == node && node.childNodes[point.offset] == next)
        point.pos = this.text.length
  }

  findPointInside(node: Node, maxLen: number) {
    for (let point of this.points)
      if (node.nodeType == 3 ? point.node == node : node.contains(point.node))
        point.pos = this.text.length + Math.min(maxLen, point.offset)
  }
}

function isBlockElement(node: Node): boolean {
  return node.nodeType == 1 && /^(DIV|P|LI|UL|OL|BLOCKQUOTE|DD|DT|H\d|SECTION|PRE)$/.test(node.nodeName)
}

export class DOMPoint {
  pos: number = -1
  constructor(readonly node: Node, readonly offset: number) {}
}
