import {ChangeSet, RangeSet, findClusterBreak, SelectionRange} from "@codemirror/state"
import {ContentView, ChildCursor, ViewFlag, DOMPos, replaceRange} from "./contentview"
import {BlockView, LineView, BlockWidgetView, BlockGapWidget} from "./blockview"
import {TextView, MarkView} from "./inlineview"
import {ContentBuilder} from "./buildview"
import browser from "./browser"
import {Decoration, DecorationSet, addRange, MarkDecoration} from "./decoration"
import {getAttrs} from "./attributes"
import {clientRectsFor, isEquivalentPosition, Rect, scrollRectIntoView,
        getSelection, hasSelection, textRange, DOMSelectionState,
        textNodeBefore, textNodeAfter} from "./dom"
import {ViewUpdate, decorations as decorationsFacet, outerDecorations, ChangedRange,
        ScrollTarget, scrollHandler, getScrollMargins, logException, setEditContextFormatting} from "./extension"
import {EditorView} from "./editorview"
import {Direction} from "./bidi"

type Composition = {
  range: ChangedRange,
  text: Text,
  marks: {node: HTMLElement, deco: MarkDecoration}[],
  line: HTMLElement
}

export class DocView extends ContentView {
  children!: BlockView[]

  decorations: readonly DecorationSet[] = []
  dynamicDecorationMap: boolean[] = [false]
  domChanged: {newSel: SelectionRange | null} | null = null
  hasComposition: {from: number, to: number} | null = null
  markedForComposition: Set<ContentView> = new Set
  editContextFormatting = Decoration.none
  lastCompositionAfterCursor = false

  // Track a minimum width for the editor. When measuring sizes in
  // measureVisibleLineHeights, this is updated to point at the width
  // of a given element and its extent in the document. When a change
  // happens in that range, these are reset. That way, once we've seen
  // a line/element of a given length, we keep the editor wide enough
  // to fit at least that element, until it is changed, at which point
  // we forget it again.
  minWidth = 0
  minWidthFrom = 0
  minWidthTo = 0

  // Track whether the DOM selection was set in a lossy way, so that
  // we don't mess it up when reading it back it
  impreciseAnchor: DOMPos | null = null
  impreciseHead: DOMPos | null = null
  forceSelection = false

  dom!: HTMLElement

  // Used by the resize observer to ignore resizes that we caused
  // ourselves
  lastUpdate = Date.now()

  get length() { return this.view.state.doc.length }

  constructor(readonly view: EditorView) {
    super()
    this.setDOM(view.contentDOM)
    this.children = [new LineView]
    this.children[0].setParent(this)
    this.updateDeco()
    this.updateInner([new ChangedRange(0, 0, 0, view.state.doc.length)], 0, null)
  }

  // Update the document view to a given state.
  update(update: ViewUpdate) {
    let changedRanges = update.changedRanges
    if (this.minWidth > 0 && changedRanges.length) {
      if (!changedRanges.every(({fromA, toA}) => toA < this.minWidthFrom || fromA > this.minWidthTo)) {
        this.minWidth = this.minWidthFrom = this.minWidthTo = 0
      } else {
        this.minWidthFrom = update.changes.mapPos(this.minWidthFrom, 1)
        this.minWidthTo = update.changes.mapPos(this.minWidthTo, 1)
      }
    }

    this.updateEditContextFormatting(update)

    let readCompositionAt = -1
    if (this.view.inputState.composing >= 0 && !this.view.observer.editContext) {
      if (this.domChanged?.newSel)
        readCompositionAt = this.domChanged.newSel.head
      else if (!touchesComposition(update.changes, this.hasComposition) && !update.selectionSet)
        readCompositionAt = update.state.selection.main.head
    }
    let composition = readCompositionAt > -1 ? findCompositionRange(this.view, update.changes, readCompositionAt) : null
    this.domChanged = null

    if (this.hasComposition) {
      this.markedForComposition.clear()
      let {from, to} = this.hasComposition
      changedRanges = new ChangedRange(from, to, update.changes.mapPos(from, -1), update.changes.mapPos(to, 1))
        .addToSet(changedRanges.slice())
    }
    this.hasComposition = composition ? {from: composition.range.fromB, to: composition.range.toB} : null

    // When the DOM nodes around the selection are moved to another
    // parent, Chrome sometimes reports a different selection through
    // getSelection than the one that it actually shows to the user.
    // This forces a selection update when lines are joined to work
    // around that. Issue #54
    if ((browser.ie || browser.chrome) && !composition && update &&
        update.state.doc.lines != update.startState.doc.lines)
      this.forceSelection = true

    let prevDeco = this.decorations, deco = this.updateDeco()
    let decoDiff = findChangedDeco(prevDeco, deco, update.changes)
    changedRanges = ChangedRange.extendWithRanges(changedRanges, decoDiff)

    if (!(this.flags & ViewFlag.Dirty) && changedRanges.length == 0) {
      return false
    } else {
      this.updateInner(changedRanges, update.startState.doc.length, composition)
      if (update.transactions.length) this.lastUpdate = Date.now()
      return true
    }
  }

