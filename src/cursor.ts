import {EditorView} from "./editorview"
import {LineView} from "./lineview"
import {InlineView, TextView, WidgetView} from "./inlineview"
import {Text as Doc, findColumn, countColumn, isExtendingChar} from "../../doc/src"
import {SelectionRange} from "../../state/src"
import {isEquivalentPosition, clientRectsFor} from "./dom"
import browser from "./browser"

declare global {
  interface Selection { modify(action: string, direction: string, granularity: string): void }
  interface Document { caretPositionFromPoint(x: number, y: number): {offsetNode: Node, offset: number} }
}

// FIXME rename "word" to something more descriptive of what it actually does?
export function movePos(view: EditorView, start: number,
                        direction: "forward" | "backward" | "left" | "right",
                        granularity: "character" | "word" | "line" | "lineboundary" = "character",
                        action: "move" | "extend"): number {
  let sel = view.root.getSelection()!
  let context = LineContext.get(view, start)
  let dir: 1 | -1 = direction == "forward" || direction == "right" ? 1 : -1
  // Can only query native behavior when Selection.modify is
  // supported, the cursor is well inside the rendered viewport, and
  // we're not doing by-line motion on Gecko (which will mess up goal
  // column motion)
  if (sel.modify && context && !context.nearViewportEnd(view) && view.hasFocus() &&
      granularity != "word" &&
      !(granularity == "line" && (browser.gecko || view.state.selection.ranges.length > 1))) {
    return view.docView.observer.ignore(() => {
      let prepared = context!.prepareForQuery(view, start)
      let startDOM = view.docView.domFromPos(start)!
      let equiv = (!browser.chrome || prepared.lines.length == 0) &&
        isEquivalentPosition(startDOM.node, startDOM.offset, sel.focusNode, sel.focusOffset) && false
      // Firefox skips an extra character ahead when extending across
      // an uneditable element (but not when moving)
      if (prepared.atWidget && browser.gecko && action == "extend") action = "move"
      if (action == "move" && !(equiv && sel.isCollapsed)) sel.collapse(startDOM.node, startDOM.offset)
      else if (action == "extend" && !equiv) sel.extend(startDOM.node, startDOM.offset)
      sel.modify(action, direction, granularity)
      view.docView.setSelectionDirty()
      let result = view.docView.posFromDOM(sel.focusNode, sel.focusOffset)
      context!.undoQueryPreparation(view, prepared)
      return result
    })
  } else if (granularity == "character") {
    return moveCharacterSimple(start, dir, context, view.state.doc)
  } else if (granularity == "lineboundary") {
    if (context) return context.start + (dir < 0 ? 0 : context.line.length)
    let line = view.state.doc.lineAt(start)
    return dir < 0 ? line.start : line.end
  } else if (granularity == "line") {
    if (context && !context.nearViewportEnd(view, dir)) {
      let startCoords = view.docView.coordsAt(start)!
      let goal = getGoalColumn(view, start, startCoords.left)
      for (let startY = dir < 0 ? startCoords.top : startCoords.bottom, dist = 5; dist < 50; dist += 10) {
        let pos = posAtCoords(view, {x: goal.column, y: startY + dist * dir}, dir)
        if (pos < 0) break
        if (pos != start) {
          goal.pos = pos
          return pos
        }
      }
    }
    // Can't do a precise one based on DOM positions, fall back to per-column
    return moveLineByColumn(view.state.doc, view.state.tabSize, start, dir)
  } else if (granularity == "word") {
    return moveWord(view, start, direction)
  } else {
    throw new RangeError("Invalid move granularity: " + granularity)
  }
}

function moveLineByColumn(doc: Doc, tabSize: number, pos: number, dir: -1 | 1): number {
  let line = doc.lineAt(pos)
  // FIXME also needs goal column?
  let col = 0
  for (const iter = doc.iterRange(line.start, pos); !iter.next().done;)
    col = countColumn(iter.value, col, tabSize)
  if (dir < 0 && line.start == 0) return 0
  else if (dir > 0 && line.end == doc.length) return line.end
  let otherLine = doc.line(line.number + dir)
  let result = otherLine.start
  let seen = 0
  for (const iter = doc.iterRange(otherLine.start, otherLine.end); seen >= col && !iter.next().done;) {
    const {offset, leftOver} = findColumn(iter.value, seen, col, tabSize)
    seen = col - leftOver
    result += offset
  }
  return result
}

