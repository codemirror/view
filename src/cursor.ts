import {EditorState, EditorSelection, SelectionRange, RangeSet,
        CharCategory, findColumn, findClusterBreak} from "@codemirror/state"
import {EditorView} from "./editorview"
import {BlockType} from "./decoration"
import {LineView} from "./blockview"
import {atomicRanges} from "./extension"
import {clientRectsFor, textRange, Rect, maxOffset} from "./dom"
import {moveVisually, movedOver, Direction} from "./bidi"
import {BlockInfo} from "./heightmap"
import browser from "./browser"

declare global {
  interface Selection { modify(action: string, direction: string, granularity: string): void }
  interface Document { caretPositionFromPoint(x: number, y: number): {offsetNode: Node, offset: number} }
}

export function groupAt(state: EditorState, pos: number, bias: 1 | -1 = 1) {
  let categorize = state.charCategorizer(pos)
  let line = state.doc.lineAt(pos), linePos = pos - line.from
  if (line.length == 0) return EditorSelection.cursor(pos)
  if (linePos == 0) bias = 1
  else if (linePos == line.length) bias = -1
  let from = linePos, to = linePos
  if (bias < 0) from = findClusterBreak(line.text, linePos, false)
  else to = findClusterBreak(line.text, linePos)
  let cat = categorize(line.text.slice(from, to))
  while (from > 0) {
    let prev = findClusterBreak(line.text, from, false)
    if (categorize(line.text.slice(prev, from)) != cat) break
    from = prev
  }
  while (to < line.length) {
    let next = findClusterBreak(line.text, to)
    if (categorize(line.text.slice(to, next)) != cat) break
    to = next
  }
  return EditorSelection.range(from + line.from, to + line.from)
}

// Search the DOM for the {node, offset} position closest to the given
// coordinates. Very inefficient and crude, but can usually be avoided
// by calling caret(Position|Range)FromPoint instead.

function getdx(x: number, rect: ClientRect): number {
  return rect.left > x ? rect.left - x : Math.max(0, x - rect.right)
}
function getdy(y: number, rect: ClientRect): number {
  return rect.top > y ? rect.top - y : Math.max(0, y - rect.bottom)
}
function yOverlap(a: ClientRect, b: ClientRect): boolean {
  return a.top < b.bottom - 1 && a.bottom > b.top + 1
}
function upTop(rect: ClientRect, top: number): ClientRect {
  return top < rect.top ? {top, left: rect.left, right: rect.right, bottom: rect.bottom} as ClientRect : rect
}
function upBot(rect: ClientRect, bottom: number): ClientRect {
  return bottom > rect.bottom ? {top: rect.top, left: rect.left, right: rect.right, bottom} as ClientRect : rect
}

function domPosAtCoords(parent: HTMLElement, x: number, y: number): {node: Node, offset: number} {
  let closest, closestRect!: ClientRect, closestX!: number, closestY!: number, closestOverlap = false
  let above, below, aboveRect, belowRect
  for (let child: Node | null = parent.firstChild; child; child = child.nextSibling) {
    let rects = clientRectsFor(child)
    for (let i = 0; i < rects.length; i++) {
      let rect: ClientRect = rects[i]
      if (closestRect && yOverlap(closestRect, rect))
        rect = upTop(upBot(rect, closestRect.bottom), closestRect.top)
      let dx = getdx(x, rect), dy = getdy(y, rect)
      if (dx == 0 && dy == 0)
        return child.nodeType == 3 ? domPosInText(child as Text, x, y) : domPosAtCoords(child as HTMLElement, x, y)
      if (!closest || closestY > dy || closestY == dy && closestX > dx) {
        closest = child; closestRect = rect; closestX = dx; closestY = dy
        closestOverlap = !dx ? true : x < rect.left ? i > 0 : i < rects.length - 1
      }
      if (dx == 0) {
        if (y > rect.bottom && (!aboveRect || aboveRect.bottom < rect.bottom)) { above = child; aboveRect = rect }
        else if (y < rect.top && (!belowRect || belowRect.top > rect.top)) { below = child; belowRect = rect }
      } else if (aboveRect && yOverlap(aboveRect, rect)) {
        aboveRect = upBot(aboveRect, rect.bottom)
      } else if (belowRect && yOverlap(belowRect, rect)) {
        belowRect = upTop(belowRect, rect.top)
      }
    }
  }
  if (aboveRect && aboveRect.bottom >= y) { closest = above; closestRect = aboveRect }
  else if (belowRect && belowRect.top <= y) { closest = below; closestRect = belowRect }

  if (!closest) return {node: parent, offset: 0}
  let clipX = Math.max(closestRect!.left, Math.min(closestRect!.right, x))
  if (closest.nodeType == 3) return domPosInText(closest as Text, clipX, y)
  if (closestOverlap && (closest as HTMLElement).contentEditable != "false")
    return domPosAtCoords(closest as HTMLElement, clipX, y)
  let offset = Array.prototype.indexOf.call(parent.childNodes, closest) +
    (x >= (closestRect!.left + closestRect!.right) / 2 ? 1 : 0)
  return {node: parent, offset}
}