  // Used by update and the constructor do perform the actual DOM
  // update
  private updateInner(changes: readonly ChangedRange[], oldLength: number, composition: Composition | null) {
    this.view.viewState.mustMeasureContent = true
    this.updateChildren(changes, oldLength, composition)

    let {observer} = this.view
    observer.ignore(() => {
      // Lock the height during redrawing, since Chrome sometimes
      // messes with the scroll position during DOM mutation (though
      // no relayout is triggered and I cannot imagine how it can
      // recompute the scroll position without a layout)
      this.dom.style.height = this.view.viewState.contentHeight / this.view.scaleY + "px"
      this.dom.style.flexBasis = this.minWidth ? this.minWidth + "px" : ""
      // Chrome will sometimes, when DOM mutations occur directly
      // around the selection, get confused and report a different
      // selection from the one it displays (issue #218). This tries
      // to detect that situation.
      let track = browser.chrome || browser.ios ? {node: observer.selectionRange.focusNode!, written: false} : undefined
      this.sync(this.view, track)
      this.flags &= ~ViewFlag.Dirty
      if (track && (track.written || observer.selectionRange.focusNode != track.node)) this.forceSelection = true
      this.dom.style.height = ""
    })
    this.markedForComposition.forEach(cView => cView.flags &= ~ViewFlag.Composition)
    let gaps = []
    if (this.view.viewport.from || this.view.viewport.to < this.view.state.doc.length) for (let child of this.children)
      if (child instanceof BlockWidgetView && child.widget instanceof BlockGapWidget) gaps.push(child.dom!)
    observer.updateGaps(gaps)
  }

  private updateChildren(changes: readonly ChangedRange[], oldLength: number, composition: Composition | null) {
    let ranges = composition ? composition.range.addToSet(changes.slice()) : changes
    let cursor = this.childCursor(oldLength)
    for (let i = ranges.length - 1;; i--) {
      let next = i >= 0 ? ranges[i] : null
      if (!next) break
      let {fromA, toA, fromB, toB} = next, content, breakAtStart, openStart, openEnd
      if (composition && composition.range.fromB < toB && composition.range.toB > fromB) {
        let before = ContentBuilder.build(this.view.state.doc, fromB, composition.range.fromB, this.decorations,
                                          this.dynamicDecorationMap)
        let after = ContentBuilder.build(this.view.state.doc, composition.range.toB, toB, this.decorations,
                                         this.dynamicDecorationMap)
        breakAtStart = before.breakAtStart
        openStart = before.openStart; openEnd = after.openEnd
        let compLine = this.compositionView(composition)
        if (after.breakAtStart) {
          compLine.breakAfter = 1
        } else if (after.content.length &&
                   compLine.merge(compLine.length, compLine.length, after.content[0], false, after.openStart, 0)) {
          compLine.breakAfter = after.content[0].breakAfter
          after.content.shift()
        }
        if (before.content.length &&
            compLine.merge(0, 0, before.content[before.content.length - 1], true, 0, before.openEnd)) {
          before.content.pop()
        }
        content = before.content.concat(compLine).concat(after.content)
      } else {
        ;({content, breakAtStart, openStart, openEnd} =
          ContentBuilder.build(this.view.state.doc, fromB, toB, this.decorations, this.dynamicDecorationMap))
      }
      let {i: toI, off: toOff} = cursor.findPos(toA, 1)
      let {i: fromI, off: fromOff} = cursor.findPos(fromA, -1)
      replaceRange(this, fromI, fromOff, toI, toOff, content, breakAtStart, openStart, openEnd)
    }
    if (composition) this.fixCompositionDOM(composition)
  }

