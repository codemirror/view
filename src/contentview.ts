import {Text} from "@codemirror/text"
import {Rect, maxOffset, domIndex} from "./dom"
import {EditorView} from "./editorview"

// Track mutated / outdated status of a view node's DOM
export const enum Dirty {
  // All synced up
  Not = 0,
  // At least one child is dirty
  Child = 1,
  // The node itself isn't in sync with its child list
  Node = 2,
  // The node's DOM attributes might have changed
  Attrs = 4
}

export class DOMPos {
  constructor(readonly node: Node, readonly offset: number, readonly precise = true) {}

  static before(dom: Node, precise?: boolean) { return new DOMPos(dom.parentNode!, domIndex(dom), precise) }
  static after(dom: Node, precise?: boolean) { return new DOMPos(dom.parentNode!, domIndex(dom) + 1, precise) }
}

export const noChildren: ContentView[] = []

export abstract class ContentView {
  parent: ContentView | null = null
  dom: Node | null = null
  dirty: number = Dirty.Node
  abstract length: number
  abstract children: ContentView[]
  breakAfter!: number

  get editorView(): EditorView {
    if (!this.parent) throw new Error("Accessing view in orphan content view")
    return this.parent.editorView
  }

  get overrideDOMText(): Text | null { return null }

  get posAtStart(): number {
    return this.parent ? this.parent.posBefore(this) : 0
  }

  get posAtEnd(): number {
    return this.posAtStart + this.length
  }

  posBefore(view: ContentView): number {
    let pos = this.posAtStart
    for (let child of this.children) {
      if (child == view) return pos
      pos += child.length + child.breakAfter
    }
    throw new RangeError("Invalid child in posBefore")
  }

  posAfter(view: ContentView): number {
    return this.posBefore(view) + view.length
  }

  // Will return a rectangle directly before (when side < 0), after
  // (side > 0) or directly on (when the browser supports it) the
  // given position.
  coordsAt(_pos: number, _side: number): Rect | null { return null }

  sync(track?: {node: Node, written: boolean}) {
    if (this.dirty & Dirty.Node) {
      let parent = this.dom as HTMLElement
      let pos: Node | null = parent.firstChild
      for (let child of this.children) {
        if (child.dirty) {
          if (!child.dom && pos) {
            let contentView = ContentView.get(pos)
            if (!contentView || !contentView.parent && contentView.constructor == child.constructor)
              child.reuseDOM(pos)
          }
          child.sync(track)
          child.dirty = Dirty.Not
        }
        if (track && !track.written && track.node == parent && pos != child.dom) track.written = true
        if (child.dom!.parentNode == parent) {
          while (pos && pos != child.dom) pos = rm(pos)
          pos = child.dom!.nextSibling
        } else {
          parent.insertBefore(child.dom!, pos)
        }
      }
      if (pos && track && track.node == parent) track.written = true
      while (pos) pos = rm(pos)
    } else if (this.dirty & Dirty.Child) {
      for (let child of this.children) if (child.dirty) {
        child.sync(track)
        child.dirty = Dirty.Not
      }
    }
  }

  reuseDOM(_dom: Node) {}

  abstract domAtPos(pos: number): DOMPos

  localPosFromDOM(node: Node, offset: number): number {
    let after: Node | null
    if (node == this.dom) {
      after = this.dom.childNodes[offset]
    } else {
      let bias = maxOffset(node) == 0 ? 0 : offset == 0 ? -1 : 1
      for (;;) {
        let parent = node.parentNode!
        if (parent == this.dom) break
        if (bias == 0 && parent.firstChild != parent.lastChild) {
          if (node == parent.firstChild) bias = -1
          else bias = 1
        }
        node = parent
      }
      if (bias < 0) after = node
      else after = node.nextSibling
    }
    if (after == this.dom!.firstChild) return 0
    while (after && !ContentView.get(after)) after = after.nextSibling
    if (!after) return this.length

    for (let i = 0, pos = 0;; i++) {
      let child = this.children[i]
      if (child.dom == after) return pos
      pos += child.length + child.breakAfter
    }
  }

