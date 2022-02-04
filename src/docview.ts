import {RangeSet} from "@codemirror/rangeset"
import {ChangeSet} from "@codemirror/state"
import {ContentView, ChildCursor, Dirty, DOMPos, replaceRange} from "./contentview"
import {BlockView, LineView, BlockWidgetView} from "./blockview"
import {CompositionView} from "./inlineview"
import {ContentBuilder} from "./buildview"
import browser from "./browser"
import {Decoration, DecorationSet, WidgetType, BlockType, addRange} from "./decoration"
import {clientRectsFor, isEquivalentPosition, maxOffset, Rect, scrollRectIntoView,
        getSelection, hasSelection} from "./dom"
import {ViewUpdate, PluginField, decorations as decorationsFacet,
        editable, ChangedRange, ScrollTarget} from "./extension"
import {EditorView} from "./editorview"
import {Direction} from "./bidi"
import {DOMReader, LineBreakPlaceholder} from "./domreader"

export class DocView extends ContentView {
  children!: BlockView[]

  compositionDeco = Decoration.none
  decorations: readonly DecorationSet[] = []
  pluginDecorationLength = 0

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

  get root() { return this.view.root }

  get editorView() { return this.view }

  get length() { return this.view.state.doc.length }

  constructor(readonly view: EditorView) {
    super()
    this.setDOM(view.contentDOM)
    this.children = [new LineView]
    this.children[0].setParent(this)
    this.updateDeco()
    this.updateInner([new ChangedRange(0, 0, 0, view.state.doc.length)], 0)
  }

  // Update the document view to a given state. scrollIntoView can be
  // used as a hint to compute a new viewport that includes that
  // position, if we know the editor is going to scroll that position
  // into view.
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

    if (this.view.inputState.composing < 0)
      this.compositionDeco = Decoration.none
    else if (update.transactions.length || this.dirty)
      this.compositionDeco = computeCompositionDeco(this.view, update.changes)

    // When the DOM nodes around the selection are moved to another
    // parent, Chrome sometimes reports a different selection through
    // getSelection than the one that it actually shows to the user.
    // This forces a selection update when lines are joined to work
    // around that. Issue #54
    if ((browser.ie || browser.chrome) && !this.compositionDeco.size && update &&
        update.state.doc.lines != update.startState.doc.lines)
      this.forceSelection = true

    let prevDeco = this.decorations, deco = this.updateDeco()
    let decoDiff = findChangedDeco(prevDeco, deco, update.changes)
    changedRanges = ChangedRange.extendWithRanges(changedRanges, decoDiff)