  private updateEditContextFormatting(update: ViewUpdate) {
    this.editContextFormatting = this.editContextFormatting.map(update.changes)
    for (let tr of update.transactions) for (let effect of tr.effects) if (effect.is(setEditContextFormatting)) {
      this.editContextFormatting = effect.value
    }
  }

  private compositionView(composition: Composition) {
    let cur: ContentView = new TextView(composition.text.nodeValue!)
    cur.flags |= ViewFlag.Composition
    for (let {deco} of composition.marks)
      cur = new MarkView(deco, [cur], cur.length)
    let line = new LineView
    line.append(cur, 0)
    return line
  }

  private fixCompositionDOM(composition: Composition) {
    let fix = (dom: Node, cView: ContentView) => {
      cView.flags |= ViewFlag.Composition | (cView.children.some(c => c.flags & ViewFlag.Dirty) ? ViewFlag.ChildDirty : 0)
      this.markedForComposition.add(cView)
      let prev = ContentView.get(dom)
      if (prev && prev != cView) prev.dom = null
      cView.setDOM(dom)
    }
    let pos = this.childPos(composition.range.fromB, 1)
    let cView: ContentView = this.children[pos.i]
    fix(composition.line, cView)
    for (let i = composition.marks.length - 1; i >= -1; i--) {
      pos = cView.childPos(pos.off, 1)
      cView = cView.children[pos.i]
      fix(i >= 0 ? composition.marks[i].node : composition.text, cView)
    }
  }

  // Sync the DOM selection to this.state.selection
  updateSelection(mustRead = false, fromPointer = false) {
    if (mustRead || !this.view.observer.selectionRange.focusNode) this.view.observer.readSelectionRange()
    let activeElt = this.view.root.activeElement, focused = activeElt == this.dom
    let selectionNotFocus = !focused &&
      hasSelection(this.dom, this.view.observer.selectionRange) && !(activeElt && this.dom.contains(activeElt))
    if (!(focused || fromPointer || selectionNotFocus)) return
    let force = this.forceSelection
    this.forceSelection = false

    let main = this.view.state.selection.main
    let anchor = this.moveToLine(this.domAtPos(main.anchor))
    let head = main.empty ? anchor : this.moveToLine(this.domAtPos(main.head))

    // Always reset on Firefox when next to an uneditable node to
    // avoid invisible cursor bugs (#111)
    if (browser.gecko && main.empty && !this.hasComposition && betweenUneditable(anchor)) {
      let dummy = document.createTextNode("")
      this.view.observer.ignore(() => anchor.node.insertBefore(dummy, anchor.node.childNodes[anchor.offset] || null))
      anchor = head = new DOMPos(dummy, 0)
      force = true
    }

    let domSel = this.view.observer.selectionRange
    // If the selection is already here, or in an equivalent position, don't touch it
    if (force || !domSel.focusNode || (
          !isEquivalentPosition(anchor.node, anchor.offset, domSel.anchorNode, domSel.anchorOffset) ||
          !isEquivalentPosition(head.node, head.offset, domSel.focusNode, domSel.focusOffset)
        ) && !this.suppressWidgetCursorChange(domSel, main)) {
      this.view.observer.ignore(() => {
        // Chrome Android will hide the virtual keyboard when tapping
        // inside an uneditable node, and not bring it back when we
        // move the cursor to its proper position. This tries to
        // restore the keyboard by cycling focus.
        if (browser.android && browser.chrome && this.dom.contains(domSel.focusNode) &&
            inUneditable(domSel.focusNode, this.dom)) {
          this.dom.blur()
          this.dom.focus({preventScroll: true})
        }
        let rawSel = getSelection(this.view.root)
        if (!rawSel) {
          // No DOM selection for some reason—do nothing
        } else if (main.empty) {
          // Work around https://bugzilla.mozilla.org/show_bug.cgi?id=1612076
          if (browser.gecko) {
            let nextTo = nextToUneditable(anchor.node, anchor.offset)
            if (nextTo && nextTo != (NextTo.Before | NextTo.After)) {
              let text = (nextTo == NextTo.Before ? textNodeBefore : textNodeAfter)(anchor.node, anchor.offset)
              if (text) anchor = new DOMPos(text.node, text.offset)
            }
          }
          rawSel.collapse(anchor.node, anchor.offset)
          if (main.bidiLevel != null && (rawSel as any).caretBidiLevel !== undefined)
            (rawSel as any).caretBidiLevel = main.bidiLevel
        } else if (rawSel.extend) {
          // Selection.extend can be used to create an 'inverted' selection
          // (one where the focus is before the anchor), but not all
          // browsers support it yet.
          rawSel.collapse(anchor.node, anchor.offset)
          // Safari will ignore the call above when the editor is
          // hidden, and then raise an error on the call to extend
          // (#940).
          try { rawSel.extend(head.node, head.offset) }
          catch(_) {}
        } else {
          // Primitive (IE) way
          let range = document.createRange()
          if (main.anchor > main.head) [anchor, head] = [head, anchor]
          range.setEnd(head.node, head.offset)
          range.setStart(anchor.node, anchor.offset)
          rawSel.removeAllRanges()
          rawSel.addRange(range)
        }
        if (selectionNotFocus && this.view.root.activeElement == this.dom) {
          this.dom.blur()
          if (activeElt) (activeElt as HTMLElement).focus()
        }
      })
      this.view.observer.setSelectionRange(anchor, head)
    }

    this.impreciseAnchor = anchor.precise ? null : new DOMPos(domSel.anchorNode!, domSel.anchorOffset)
    this.impreciseHead = head.precise ? null: new DOMPos(domSel.focusNode!, domSel.focusOffset)
  }

