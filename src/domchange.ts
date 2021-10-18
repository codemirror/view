import {EditorView} from "./editorview"
import {ContentView} from "./contentview"
import {inputHandler, editable} from "./extension"
import {contains, dispatchKey} from "./dom"
import browser from "./browser"
import {EditorSelection, Text} from "@codemirror/state"

export function applyDOMChange(view: EditorView, start: number, end: number, typeOver: boolean) {
  let change: undefined | {from: number, to: number, insert: Text}, newSel
  let sel = view.state.selection.main, bounds
  if (start > -1 && !view.state.readOnly && (bounds = view.docView.domBoundsAround(start, end, 0))) {
    let {from, to} = bounds
    let selPoints = view.docView.impreciseHead || view.docView.impreciseAnchor ? [] : selectionPoints(view)
    let reader = new DOMReader(selPoints, view)
    reader.readRange(bounds.startDOM, bounds.endDOM)
    newSel = selectionFromPoints(selPoints, from)

    let preferredPos = sel.from, preferredSide = null
    // Prefer anchoring to end when Backspace is pressed (or, on
    // Android, when something was deleted)
    if (view.inputState.lastKeyCode === 8 && view.inputState.lastKeyTime > Date.now() - 100 ||
        browser.android && reader.text.length < to - from) {
      preferredPos = sel.to
      preferredSide = "end"
    }
    let diff = findDiff(view.state.sliceDoc(from, to), reader.text,
                        preferredPos - from, preferredSide)
    if (diff) change = {from: from + diff.from, to: from + diff.toA,
                        insert: view.state.toText(reader.text.slice(diff.from, diff.toB))}
  } else if (view.hasFocus || !view.state.facet(editable)) {
    let domSel = view.observer.selectionRange
    let {impreciseHead: iHead, impreciseAnchor: iAnchor} = view.docView
    let head = iHead && iHead.node == domSel.focusNode && iHead.offset == domSel.focusOffset ||
      !contains(view.contentDOM, domSel.focusNode)
      ? view.state.selection.main.head
      : view.docView.posFromDOM(domSel.focusNode!, domSel.focusOffset)
    let anchor = iAnchor && iAnchor.node == domSel.anchorNode && iAnchor.offset == domSel.anchorOffset ||
      !contains(view.contentDOM, domSel.anchorNode)
      ? view.state.selection.main.anchor
      : view.docView.posFromDOM(domSel.anchorNode!, domSel.anchorOffset)
    if (head != sel.head || anchor != sel.anchor)
      newSel = EditorSelection.single(anchor, head)
  }

  if (!change && !newSel) return

  // Heuristic to notice typing over a selected character
  if (!change && typeOver && !sel.empty && newSel && newSel.main.empty)
    change = {from: sel.from, to: sel.to, insert: view.state.doc.slice(sel.from, sel.to)}
  // If the change is inside the selection and covers most of it,
  // assume it is a selection replace (with identical characters at
  // the start/end not included in the diff)
  else if (change && change.from >= sel.from && change.to <= sel.to &&
           (change.from != sel.from || change.to != sel.to) &&
           (sel.to - sel.from) - (change.to - change.from) <= 4)
    change = {
      from: sel.from, to: sel.to,
      insert: view.state.doc.slice(sel.from, change.from).append(change.insert).append(view.state.doc.slice(change.to, sel.to))
    }

  if (change) {
    let startState = view.state
    // Android browsers don't fire reasonable key events for enter,
    // backspace, or delete. So this detects changes that look like
    // they're caused by those keys, and reinterprets them as key
    // events.
    if (browser.android &&
        ((change.from == sel.from && change.to == sel.to &&
          change.insert.length == 1 && change.insert.lines == 2 &&
          dispatchKey(view.contentDOM, "Enter", 13)) ||
         (change.from == sel.from - 1 && change.to == sel.to && change.insert.length == 0 &&
          dispatchKey(view.contentDOM, "Backspace", 8)) ||
         (change.from == sel.from && change.to == sel.to + 1 && change.insert.length == 0 &&
          dispatchKey(view.contentDOM, "Delete", 46)))) {
      return
    }

    let text = change.insert.toString()
    if (view.state.facet(inputHandler).some(h => h(view, change!.from, change!.to, text)))
      return

    if (view.inputState.composing >= 0) view.inputState.composing++
    let tr
    if (change.from >= sel.from && change.to <= sel.to && change.to - change.from >= (sel.to - sel.from) / 3 &&
        (!newSel || newSel.main.empty && newSel.main.from == change.from + change.insert.length)) {
      let before = sel.from < change.from ? startState.sliceDoc(sel.from, change.from) : ""
      let after = sel.to > change.to ? startState.sliceDoc(change.to, sel.to) : ""
      tr = startState.replaceSelection(view.state.toText(before + change.insert.sliceString(0, undefined, view.state.lineBreak) +
                                                         after))
    } else {
      let changes = startState.changes(change)
      tr = {
        changes,
        selection: newSel && !startState.selection.main.eq(newSel.main) && newSel.main.to <= changes.newLength
          ? startState.selection.replaceRange(newSel.main) : undefined
      }
    }
    let userEvent = "input.type"
    if (view.composing) {
      userEvent += ".compose"
      if (view.inputState.compositionFirstChange) {
        userEvent += ".start"
        view.inputState.compositionFirstChange = false
      }
    }
    view.dispatch(tr, {scrollIntoView: true, userEvent})
  } else if (newSel && !newSel.main.eq(sel)) {
    let scrollIntoView = false, userEvent = "select"
    if (view.inputState.lastSelectionTime > Date.now() - 50) {
      if (view.inputState.lastSelectionOrigin == "select") scrollIntoView = true
      userEvent = view.inputState.lastSelectionOrigin!
    }
    view.dispatch({selection: newSel, scrollIntoView, userEvent})
  }
}

