import {EditorView} from "./editorview"
import {ContentView} from "./contentview"
import browser from "./browser"

export class DOMReader {
  text: string = ""
  private lineBreak: string

  constructor(private points: DOMPoint[], private view: EditorView) {
    this.lineBreak = view.state.lineBreak
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
        this.text += this.lineBreak
      cur = next!
    }
    this.findPointBefore(parent, end)
    return this
  }

  readTextNode(node: Text) {
    let text = node.nodeValue!
    if (/^\u200b/.test(text) && (node.previousSibling as HTMLElement | null)?.contentEditable == "false")
      text = text.slice(1)
    if (/\u200b$/.test(text) && (node.nextSibling as HTMLElement | null)?.contentEditable == "false")
      text = text.slice(0, text.length - 1)
    return text
  }

  readNode(node: Node) {
    if ((node as any).cmIgnore) return
    let view = ContentView.get(node)
    let fromView = view && view.overrideDOMText
    let text: string | undefined
    if (fromView != null) text = fromView.sliceString(0, undefined, this.lineBreak)
    else if (node.nodeType == 3) text = this.readTextNode(node as Text)
    else if (node.nodeName == "BR") text = node.nextSibling ? this.lineBreak : ""
    else if (node.nodeType == 1) this.readRange(node.firstChild, null)

    if (text != null) {
      this.findPointIn(node, text.length)
      this.text += text
      // Chrome inserts two newlines when pressing shift-enter at the
      // end of a line. This drops one of those.
      if (browser.chrome && this.view.inputState.lastKeyCode == 13 && !node.nextSibling && /\n\n$/.test(this.text))
        this.text = this.text.slice(0, -1)
    }
  }

  findPointBefore(node: Node, next: Node | null) {
    for (let point of this.points)
      if (point.node == node && node.childNodes[point.offset] == next)
        point.pos = this.text.length
  }

  findPointIn(node: Node, maxLen: number) {
    for (let point of this.points)
      if (point.node == node)
        point.pos = this.text.length + Math.min(point.offset, maxLen)
  }
}

function isBlockElement(node: Node): boolean {
  return node.nodeType == 1 && /^(DIV|P|LI|UL|OL|BLOCKQUOTE|DD|DT|H\d|SECTION|PRE)$/.test(node.nodeName)
}

export class DOMPoint {
  pos: number = -1
  constructor(readonly node: Node, readonly offset: number) {}
}