  // If a zero-length widget is inserted next to the cursor during
  // composition, avoid moving it across it and disrupting the
  // composition.
  suppressWidgetCursorChange(sel: DOMSelectionState, cursor: SelectionRange) {
    return this.hasComposition && cursor.empty &&
      isEquivalentPosition(sel.focusNode!, sel.focusOffset, sel.anchorNode, sel.anchorOffset) &&
      this.posFromDOM(sel.focusNode!, sel.focusOffset) == cursor.head
  }

  enforceCursorAssoc() {
    if (this.hasComposition) return
    let {view} = this, cursor = view.state.selection.main
    let sel = getSelection(view.root)
    let {anchorNode, anchorOffset} = view.observer.selectionRange
    if (!sel || !cursor.empty || !cursor.assoc || !sel.modify) return
    let line = LineView.find(this, cursor.head)
    if (!line) return
    let lineStart = line.posAtStart
    if (cursor.head == lineStart || cursor.head == lineStart + line.length) return
    let before = this.coordsAt(cursor.head, -1), after = this.coordsAt(cursor.head, 1)
    if (!before || !after || before.bottom > after.top) return
    let dom = this.domAtPos(cursor.head + cursor.assoc)
    sel.collapse(dom.node, dom.offset)
    sel.modify("move", cursor.assoc < 0 ? "forward" : "backward", "lineboundary")
    // This can go wrong in corner cases like single-character lines,
    // so check and reset if necessary.
    view.observer.readSelectionRange()
    let newRange = view.observer.selectionRange
    if (view.docView.posFromDOM(newRange.anchorNode!, newRange.anchorOffset) != cursor.from)
      sel.collapse(anchorNode, anchorOffset)
  }

  // If a position is in/near a block widget, move it to a nearby text
  // line, since we don't want the cursor inside a block widget.
  moveToLine(pos: DOMPos) {
    // Block widgets will return positions before/after them, which
    // are thus directly in the document DOM element.
    let dom = this.dom!, newPos
    if (pos.node != dom) return pos
    for (let i = pos.offset; !newPos && i < dom.childNodes.length; i++) {
      let view = ContentView.get(dom.childNodes[i])
      if (view instanceof LineView) newPos = view.domAtPos(0)
    }
    for (let i = pos.offset - 1; !newPos && i >= 0; i--) {
      let view = ContentView.get(dom.childNodes[i])
      if (view instanceof LineView) newPos = view.domAtPos(view.length)
    }
    return newPos ? new DOMPos(newPos.node, newPos.offset, true) : pos
  }