function findDiff(a: string, b: string, preferredPos: number, preferredSide: string | null)
    : {from: number, toA: number, toB: number} | null {
  let minLen = Math.min(a.length, b.length)
  let from = 0
  while (from < minLen && a.charCodeAt(from) == b.charCodeAt(from)) from++
  if (from == minLen && a.length == b.length) return null
  let toA = a.length, toB = b.length
  while (toA > 0 && toB > 0 && a.charCodeAt(toA - 1) == b.charCodeAt(toB - 1)) { toA--; toB-- }

  if (preferredSide == "end") {
    let adjust = Math.max(0, from - Math.min(toA, toB))
    preferredPos -= toA + adjust - from
  }
  if (toA < from && a.length < b.length) {
    let move = preferredPos <= from && preferredPos >= toA ? from - preferredPos : 0
    from -= move
    toB = from + (toB - toA)
    toA = from
  } else if (toB < from) {
    let move = preferredPos <= from && preferredPos >= toB ? from - preferredPos : 0
    from -= move
    toA = from + (toA - toB)
    toB = from
  }
  return {from, toA, toB}
}

class DOMReader {
  text: string = ""
  private lineBreak: string

  constructor(private points: DOMPoint[], private view: EditorView) {
    this.lineBreak = view.state.lineBreak
  }

  readRange(start: Node | null, end: Node | null) {
    if (!start) return
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
  }

  readNode(node: Node) {
    if ((node as any).cmIgnore) return
    let view = ContentView.get(node)
    let fromView = view && view.overrideDOMText
    let text: string | undefined
    if (fromView != null) text = fromView.sliceString(0, undefined, this.lineBreak)
    else if (node.nodeType == 3) text = node.nodeValue!
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

class DOMPoint {
  pos: number = -1
  constructor(readonly node: Node, readonly offset: number) {}
}

function selectionPoints(view: EditorView) {
  let result: DOMPoint[] = []
  if (view.root.activeElement != view.contentDOM) return result
  let {anchorNode, anchorOffset, focusNode, focusOffset} = view.observer.selectionRange
  if (anchorNode) {
    result.push(new DOMPoint(anchorNode, anchorOffset))
    if (focusNode != anchorNode || focusOffset != anchorOffset)
      result.push(new DOMPoint(focusNode!, focusOffset))
  }
  return result
}

function selectionFromPoints(points: DOMPoint[], base: number): EditorSelection | null {
  if (points.length == 0) return null
  let anchor = points[0].pos, head = points.length == 2 ? points[1].pos : anchor
  return anchor > -1 && head > -1 ? EditorSelection.single(anchor + base, head + base) : null
}