    if (this.dirty == Dirty.Not && changedRanges.length == 0) {
      return false
    } else {
      this.updateInner(changedRanges, update.startState.doc.length)
      if (update.transactions.length) this.lastUpdate = Date.now()
      return true
    }
  }

  // Used by update and the constructor do perform the actual DOM
  // update
  private updateInner(changes: readonly ChangedRange[], oldLength: number) {
    this.view.viewState.mustMeasureContent = true
    this.updateChildren(changes, oldLength)

    let {observer} = this.view
    observer.ignore(() => {
      // Lock the height during redrawing, since Chrome sometimes
      // messes with the scroll position during DOM mutation (though
      // no relayout is triggered and I cannot imagine how it can
      // recompute the scroll position without a layout)
      this.dom.style.height = this.view.viewState.contentHeight + "px"
      this.dom.style.minWidth = this.minWidth ? this.minWidth + "px" : ""
      // Chrome will sometimes, when DOM mutations occur directly
      // around the selection, get confused and report a different
      // selection from the one it displays (issue #218). This tries
      // to detect that situation.
      let track = browser.chrome || browser.ios ? {node: observer.selectionRange.focusNode!, written: false} : undefined
      this.sync(track)
      this.dirty = Dirty.Not
      if (track && (track.written || observer.selectionRange.focusNode != track.node)) this.forceSelection = true
      this.dom.style.height = ""
    })
    let gaps = []
    if (this.view.viewport.from || this.view.viewport.to < this.view.state.doc.length) for (let child of this.children)
      if (child instanceof BlockWidgetView && child.widget instanceof BlockGapWidget) gaps.push(child.dom!)
    observer.updateGaps(gaps)
  }

  private updateChildren(changes: readonly ChangedRange[], oldLength: number) {
    let cursor = this.childCursor(oldLength)
    for (let i = changes.length - 1;; i--) {
      let next = i >= 0 ? changes[i] : null
      if (!next) break
      let {fromA, toA, fromB, toB} = next
      let {content, breakAtStart, openStart, openEnd} = ContentBuilder.build(this.view.state.doc, fromB, toB,
                                                                             this.decorations, this.pluginDecorationLength)
      let {i: toI, off: toOff} = cursor.findPos(toA, 1)
      let {i: fromI, off: fromOff} = cursor.findPos(fromA, -1)
      replaceRange(this, fromI, fromOff, toI, toOff, content, breakAtStart, openStart, openEnd)
    }
  }

  // Sync the DOM selection to this.state.selection
  updateSelection(mustRead = false, fromPointer = false) {
    if (mustRead) this.view.observer.readSelectionRange()
    if (!(fromPointer || this.mayControlSelection()) ||
        browser.ios && this.view.inputState.rapidCompositionStart) return
    let force = this.forceSelection
    this.forceSelection = false

    let main = this.view.state.selection.main
    // FIXME need to handle the case where the selection falls inside a block range
    let anchor = this.domAtPos(main.anchor)
    let head = main.empty ? anchor : this.domAtPos(main.head)

    // Always reset on Firefox when next to an uneditable node to
    // avoid invisible cursor bugs (#111)
    if (browser.gecko && main.empty && betweenUneditable(anchor)) {
      let dummy = document.createTextNode("")
      this.view.observer.ignore(() => anchor.node.insertBefore(dummy, anchor.node.childNodes[anchor.offset] || null))
      anchor = head = new DOMPos(dummy, 0)
      force = true
    }

    let domSel = this.view.observer.selectionRange
    // If the selection is already here, or in an equivalent position, don't touch it
    if (force || !domSel.focusNode ||
        !isEquivalentPosition(anchor.node, anchor.offset, domSel.anchorNode, domSel.anchorOffset) ||
        !isEquivalentPosition(head.node, head.offset, domSel.focusNode, domSel.focusOffset)) {
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
        let rawSel = getSelection(this.root)
        if (main.empty) {
          // Work around https://bugzilla.mozilla.org/show_bug.cgi?id=1612076
          if (browser.gecko) {
            let nextTo = nextToUneditable(anchor.node, anchor.offset)
            if (nextTo && nextTo != (NextTo.Before | NextTo.After)) {
              let text = nearbyTextNode(anchor.node, anchor.offset, nextTo == NextTo.Before ? 1 : -1)
              if (text) anchor = new DOMPos(text, nextTo == NextTo.Before ? 0 : text.nodeValue!.length)
            }
          }
          rawSel.collapse(anchor.node, anchor.offset)
          if (main.bidiLevel != null && (domSel as any).cursorBidiLevel != null)
            (domSel as any).cursorBidiLevel = main.bidiLevel
        } else if (rawSel.extend) {
          // Selection.extend can be used to create an 'inverted' selection
          // (one where the focus is before the anchor), but not all
          // browsers support it yet.
          rawSel.collapse(anchor.node, anchor.offset)
          rawSel.extend(head.node, head.offset)
        } else {
          // Primitive (IE) way
          let range = document.createRange()
          if (main.anchor > main.head) [anchor, head] = [head, anchor]
          range.setEnd(head.node, head.offset)
          range.setStart(anchor.node, anchor.offset)
          rawSel.removeAllRanges()
          rawSel.addRange(range)
        }
      })
      this.view.observer.setSelectionRange(anchor, head)
    }

    this.impreciseAnchor = anchor.precise ? null : new DOMPos(domSel.anchorNode!, domSel.anchorOffset)
    this.impreciseHead = head.precise ? null: new DOMPos(domSel.focusNode!, domSel.focusOffset)
  }

  enforceCursorAssoc() {
    if (this.compositionDeco.size) return
    let cursor = this.view.state.selection.main
    let sel = getSelection(this.root)
    if (!cursor.empty || !cursor.assoc || !sel.modify) return
    let line = LineView.find(this, cursor.head)
    if (!line) return
    let lineStart = line.posAtStart
    if (cursor.head == lineStart || cursor.head == lineStart + line.length) return
    let before = this.coordsAt(cursor.head, -1), after = this.coordsAt(cursor.head, 1)
    if (!before || !after || before.bottom > after.top) return
    let dom = this.domAtPos(cursor.head + cursor.assoc)
    sel.collapse(dom.node, dom.offset)
    sel.modify("move", cursor.assoc < 0 ? "forward" : "backward", "lineboundary")
  }

  mayControlSelection() {
    return this.view.state.facet(editable) ? this.root.activeElement == this.dom
      : hasSelection(this.dom, this.view.observer.selectionRange)
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
    for (let off = this.length, i = this.children.length - 1;; i--) {
      let child = this.children[i], start = off - child.breakAfter - child.length
      if (pos > start ||
          (pos == start && child.type != BlockType.WidgetBefore && child.type != BlockType.WidgetAfter &&
           (!i || side == 2 || this.children[i - 1].breakAfter ||
            (this.children[i - 1].type == BlockType.WidgetBefore && side > -2))))
        return child.coordsAt(pos - start, side)
      off = start
    }
  }

  measureVisibleLineHeights() {
    let result = [], {from, to} = this.view.viewState.viewport
    let contentWidth = this.view.contentDOM.clientWidth
    let isWider = contentWidth > Math.max(this.view.scrollDOM.clientWidth, this.minWidth) + 1
    let widest = -1
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
            let width = this.view.textDirection == Direction.LTR ? rect.right - childRect.left
              : childRect.right - rect.left
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

  measureTextSize(): {lineHeight: number, charWidth: number} {
    for (let child of this.children) {
      if (child instanceof LineView) {
        let measure = child.measureTextSize()
        if (measure) return measure
      }
    }
    // If no workable line exists, force a layout of a measurable element
    let dummy = document.createElement("div"), lineHeight!: number, charWidth!: number
    dummy.className = "cm-line"
    dummy.textContent = "abc def ghi jkl mno pqr stu"
    this.view.observer.ignore(() => {
      this.dom.appendChild(dummy)
      let rect = clientRectsFor(dummy.firstChild!)[0]
      lineHeight = dummy.getBoundingClientRect().height
      charWidth = rect ? rect.width / 27 : 7
      dummy.remove()
    })
    return {lineHeight, charWidth}
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
        let height = vs.lineBlockAt(end).bottom - vs.lineBlockAt(pos).top
        deco.push(Decoration.replace({widget: new BlockGapWidget(height), block: true, inclusive: true}).range(pos, end))
      }
      if (!next) break
      pos = next.to + 1
    }
    return Decoration.set(deco)
  }

  updateDeco() {
    let pluginDecorations = this.view.pluginField(PluginField.decorations)
    this.pluginDecorationLength = pluginDecorations.length
    return this.decorations = [
      ...pluginDecorations,
      ...this.view.state.facet(decorationsFacet),
      this.compositionDeco,
      this.computeBlockGapDeco(),
      this.view.viewState.lineGapDeco
    ]
  }

  scrollIntoView(target: ScrollTarget) {
    let {range} = target
    let rect = this.coordsAt(range.head, range.empty ? range.assoc : range.head > range.anchor ? -1 : 1), other
    if (!rect) return
    if (!range.empty && (other = this.coordsAt(range.anchor, range.anchor > range.head ? -1 : 1)))
      rect = {left: Math.min(rect.left, other.left), top: Math.min(rect.top, other.top),
              right: Math.max(rect.right, other.right), bottom: Math.max(rect.bottom, other.bottom)}

    let mLeft = 0, mRight = 0, mTop = 0, mBottom = 0
    for (let margins of this.view.pluginField(PluginField.scrollMargins)) if (margins) {
      let {left, right, top, bottom} = margins
      if (left != null) mLeft = Math.max(mLeft, left)
      if (right != null) mRight = Math.max(mRight, right)
      if (top != null) mTop = Math.max(mTop, top)
      if (bottom != null) mBottom = Math.max(mBottom, bottom)
    }
    let targetRect = {
      left: rect.left - mLeft, top: rect.top - mTop,
      right: rect.right + mRight, bottom: rect.bottom + mBottom
    }
    scrollRectIntoView(this.view.scrollDOM, targetRect, range.head < range.anchor ? -1 : 1,
                       target.x, target.y, target.xMargin, target.yMargin,
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

class BlockGapWidget extends WidgetType {
  constructor(readonly height: number) { super() }

  toDOM() {
    let elt = document.createElement("div")
    this.updateDOM(elt)
    return elt
  }

  eq(other: BlockGapWidget) { return other.height == this.height }

  updateDOM(elt: HTMLElement) {
    elt.style.height = this.height + "px"
    return true
  }

  get estimatedHeight() { return this.height }
}

export function compositionSurroundingNode(view: EditorView) {
  let sel = view.observer.selectionRange
  let textNode = sel.focusNode && nearbyTextNode(sel.focusNode, sel.focusOffset, 0)
  if (!textNode) return null
  let cView = view.docView.nearest(textNode)
  if (!cView) return null
  if (cView instanceof LineView) {
    let topNode: Node = textNode
    while (topNode.parentNode != cView.dom) topNode = topNode.parentNode!
    let prev = topNode.previousSibling
    while (prev && !ContentView.get(prev)) prev = prev.previousSibling
    let pos = prev ? ContentView.get(prev)!.posAtEnd : cView.posAtStart
    return {from: pos, to: pos, node: topNode, text: textNode}
  } else {
    for (;;) {
      let {parent} = cView
      if (!parent) return null
      if (parent instanceof LineView) break
      cView = parent as ContentView
    }
    let from = cView.posAtStart
    return {from, to: from + cView.length, node: cView.dom!, text: textNode}
  }
}

function computeCompositionDeco(view: EditorView, changes: ChangeSet): DecorationSet {
  let surrounding = compositionSurroundingNode(view)
  if (!surrounding) return Decoration.none
  let {from, to, node, text: textNode} = surrounding

  let newFrom = changes.mapPos(from, 1), newTo = Math.max(newFrom, changes.mapPos(to, -1))
  let {state} = view, text = node.nodeType == 3 ? node.nodeValue! :
    new DOMReader([], state).readRange(node.firstChild, null).text

  if (newTo - newFrom < text.length) {
    if (state.doc.sliceString(newFrom, Math.min(state.doc.length, newFrom + text.length), LineBreakPlaceholder) == text)
      newTo = newFrom + text.length
    else if (state.doc.sliceString(Math.max(0, newTo - text.length), newTo, LineBreakPlaceholder) == text)
      newFrom = newTo - text.length
    else
      return Decoration.none
  } else if (state.doc.sliceString(newFrom, newTo, LineBreakPlaceholder) != text) {
    return Decoration.none
  }

  return Decoration.set(Decoration.replace({widget: new CompositionWidget(node, textNode)}).range(newFrom, newTo))
}

export class CompositionWidget extends WidgetType {
  constructor(readonly top: Node, readonly text: Text) { super() }

  eq(other: CompositionWidget) { return this.top == other.top && this.text == other.text }

  toDOM() { return this.top as HTMLElement }

  ignoreEvent() { return false }

  get customView() { return CompositionView }
}

function nearbyTextNode(node: Node, offset: number, side: number): Text | null {
  for (;;) {
    if (node.nodeType == 3) return node as Text
    if (node.nodeType == 1 && offset > 0 && side <= 0) {
      node = node.childNodes[offset - 1]
      offset = maxOffset(node)
    } else if (node.nodeType == 1 && offset < node.childNodes.length && side >= 0) {
      node = node.childNodes[offset]
      offset = 0
    } else {
      return null
    }
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