  nearest(dom: Node): ContentView | null {
    for (let cur: Node | null = dom; cur;) {
      let domView = ContentView.get(cur)
      if (domView && domView.rootView == this) return domView
      cur = cur.parentNode
    }
    return null
  }

  posFromDOM(node: Node, offset: number): number {
    let view = this.nearest(node)
    if (!view) throw new RangeError("Trying to find position for a DOM position outside of the document")
    return view.localPosFromDOM(node, offset) + view.posAtStart
  }

  domAtPos(pos: number): DOMPos {
    let {i, off} = this.childCursor().findPos(pos, -1)
    for (; i < this.children.length - 1;) {
      let child = this.children[i]
      if (off < child.length || child instanceof LineView) break
      i++; off = 0
    }
    return this.children[i].domAtPos(off)
  }

  coordsAt(pos: number, side: number): Rect | null {
    let best = null, bestPos = 0
    for (let off = this.length, i = this.children.length - 1; i >= 0; i--) {
      let child = this.children[i], end = off - child.breakAfter, start = end - child.length
      if (end < pos) break
      if (start <= pos && (start < pos || child.covers(-1)) && (end > pos || child.covers(1)) &&
          (!best || child instanceof LineView && !(best instanceof LineView && side >= 0))) {
        best = child
        bestPos = start
      } else if (best && start == pos && end == pos && child instanceof BlockWidgetView && Math.abs(side) < 2) {
        if (child.deco.startSide < 0) break
        else if (i) best = null
      }
      off = start
    }
    return best ? best.coordsAt(pos - bestPos, side) : null
  }

  coordsForChar(pos: number) {
    let {i, off} = this.childPos(pos, 1), child: ContentView = this.children[i]
    if (!(child instanceof LineView)) return null
    while (child.children.length) {
      let {i, off: childOff} = child.childPos(off, 1)
      for (;; i++) {
        if (i == child.children.length) return null
        if ((child = child.children[i]).length) break
      }
      off = childOff
    }
    if (!(child instanceof TextView)) return null
    let end = findClusterBreak(child.text, off)
    if (end == off) return null
    let rects = textRange(child.dom as Text, off, end).getClientRects()
    for (let i = 0; i < rects.length; i++) {
      let rect = rects[i]
      if (i == rects.length - 1 || rect.top < rect.bottom && rect.left < rect.right) return rect
    }
    return null
  }

  measureVisibleLineHeights(viewport: {from: number, to: number}) {
    let result = [], {from, to} = viewport
    let contentWidth = this.view.contentDOM.clientWidth
    let isWider = contentWidth > Math.max(this.view.scrollDOM.clientWidth, this.minWidth) + 1
    let widest = -1, ltr = this.view.textDirection == Direction.LTR
    for (let pos = 0, i = 0; i < this.children.length; i++) {
      let child = this.children[i], end = pos + child.length
      if (end > to) break
      if (pos >= from) {
        let childRect = child.dom!.getBoundingClientRect()
        result.push(childRect.height)
        if (isWider) {
          let last = child.dom!.lastChild
          let rects = last ? clientRectsFor(last) : []
          if (rects.length) {
            let rect = rects[rects.length - 1]
            let width = ltr ? rect.right - childRect.left : childRect.right - rect.left
            if (width > widest) {
              widest = width
              this.minWidth = contentWidth
              this.minWidthFrom = pos
              this.minWidthTo = end
            }
          }
        }
      }
      pos = end + child.breakAfter
    }
    return result
  }

  textDirectionAt(pos: number) {
    let {i} = this.childPos(pos, 1)
    return getComputedStyle(this.children[i].dom!).direction == "rtl" ? Direction.RTL : Direction.LTR
  }

  measureTextSize(): {lineHeight: number, charWidth: number, textHeight: number} {
    for (let child of this.children) {
      if (child instanceof LineView) {
        let measure = child.measureTextSize()
        if (measure) return measure
      }
    }
    // If no workable line exists, force a layout of a measurable element
    let dummy = document.createElement("div"), lineHeight!: number, charWidth!: number, textHeight!: number
    dummy.className = "cm-line"
    dummy.style.width = "99999px"
    dummy.style.position = "absolute"
    dummy.textContent = "abc def ghi jkl mno pqr stu"
    this.view.observer.ignore(() => {
      this.dom.appendChild(dummy)
      let rect = clientRectsFor(dummy.firstChild!)[0]
      lineHeight = dummy.getBoundingClientRect().height
      charWidth = rect ? rect.width / 27 : 7
      textHeight = rect ? rect.height : lineHeight
      dummy.remove()
    })
    return {lineHeight, charWidth, textHeight}
  }