function moveCharacterSimple(start: number, dir: 1 | -1, context: LineContext | null, doc: Doc): number {
  if (context == null) {
    for (let pos = start;; pos += dir) {
      if (pos == 0 || pos == doc.length) return pos
      if (!isExtendingChar((dir < 0 ? doc.slice(pos - 1, pos) : doc.slice(pos, pos + 1)))) {
        if (dir < 0) return pos - 1
        else if (pos != start) return pos
      }
    }
  }
  for (let {i, off} = context.line.childPos(start - context.start), {children} = context.line, pos = start;;) {
    if (off == (dir < 0 || i == children.length ? 0 : children[i].length)) {
      i += dir
      if (i < 0 || i >= children.length) // End/start of line
        return Math.max(0, Math.min(doc.length, pos + (start == pos ? dir : 0)))
      off = dir < 0 ? children[i].length : 0
    }
    let inline = children[i]
    if (inline instanceof TextView) {
      if (!isExtendingChar(inline.text.charAt(off - (dir < 0 ? 1 : 0)))) {
        if (dir < 0) return pos - 1
        else if (pos != start) return pos
      }
      off += dir; pos += dir
    } else if (inline.length > 0) {
      return pos - off + (dir < 0 ? 0 : inline.length)
    }
  }
}

function moveWord(view: EditorView, start: number, direction: "forward" | "backward" | "left" | "right") {
  let {doc} = view.state
  for (let pos = start, i = 0;; i++) {
    let next = movePos(view, pos, direction, "character", "move")
    if (next == pos) return pos // End of document
    if (doc.sliceLines(Math.min(next, pos), Math.max(next, pos)).length > 1) return next // Crossed a line boundary
    let group = SelectionRange.groupAt(view.state, next, next > pos ? -1 : 1)
    let away = pos < group.from && pos > group.to
    // If the group is away from its start position, we jumped over a
    // bidi boundary, and should take the side closest (in index
    // coordinates) to the start position
    let start = away ? pos < group.head : group.from == pos ? false : group.to == pos ? true : next < pos
    pos = start ? group.from : group.to
    if (i > 0 || /\S/.test(doc.slice(group.from, group.to))) return pos
    next = Math.max(0, Math.min(doc.length, pos + (start ? -1 : 1)))
  }
}

function getGoalColumn(view: EditorView, pos: number, column: number): {pos: number, column: number} {
  for (let goal of view.inputState.goalColumns)
    if (goal.pos == pos) return goal
  let goal = {pos: 0, column}
  view.inputState.goalColumns.push(goal)
  return goal
}

export class LineContext {
  constructor(public line: LineView, public start: number, public index: number) {}

  static get(view: EditorView, pos: number): LineContext | null {
    for (let i = 0, off = 0;; i++) {
      let line = view.docView.children[i], end = off + line.length
      if (end >= pos)
        return line instanceof LineView ? new LineContext(line, off, i) : null
      off = end + 1
    }
  }


  nearViewportEnd(view: EditorView, side: number = 0): boolean {
    for (let {from, to} of view.docView.viewports)
      if (from > 0 && from == this.start && side <= 0 ||
          to < view.state.doc.length && to == this.start + this.line.length && side >= 0)
        return true
    return false
  }

  // FIXME limit the amount of work in character motion in non-bidi
  // context? or not worth it?
  prepareForQuery(view: EditorView, pos: number) {
    let linesToSync: LineView[] = [], atWidget = false
    function maybeHide(view: InlineView) {
      if (!(view instanceof TextView)) atWidget = true
      if (view.length > 0) return false
      ;(view.dom as any).remove()
      if (linesToSync.indexOf(view.parent as LineView) < 0) linesToSync.push(view.parent as LineView)
      return true
    }
    let {i, off} = this.line.childPos(pos - this.start)
    if (off == 0) {
      for (let j = i; j < this.line.children.length; j++) if (!maybeHide(this.line.children[j])) break
      for (let j = i; j > 0; j--) if (!maybeHide(this.line.children[j - 1])) break
    }
    function addForLine(line: LineView, omit: number = -1) {
      if (line.children.length == 0) return
      for (let i = 0, off = 0; i <= line.children.length; i++) {
        let next = i == line.children.length ? null : line.children[i]
        if ((!next || !(next instanceof TextView)) && off != omit &&
            (i == 0 || !(line.children[i - 1] instanceof TextView))) {
          line.dom!.insertBefore(document.createTextNode("\u200b"), next ? next.dom : null)
          if (linesToSync.indexOf(line) < 0) linesToSync.push(line)
        }
        if (next) off += next.length
      }
    }
    if (this.index > 0)
      addForLine(this.line.parent!.children[this.index - 1] as LineView)
    addForLine(this.line, pos - this.start)
    if (this.index < this.line.parent!.children.length - 1)
      addForLine(this.line.parent!.children[this.index + 1] as LineView)
    return {lines: linesToSync, atWidget}
  }

  undoQueryPreparation(view: EditorView, toSync: {lines: LineView[]}) {
    for (let line of toSync.lines) line.syncDOMChildren()
  }
}


// Search the DOM for the {node, offset} position closest to the given
// coordinates. Very inefficient and crude, but can usually be avoided
// by calling caret(Position|Range)FromPoint instead.