function domPosInText(node: Text, x: number, y: number): {node: Node, offset: number} {
  let len = node.nodeValue!.length
  let closestOffset = -1, closestDY = 1e9, generalSide = 0
  for (let i = 0; i < len; i++) {
    let rects = textRange(node, i, i + 1).getClientRects()
    for (let j = 0; j < rects.length; j++) {
      let rect = rects[j]
      if (rect.top == rect.bottom) continue
      if (!generalSide) generalSide = x - rect.left
      let dy = (rect.top > y ? rect.top - y : y - rect.bottom) - 1
      if (rect.left - 1 <= x && rect.right + 1 >= x && dy < closestDY) {
        let right = x >= (rect.left + rect.right) / 2, after = right
        if (browser.chrome || browser.gecko) {
          // Check for RTL on browsers that support getting client
          // rects for empty ranges.
          let rectBefore = textRange(node, i).getBoundingClientRect()
          if (rectBefore.left == rect.right) after = !right
        }
        if (dy <= 0) return {node, offset: i + (after ? 1 : 0)}
        closestOffset = i + (after ? 1 : 0)
        closestDY = dy
      }
    }
  }
  return {node, offset: closestOffset > -1 ? closestOffset : generalSide > 0 ? node.nodeValue!.length : 0}
}

export function posAtCoords(view: EditorView, coords: {x: number, y: number}, precise: boolean, bias: -1 | 1 = -1): number | null {
  let content = view.contentDOM.getBoundingClientRect(), docTop = content.top + view.viewState.paddingTop
  let block, {docHeight} = view.viewState
  let {x, y} = coords, yOffset = y - docTop
  if (yOffset < 0) return 0
  if (yOffset > docHeight) return view.state.doc.length

  // Scan for a text block near the queried y position
  for (let halfLine = view.viewState.heightOracle.textHeight / 2, bounced = false;;) {
    block = view.elementAtHeight(yOffset)
    if (block.type == BlockType.Text) break
    for (;;) {
      // Move the y position out of this block
      yOffset = bias > 0 ? block.bottom + halfLine : block.top - halfLine
      if (yOffset >= 0 && yOffset <= docHeight) break
      // If the document consists entirely of replaced widgets, we
      // won't find a text block, so return 0
      if (bounced) return precise ? null : 0
      bounced = true
      bias = -bias as -1 | 1
    }
  }
  y = docTop + yOffset
  let lineStart = block.from
  // If this is outside of the rendered viewport, we can't determine a position
  if (lineStart < view.viewport.from)
    return view.viewport.from == 0 ? 0 : precise ? null : posAtCoordsImprecise(view, content, block, x, y)
  if (lineStart > view.viewport.to)
    return view.viewport.to == view.state.doc.length ? view.state.doc.length :
      precise ? null : posAtCoordsImprecise(view, content, block, x, y)
  // Prefer ShadowRootOrDocument.elementFromPoint if present, fall back to document if not
  let doc = view.dom.ownerDocument
  let root = (view.root as any).elementFromPoint ? view.root as Document : doc
  let element = root.elementFromPoint(x, y)
  if (element && !view.contentDOM.contains(element)) element = null

  // If the element is unexpected, clip x at the sides of the content area and try again
  if (!element) {
    x = Math.max(content.left + 1, Math.min(content.right - 1, x))
    element = root.elementFromPoint(x, y)
    if (element && !view.contentDOM.contains(element)) element = null
  }

  // There's visible editor content under the point, so we can try
  // using caret(Position|Range)FromPoint as a shortcut
  let node: Node | undefined, offset: number = -1
  if (element && view.docView.nearest(element)?.isEditable != false) {
    if (doc.caretPositionFromPoint) {
      let pos = doc.caretPositionFromPoint(x, y)
      if (pos) ({offsetNode: node, offset} = pos)
    } else if (doc.caretRangeFromPoint) {
      let range = doc.caretRangeFromPoint(x, y)
      if (range) {
        ;({startContainer: node, startOffset: offset} = range)
        if (!view.contentDOM.contains(node) ||
            browser.safari && isSuspiciousSafariCaretResult(node, offset, x) ||
            browser.chrome && isSuspiciousChromeCaretResult(node, offset, x))
          node = undefined
      }
    }
    // Chrome will return offsets into <input> elements without child
    // nodes, which will lead to a null deref below, so clip the
    // offset to the node size.
    if (node) offset = Math.min(maxOffset(node), offset)
  }

  // No luck, do our own (potentially expensive) search
  if (!node || !view.docView.dom.contains(node)) {
    let line = LineView.find(view.docView, lineStart)
    if (!line) return yOffset > block.top + block.height / 2 ? block.to : block.from
    ;({node, offset} = domPosAtCoords(line.dom!, x, y))
  }
  let nearest = view.docView.nearest(node)
  if (!nearest) return null
  if (nearest.isWidget && nearest.dom?.nodeType == 1) {
    let rect = (nearest.dom as HTMLElement).getBoundingClientRect()
    return coords.y < rect.top || coords.y <= rect.bottom && coords.x <= (rect.left + rect.right) / 2
      ? nearest.posAtStart : nearest.posAtEnd
  } else {
    return nearest.localPosFromDOM(node, offset) + nearest.posAtStart
  }
}