  childCursor(pos: number = this.length): ChildCursor {
    // Move back to start of last element when possible, so that
    // `ChildCursor.findPos` doesn't have to deal with the edge case
    // of being after the last element.
    let i = this.children.length
    if (i) pos -= this.children[--i].length
    return new ChildCursor(this.children, pos, i)
  }

  computeBlockGapDeco(): DecorationSet {
    let deco = [], vs = this.view.viewState
    for (let pos = 0, i = 0;; i++) {
      let next = i == vs.viewports.length ? null : vs.viewports[i]
      let end = next ? next.from - 1 : this.length
      if (end > pos) {
        let height = (vs.lineBlockAt(end).bottom - vs.lineBlockAt(pos).top) / this.view.scaleY
        deco.push(Decoration.replace({
          widget: new BlockGapWidget(height),
          block: true,
          inclusive: true,
          isBlockGap: true,
        }).range(pos, end))
      }
      if (!next) break
      pos = next.to + 1
    }
    return Decoration.set(deco)
  }

  updateDeco() {
    let i = 1
    let allDeco = this.view.state.facet(decorationsFacet).map(d => {
      let dynamic = this.dynamicDecorationMap[i++] = typeof d == "function"
      return dynamic ? (d as (view: EditorView) => DecorationSet)(this.view) : d as DecorationSet
    })
    let dynamicOuter = false, outerDeco = this.view.state.facet(outerDecorations).map((d, i) => {
      let dynamic = typeof d == "function"
      if (dynamic) dynamicOuter = true
      return dynamic ? (d as (view: EditorView) => DecorationSet)(this.view) : d as DecorationSet
    })
    if (outerDeco.length) {
      this.dynamicDecorationMap[i++] = dynamicOuter
      allDeco.push(RangeSet.join(outerDeco))
    }
    this.decorations = [
      this.editContextFormatting,
      ...allDeco,
      this.computeBlockGapDeco(),
      this.view.viewState.lineGapDeco
    ]
    while (i < this.decorations.length) this.dynamicDecorationMap[i++] = false
    return this.decorations
  }

  scrollIntoView(target: ScrollTarget) {
    if (target.isSnapshot) {
      let ref = this.view.viewState.lineBlockAt(target.range.head)
      this.view.scrollDOM.scrollTop = ref.top - target.yMargin
      this.view.scrollDOM.scrollLeft = target.xMargin
      return
    }

    for (let handler of this.view.state.facet(scrollHandler)) {
      try { if (handler(this.view, target.range, target)) return true }
      catch(e) { logException(this.view.state, e, "scroll handler") }
    }

    let {range} = target
    let rect = this.coordsAt(range.head, range.empty ? range.assoc : range.head > range.anchor ? -1 : 1), other
    if (!rect) return
    if (!range.empty && (other = this.coordsAt(range.anchor, range.anchor > range.head ? -1 : 1)))
      rect = {left: Math.min(rect.left, other.left), top: Math.min(rect.top, other.top),
              right: Math.max(rect.right, other.right), bottom: Math.max(rect.bottom, other.bottom)}

    let margins = getScrollMargins(this.view)
    let targetRect = {
      left: rect.left - margins.left, top: rect.top - margins.top,
      right: rect.right + margins.right, bottom: rect.bottom + margins.bottom
    }
    let {offsetWidth, offsetHeight} = this.view.scrollDOM
    scrollRectIntoView(this.view.scrollDOM, targetRect, range.head < range.anchor ? -1 : 1,
                       target.x, target.y,
                       Math.max(Math.min(target.xMargin, offsetWidth), -offsetWidth),
                       Math.max(Math.min(target.yMargin, offsetHeight), -offsetHeight),
                       this.view.textDirection == Direction.LTR)
  }

  // Will never be called but needs to be present
  split!: () => ContentView
}