  domBoundsAround(from: number, to: number, offset = 0): {
    startDOM: Node | null,
    endDOM: Node | null,
    from: number,
    to: number
  } | null {
    let fromI = -1, fromStart = -1, toI = -1, toEnd = -1
    for (let i = 0, pos = offset, prevEnd = offset; i < this.children.length; i++) {
      let child = this.children[i], end = pos + child.length
      if (pos < from && end > to) return child.domBoundsAround(from, to, pos)
      if (end >= from && fromI == -1) {
        fromI = i
        fromStart = pos
      }
      if (pos > to && child.dom!.parentNode == this.dom) {
        toI = i
        toEnd = prevEnd
        break
      }
      prevEnd = end
      pos = end + child.breakAfter
    }

    return {from: fromStart, to: toEnd < 0 ? offset + this.length : toEnd,
            startDOM: (fromI ? this.children[fromI - 1].dom!.nextSibling : null) || this.dom!.firstChild,
            endDOM: toI < this.children.length && toI >= 0 ? this.children[toI].dom : null}
  }

  markDirty(andParent: boolean = false) {
    this.dirty |= Dirty.Node
    this.markParentsDirty(andParent)
  }

  markParentsDirty(childList: boolean) {
    for (let parent = this.parent; parent; parent = parent.parent) {
      if (childList) parent.dirty |= Dirty.Node
      if (parent.dirty & Dirty.Child) return
      parent.dirty |= Dirty.Child
      childList = false
    }
  }

  setParent(parent: ContentView) {
    if (this.parent != parent) {
      this.parent = parent
      if (this.dirty) this.markParentsDirty(true)
    }
  }

  setDOM(dom: Node) {
    if (this.dom) (this.dom as any).cmView = null
    this.dom = dom
    ;(dom as any).cmView = this
  }

  get rootView(): ContentView {
    for (let v: ContentView = this;;) {
      let parent = v.parent
      if (!parent) return v
      v = parent
    }
  }

  replaceChildren(from: number, to: number, children: ContentView[] = noChildren) {
    this.markDirty()
    for (let i = from; i < to; i++) {
      let child = this.children[i]
      if (child.parent == this) child.destroy()
    }
    this.children.splice(from, to - from, ...children)
    for (let i = 0; i < children.length; i++) children[i].setParent(this)
  }

  ignoreMutation(_rec: MutationRecord): boolean { return false }
  ignoreEvent(_event: Event): boolean { return false }

  childCursor(pos: number = this.length) {
    return new ChildCursor(this.children, pos, this.children.length)
  }

  childPos(pos: number, bias: number = 1): {i: number, off: number} {
    return this.childCursor().findPos(pos, bias)
  }

  toString() {
    let name = this.constructor.name.replace("View", "")
    return name + (this.children.length ? "(" + this.children.join() + ")" :
                   this.length ? "[" + (name == "Text" ? (this as any).text : this.length) + "]" : "") +
      (this.breakAfter ? "#" : "")
  }

  static get(node: Node): ContentView | null { return (node as any).cmView }

  get isEditable() { return true }

  merge(from: number, to: number, source: ContentView | null, hasStart: boolean, openStart: number, openEnd: number): boolean {
    return false
  }

  become(other: ContentView): boolean { return false }

  abstract split(at: number): ContentView

  // When this is a zero-length view with a side, this should return a
  // number <= 0 to indicate it is before its position, or a
  // number > 0 when after its position.
  getSide() { return 0 }

  destroy() {
    this.parent = null
  }
}

ContentView.prototype.breakAfter = 0

// Remove a DOM node and return its next sibling.
function rm(dom: Node): Node | null {
  let next = dom.nextSibling
  dom.parentNode!.removeChild(dom)
  return next
}