function posAtCoordsImprecise(view: EditorView, contentRect: Rect, block: BlockInfo, x: number, y: number) {
  let into = Math.round((x - contentRect.left) * view.defaultCharacterWidth)
  if (view.lineWrapping && block.height > view.defaultLineHeight * 1.5) {
    let textHeight = view.viewState.heightOracle.textHeight
    let line = Math.floor((y - block.top - (view.defaultLineHeight - textHeight) * 0.5) / textHeight)
    into += line * view.viewState.heightOracle.lineLength
  }
  let content = view.state.sliceDoc(block.from, block.to)
  return block.from + findColumn(content, into, view.state.tabSize)
}

// In case of a high line height, Safari's caretRangeFromPoint treats
// the space between lines as belonging to the last character of the
// line before. This is used to detect such a result so that it can be
// ignored (issue #401).
function isSuspiciousSafariCaretResult(node: Node, offset: number, x: number) {
  let len, scan = node
  if (node.nodeType != 3 || offset != (len = node.nodeValue!.length)) return false
  for (;;) { // Check that there is no content after this node
    let next = scan.nextSibling
    if (next) {
      if (next.nodeName == "BR") break
      return false
    } else {
      let parent = scan.parentNode
      if (!parent || parent.nodeName == "DIV") break
      scan = parent
    }
  }
  return textRange(node as Text, len - 1, len).getBoundingClientRect().right > x
}

// Chrome will move positions between lines to the start of the next line
function isSuspiciousChromeCaretResult(node: Node, offset: number, x: number) {
  if (offset != 0) return false
  for (let cur = node;;) {
    let parent = cur.parentNode
    if (!parent || parent.nodeType != 1 || parent.firstChild != cur) return false
    if ((parent as HTMLElement).classList.contains("cm-line")) break
    cur = parent
  }
  let rect = node.nodeType == 1 ? (node as HTMLElement).getBoundingClientRect()
    : textRange(node as Text, 0, Math.max(node.nodeValue!.length, 1)).getBoundingClientRect()
  return x - rect.left > 5
}

export function blockAt(view: EditorView, pos: number, side: -1 | 1): BlockInfo {
  let line = view.lineBlockAt(pos)
  if (Array.isArray(line.type)) {
    let best: BlockInfo | undefined
    for (let l of line.type) {
      if (l.from > pos) break
      if (l.to < pos) continue
      if (l.from < pos && l.to > pos) return l
      if (!best || (l.type == BlockType.Text && (best.type != l.type || (side < 0 ? l.from < pos : l.to > pos))))
        best = l
    }
    return best || line
  }
  return line
}

export function moveToLineBoundary(view: EditorView, start: SelectionRange, forward: boolean, includeWrap: boolean) {
  let line = blockAt(view, start.head, start.assoc || -1)
  let coords = !includeWrap || line.type != BlockType.Text || !(view.lineWrapping || line.widgetLineBreaks) ? null
    : view.coordsAtPos(start.assoc < 0 && start.head > line.from ? start.head - 1 : start.head)
  if (coords) {
    let editorRect = view.dom.getBoundingClientRect()
    let direction = view.textDirectionAt(line.from)
    let pos = view.posAtCoords({x: forward == (direction == Direction.LTR) ? editorRect.right - 1 : editorRect.left + 1,
                                y: (coords.top + coords.bottom) / 2})
    if (pos != null) return EditorSelection.cursor(pos, forward ? -1 : 1)
  }
  return EditorSelection.cursor(forward ? line.to : line.from, forward ? -1 : 1)
}