// FIXME holding arrow-up/down at the end of the viewport is a rather
// common use case that will repeatedly trigger this code. Maybe
// introduce some element of binary search after all?

function domPosAtCoords(parent: HTMLElement, x: number, y: number): {node: Node, offset: number} {
  let closest, dxClosest = 2e8, xClosest!: number, offset = 0
  let rowBot = y, rowTop = y
  for (let child: Node | null = parent.firstChild, childIndex = 0; child; child = child.nextSibling, childIndex++) {
    let rects = clientRectsFor(child)
    for (let i = 0; i < rects.length; i++) {
      let rect = rects[i]
      if (rect.top <= rowBot && rect.bottom >= rowTop) {
        rowBot = Math.max(rect.bottom, rowBot)
        rowTop = Math.min(rect.top, rowTop)
        let dx = rect.left > x ? rect.left - x
            : rect.right < x ? x - rect.right : 0
        if (dx < dxClosest) {
          closest = child
          dxClosest = dx
          xClosest = dx == 0 ? x : rect.left > x ? rect.left : rect.right
          if (child.nodeType == 1)
            offset = childIndex + (x >= (rect.left + rect.right) / 2 ? 1 : 0)
          continue
        }
      }
      if (!closest && (x >= rect.right && y >= rect.top ||
                       x >= rect.left && y >= rect.bottom))
        offset = childIndex + 1
    }
  }
  if (closest && closest.nodeType == 3)
    return domPosInText(closest as Text, xClosest, y)
  if (!closest || (closest as HTMLElement).contentEditable == "false" || (dxClosest && closest.nodeType == 1))
    return {node: parent, offset}
  return domPosAtCoords(closest as HTMLElement, xClosest, y)
}

function domPosInText(node: Text, x: number, y: number): {node: Node, offset: number} {
  let len = node.nodeValue!.length, range = document.createRange()
  for (let i = 0; i < len; i++) {
    range.setEnd(node, i + 1)
    range.setStart(node, i)
    let rects = range.getClientRects()
    for (let j = 0; j < rects.length; j++) {
      let rect = rects[j]
      if (rect.top == rect.bottom) continue
      if (rect.left - 1 <= x && rect.right + 1 >= x &&
          rect.top - 1 <= y && rect.bottom + 1 >= y) {
        let right = x >= (rect.left + rect.right) / 2, after = right
        if (browser.chrome || browser.gecko) {
          // Check for RTL on browsers that support getting client
          // rects for empty ranges.
          range.setEnd(node, i)
          let rectBefore = range.getBoundingClientRect()
          if (rectBefore.left == rect.right) after = !right
        }
        return {node, offset: i + (after ? 1 : 0)}
      }
    }
  }
  return {node, offset: 0}
}

export function posAtCoords(view: EditorView, {x, y}: {x: number, y: number}, bias: -1 | 1 = -1): number {
  let content = view.contentDOM.getBoundingClientRect(), heightLine
  for (;;) {
    heightLine = view.lineAtHeight(y - content.top)
    if (heightLine.textTop > 0) {
      if (bias > 0) y += heightLine.textTop + 1
      else if (heightLine.start > 0) { y += heightLine.top - 1; continue }
    } else if (heightLine.textBottom < 0) {
      if (bias < 0) y += heightLine.textBottom - 1
      else if (heightLine.end < view.state.doc.length) { y += heightLine.bottom + 1; continue }
    }
    break
  }
  let lineStart = heightLine.start
  // If this is outside of the rendered viewport, we can't determine a position
  if (lineStart < view.viewport.from)
    return view.viewport.from == 0 ? 0 : -1
  if (lineStart > view.viewport.to)
    return view.viewport.to == view.state.doc.length ? view.state.doc.length : -1
  // Clip x to the viewport sides
  x = Math.max(content.left + 1, Math.min(content.right - 1, x))
  let root = view.root, element = root.elementFromPoint(x, y)

  // There's visible editor content under the point, so we can try
  // using caret(Position|Range)FromPoint as a shortcut
  let node: Node | undefined, offset: number = -1
  if (element && view.contentDOM.contains(element) && !(view.docView.nearest(element) instanceof WidgetView)) {
    if (root.caretPositionFromPoint) {
      let pos = root.caretPositionFromPoint(x, y)
      if (pos) ({offsetNode: node, offset} = pos)
    } else if (root.caretRangeFromPoint) {
      let range = root.caretRangeFromPoint(x, y)
      if (range) ({startContainer: node, startOffset: offset} = range)
    }
  }

  // No luck, do our own (potentially expensive) search
  if (!node) {
    let {line} = LineContext.get(view, lineStart)!
    ;({node, offset} = domPosAtCoords(line.dom!, x, y))
  }
  return view.docView.posFromDOM(node, offset)
}
