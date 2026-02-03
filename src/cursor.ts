import {EditorState, EditorSelection, SelectionRange, RangeSet,
        CharCategory, findColumn, findClusterBreak} from "@codemirror/state"
import {EditorView} from "./editorview"
import {BlockType} from "./decoration"
import {atomicRanges} from "./extension"
import {textRange, Rect} from "./dom"
import {moveVisually, movedOver, Direction, BidiSpan} from "./bidi"
import {BlockInfo} from "./heightmap"
import {TileFlag, CompositeTile, TextTile} from "./tile"

declare global {
  interface Selection { modify(action: string, direction: string, granularity: string): void }
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
  let pos = posAtCoords(view, {x: resolvedGoal, y: startY + dist * dir}, false, dir)!
  return EditorSelection.cursor(pos.pos, pos.assoc, undefined, goal)
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

export class PosAssoc {
  constructor(readonly pos: number, readonly assoc: -1 | 1) {}
}

export function posAtCoords(view: EditorView, coords: {x: number, y: number}, precise: boolean, scanY?: 1 | -1): PosAssoc | null {
  let content = view.contentDOM.getBoundingClientRect(), docTop = content.top + view.viewState.paddingTop
  let {x, y} = coords, yOffset = y - docTop, block
  // First find the block at the given Y position, if any. If scanY is
  // given (used for vertical cursor motion), try to skip widgets and
  // line padding.
  for (;;) {
    if (yOffset < 0) return new PosAssoc(0, 1)
    if (yOffset > view.viewState.docHeight) return new PosAssoc(view.state.doc.length, -1)
    block = view.elementAtHeight(yOffset)
    if (scanY == null) break
    if (block.type == BlockType.Text) {
      if (scanY < 0 ? block.to < view.viewport.from : block.from > view.viewport.to) break
      // Check whether we aren't landing on the top/bottom padding of the line
      let rect = view.docView.coordsAt(scanY < 0 ? block.from : block.to, scanY > 0 ? -1 : 1)
      if (rect && (scanY < 0 ? rect.top <= yOffset + docTop : rect.bottom >= yOffset + docTop)) break
    }
    let halfLine = view.viewState.heightOracle.textHeight / 2
    yOffset = scanY > 0 ? block.bottom + halfLine : block.top - halfLine
  }
  // If outside the viewport, return null if precise==true, an
  // estimate otherwise.
  if (view.viewport.from >= block.to || view.viewport.to <= block.from) {
    if (precise) return null
    if (block.type == BlockType.Text) {
      let pos = posAtCoordsImprecise(view, content, block, x, y)
      return new PosAssoc(pos, pos == block.from ? 1 : -1)
    }
  }
  if (block.type != BlockType.Text)
    return yOffset < (block.top + block.bottom) / 2 ? new PosAssoc(block.from, 1) : new PosAssoc(block.to, -1)

  // Here we know we're in a line, so run the logic for inline layout
  let line = view.docView.lineAt(block.from, 2)
  if (!line || line.length != block.length) line = view.docView.lineAt(block.from, -2)!
  return posAtCoordsInline(view, line, block.from, x, y)
}

// Scan through the rectangles for the content of a tile, finding the
// one closest to the given coordinates, prefering closeness in Y over
// closeness in X.
//
// If this is a text tile, go character-by-character. For line or mark
// tiles, check each non-point-widget child, and descend text or mark
// tiles with a recursive call.
//
// For non-wrapped, purely left-to-right text, this could use a binary
// search. But because this seems to be fast enough, for how often it
// is called, there's not currently a specialized implementation for
// that.
function posAtCoordsInline(view: EditorView, tile: CompositeTile | TextTile, offset: number, x: number, y: number) {
  let closest = -1, closestRect: Rect | null = null
  let dxClosest = 1e9, dyClosest = 1e9
  let rowTop = y, rowBot = y
  let checkRects = (rects: DOMRectList, index: number) => {
    for (let i = 0; i < rects.length; i++) {
      let rect = rects[i]
      if (rect.top == rect.bottom) continue
      let dx = rect.left > x ? rect.left - x : rect.right < x ? x - rect.right : 0
      let dy = rect.top > y ? rect.top - y : rect.bottom < y ? y - rect.bottom : 0
      if (rect.top <= rowBot && rect.bottom >= rowTop) {
        // Rectangle is in the current row
        rowTop = Math.min(rect.top, rowTop)
        rowBot = Math.max(rect.bottom, rowBot)
        dy = 0
      }
      if (closest < 0 || (dy - dyClosest || dx - dxClosest) < 0) {
        if (closest >= 0 && dyClosest && dxClosest < dx &&
          closestRect!.top <= rowBot - 2 && closestRect!.bottom >= rowTop + 2) {
          // Retroactively set dy to 0 if the current match is in this row.
          dyClosest = 0
        } else {
          closest = index
          dxClosest = dx
          dyClosest = dy
          closestRect = rect
        }
      }
    }
  }

  if (tile.isText()) {
    for (let i = 0; i < tile.length;) {
      let next = findClusterBreak(tile.text, i)
      checkRects(textRange(tile.dom, i, next).getClientRects(), i)
      if (!dxClosest && !dyClosest) break
      i = next
    }
    let after = (x > (closestRect!.left + closestRect!.right) / 2) == (dirAt(view, closest + offset) == Direction.LTR)
    return after ? new PosAssoc(offset + findClusterBreak(tile.text, closest), -1) : new PosAssoc(offset + closest, 1)
  } else {
    if (!tile.length) return new PosAssoc(offset, 1)
    for (let i = 0; i < tile.children.length; i++) {
      let child = tile.children[i]
      if (child.flags & TileFlag.PointWidget) continue
      let rects = (child.dom.nodeType == 1 ? child.dom as HTMLElement : textRange(child.dom as Text, 0, child.length)).getClientRects()
      checkRects(rects, i)
      if (!dxClosest && !dyClosest) break
    }
    let inner = tile.children[closest], innerOff = tile.posBefore(inner, offset)
    if (inner.isComposite() || inner.isText())
      return posAtCoordsInline(view, inner, innerOff, Math.max(closestRect!.left, Math.min(closestRect!.right, x)), y)
    let after = (x > (closestRect!.left + closestRect!.right) / 2) == (dirAt(view, closest + offset) == Direction.LTR)
    return after ? new PosAssoc(innerOff + inner.length, -1) : new PosAssoc(innerOff, 1)
  }
}

function dirAt(view: EditorView, pos: number) {
  let line = view.state.doc.lineAt(pos), spans = view.bidiSpans(line)
  return spans[BidiSpan.find(view.bidiSpans(line), pos - line.from, -1, 1)].dir
}