function betweenUneditable(pos: DOMPos) {
  return pos.node.nodeType == 1 && pos.node.firstChild &&
    (pos.offset == 0 || (pos.node.childNodes[pos.offset - 1] as HTMLElement).contentEditable == "false") &&
    (pos.offset == pos.node.childNodes.length || (pos.node.childNodes[pos.offset] as HTMLElement).contentEditable == "false")
}

export function findCompositionNode(view: EditorView, headPos: number): {from: number, to: number, node: Text} | null {
  let sel = view.observer.selectionRange
  if (!sel.focusNode) return null
  let textBefore = textNodeBefore(sel.focusNode, sel.focusOffset)
  let textAfter = textNodeAfter(sel.focusNode, sel.focusOffset)
  let textNode = textBefore || textAfter
  if (textAfter && textBefore && textAfter.node != textBefore.node) {
    let descAfter = ContentView.get(textAfter.node)
    if (!descAfter || descAfter instanceof TextView && descAfter.text != textAfter.node.nodeValue) {
      textNode = textAfter
    } else if (view.docView.lastCompositionAfterCursor) {
      let descBefore = ContentView.get(textBefore.node)
      if (!(!descBefore || descBefore instanceof TextView && descBefore.text != textBefore.node.nodeValue))
        textNode = textAfter
    }
  }
  view.docView.lastCompositionAfterCursor = textNode != textBefore

  if (!textNode) return null
  let from = headPos - textNode.offset
  return {from, to: from + textNode.node.nodeValue!.length, node: textNode.node}
}

function findCompositionRange(view: EditorView, changes: ChangeSet, headPos: number): Composition | null {
  let found = findCompositionNode(view, headPos)
  if (!found) return null
  let {node: textNode, from, to} = found, text = textNode.nodeValue!
  // Don't try to preserve multi-line compositions
  if (/[\n\r]/.test(text)) return null
  if (view.state.doc.sliceString(found.from, found.to) != text) return null

  let inv = changes.invertedDesc
  let range = new ChangedRange(inv.mapPos(from), inv.mapPos(to), from, to)
  let marks: {node: HTMLElement, deco: MarkDecoration}[] = []
  for (let parent = textNode.parentNode as HTMLElement;; parent = parent.parentNode as HTMLElement) {
    let parentView = ContentView.get(parent)
    if (parentView instanceof MarkView)
      marks.push({node: parent, deco: parentView.mark})
    else if (parentView instanceof LineView || parent.nodeName == "DIV" && parent.parentNode == view.contentDOM)
      return {range, text: textNode, marks, line: parent as HTMLElement}
    else if (parent != view.contentDOM)
      marks.push({node: parent, deco: new MarkDecoration({
        inclusive: true,
        attributes: getAttrs(parent),
        tagName: parent.tagName.toLowerCase()
      })})
    else
      return null
  }
}

const enum NextTo { Before = 1, After = 2 }

function nextToUneditable(node: Node, offset: number) {
  if (node.nodeType != 1) return 0
  return (offset && (node.childNodes[offset - 1] as any).contentEditable == "false" ? NextTo.Before : 0) |
    (offset < node.childNodes.length && (node.childNodes[offset] as any).contentEditable == "false" ? NextTo.After : 0)
}

class DecorationComparator {
  changes: number[] = []
  compareRange(from: number, to: number) { addRange(from, to, this.changes) }
  comparePoint(from: number, to: number) { addRange(from, to, this.changes) }
}

function findChangedDeco(a: readonly DecorationSet[], b: readonly DecorationSet[], diff: ChangeSet) {
  let comp = new DecorationComparator
  RangeSet.compare(a, b, diff, comp)
  return comp.changes
}

function inUneditable(node: Node | null, inside: HTMLElement) {
  for (let cur = node; cur && cur != inside; cur = (cur as HTMLElement).assignedSlot || cur.parentNode) {
    if (cur.nodeType == 1 && (cur as HTMLElement).contentEditable == 'false') {
      return true;
    }
  }
  return false;
}

function touchesComposition(changes: ChangeSet, composition: null | {from: number, to: number}) {
  let touched = false
  if (composition) changes.iterChangedRanges((from, to) => {
    if (from < composition!.to && to > composition!.from) touched = true
  })
  return touched
}