export class ChildCursor {
  off: number = 0

  constructor(public children: readonly ContentView[], public pos: number, public i: number) {}

  findPos(pos: number, bias: number = 1): this {
    for (;;) {
      if (pos > this.pos || pos == this.pos &&
          (bias > 0 || this.i == 0 || this.children[this.i - 1].breakAfter)) {
        this.off = pos - this.pos
        return this
      }
      let next = this.children[--this.i]
      this.pos -= next.length + next.breakAfter
    }
  }
}

export function replaceRange(parent: ContentView, fromI: number, fromOff: number, toI: number, toOff: number,
                             insert: ContentView[], breakAtStart: number, openStart: number, openEnd: number) {
  let {children} = parent
  let before = children.length ? children[fromI] : null
  let last = insert.length ? insert[insert.length - 1] : null
  let breakAtEnd = last ? last.breakAfter : breakAtStart
  // Change within a single child
  if (fromI == toI && before && !breakAtStart && !breakAtEnd && insert.length < 2 &&
      before.merge(fromOff, toOff, insert.length ? last : null, fromOff == 0, openStart, openEnd))
    return

  if (toI < children.length) {
    let after = children[toI]
    // Make sure the end of the child after the update is preserved in `after`
    if (after && toOff < after.length) {
      // If we're splitting a child, separate part of it to avoid that
      // being mangled when updating the child before the update.
      if (fromI == toI) {
        after = after.split(toOff)
        toOff = 0
      }
      // If the element after the replacement should be merged with
      // the last replacing element, update `content`
      if (!breakAtEnd && last && after.merge(0, toOff, last, true, 0, openEnd)) {
        insert[insert.length - 1] = after
      } else {
        // Remove the start of the after element, if necessary, and
        // add it to `content`.
        if (toOff) after.merge(0, toOff, null, false, 0, openEnd)
        insert.push(after)
      }
    } else if (after?.breakAfter) {
      // The element at `toI` is entirely covered by this range.
      // Preserve its line break, if any.
      if (last) last.breakAfter = 1
      else breakAtStart = 1
    }
    // Since we've handled the next element from the current elements
    // now, make sure `toI` points after that.
    toI++
  }

  if (before) {
    before.breakAfter = breakAtStart
    if (fromOff > 0) {
      if (!breakAtStart && insert.length && before.merge(fromOff, before.length, insert[0], false, openStart, 0)) {
        before.breakAfter = insert.shift()!.breakAfter
      } else if (fromOff < before.length || before.children.length && before.children[before.children.length - 1].length == 0) {
        before.merge(fromOff, before.length, null, false, openStart, 0)
      }
      fromI++
    }
  }

  // Try to merge widgets on the boundaries of the replacement
  while (fromI < toI && insert.length) {
    if (children[toI - 1].become(insert[insert.length - 1])) {
      toI--
      insert.pop()
      openEnd = insert.length ? 0 : openStart
    } else if (children[fromI].become(insert[0])) {
      fromI++
      insert.shift()
      openStart = insert.length ? 0 : openEnd
    } else {
      break
    }
  }
  if (!insert.length && fromI && toI < children.length && !children[fromI - 1].breakAfter &&
      children[toI].merge(0, 0, children[fromI - 1], false, openStart, openEnd))
    fromI--

  if (fromI < toI || insert.length) parent.replaceChildren(fromI, toI, insert)
}

export function mergeChildrenInto(parent: ContentView, from: number, to: number,
                                  insert: ContentView[], openStart: number, openEnd: number) {
  let cur = parent.childCursor()
  let {i: toI, off: toOff} = cur.findPos(to, 1)
  let {i: fromI, off: fromOff} = cur.findPos(from, -1)
  let dLen = from - to
  for (let view of insert) dLen += view.length
  parent.length += dLen

  replaceRange(parent, fromI, fromOff, toI, toOff, insert, 0, openStart, openEnd)
}