export function moveByChar(view: EditorView, start: SelectionRange, forward: boolean,
                           by?: (initial: string) => (next: string) => boolean) {
  let line = view.state.doc.lineAt(start.head), spans = view.bidiSpans(line)
  let direction = view.textDirectionAt(line.from)
  for (let cur = start, check: null | ((next: string) => boolean) = null;;) {
    let next = moveVisually(line, spans, direction, cur, forward), char = movedOver
    if (!next) {
      if (line.number == (forward ? view.state.doc.lines : 1)) return cur
      char = "\n"
      line = view.state.doc.line(line.number + (forward ? 1 : -1))
      spans = view.bidiSpans(line)
      next = view.visualLineSide(line, !forward)
    }
    if (!check) {
      if (!by) return next
      check = by(char)
    } else if (!check(char)) {
      return cur
    }
    cur = next
  }
}

export function byGroup(view: EditorView, pos: number, start: string) {
  let categorize = view.state.charCategorizer(pos)
  let cat = categorize(start)
  return (next: string) => {
    let nextCat = categorize(next)
    if (cat == CharCategory.Space) cat = nextCat
    return cat == nextCat
  }
}

export function moveVertically(view: EditorView, start: SelectionRange, forward: boolean, distance?: number) {
  let startPos = start.head, dir: -1 | 1 = forward ? 1 : -1
  if (startPos == (forward ? view.state.doc.length : 0)) return EditorSelection.cursor(startPos, start.assoc)
  let goal = start.goalColumn, startY
  let rect = view.contentDOM.getBoundingClientRect()
  let startCoords = view.coordsAtPos(startPos, start.assoc || -1), docTop = view.documentTop
  if (startCoords) {
    if (goal == null) goal = startCoords.left - rect.left
    startY = dir < 0 ? startCoords.top : startCoords.bottom
  } else {
    let line = view.viewState.lineBlockAt(startPos)
    if (goal == null) goal = Math.min(rect.right - rect.left, view.defaultCharacterWidth * (startPos - line.from))
    startY = (dir < 0 ? line.top : line.bottom) + docTop
  }
  let resolvedGoal = rect.left + goal
  let dist = distance ?? (view.viewState.heightOracle.textHeight >> 1)
  for (let extra = 0;; extra += 10) {
    let curY = startY + (dist + extra) * dir
    let pos = posAtCoords(view, {x: resolvedGoal, y: curY}, false, dir)!
    if (curY < rect.top || curY > rect.bottom || (dir < 0 ? pos < startPos : pos > startPos)) {
      let charRect = view.docView.coordsForChar(pos)
      let assoc = !charRect || curY < charRect.top ? -1 : 1
      return EditorSelection.cursor(pos, assoc, undefined, goal)
    }
  }
}

export function skipAtomicRanges(atoms: readonly RangeSet<any>[], pos: number, bias: -1 | 0 | 1) {
  for (;;) {
    let moved = 0
    for (let set of atoms) {
      set.between(pos - 1, pos + 1, (from, to, value) => {
        if (pos > from && pos < to) {
          let side = moved || bias || (pos - from < to - pos ? -1 : 1)
          pos = side < 0 ? from : to
          moved = side
        }
      })
    }
    if (!moved) return pos
  }
}

export function skipAtomsForSelection(atoms: readonly RangeSet<any>[], sel: EditorSelection) {
  let ranges = null
  for (let i = 0; i < sel.ranges.length; i++) {
    let range = sel.ranges[i], updated = null
    if (range.empty) {
      let pos = skipAtomicRanges(atoms, range.from, 0)
      if (pos != range.from) updated = EditorSelection.cursor(pos, -1)
    } else {
      let from = skipAtomicRanges(atoms, range.from, -1)
      let to = skipAtomicRanges(atoms, range.to, 1)
      if (from != range.from || to != range.to)
        updated = EditorSelection.range(range.from == range.anchor ? from : to, range.from == range.head ? from : to)
    }
    if (updated) {
      if (!ranges) ranges = sel.ranges.slice()
      ranges[i] = updated
    }
  }
  return ranges ? EditorSelection.create(ranges, sel.mainIndex) : sel
}

export function skipAtoms(view: EditorView, oldPos: SelectionRange, pos: SelectionRange) {
  let newPos = skipAtomicRanges(view.state.facet(atomicRanges).map(f => f(view)), pos.from, oldPos.head > pos.from ? -1 : 1)
  return newPos == pos.from ? pos : EditorSelection.cursor(newPos, newPos < pos.from ? 1 : -1)
}
