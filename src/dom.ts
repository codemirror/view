export function getSelection(root: DocumentOrShadowRoot): Selection {
  let target
  // Browsers differ on whether shadow roots have a getSelection
  // method. If it exists, use that, otherwise, call it on the
  // document.
  if ((root as any).nodeType == 11) { // Shadow root
    target = (root as any).getSelection ? root as Document : (root as ShadowRoot).ownerDocument
  } else {
    target = root as Document
  }
  return target.getSelection()!
}

export type SelectionRange = {
  focusNode: Node | null, focusOffset: number,
  anchorNode: Node | null, anchorOffset: number
}

export function contains(dom: HTMLElement, node: Node | null) {
  return node ? dom.contains(node.nodeType != 1 ? node.parentNode : node) : false
}

export function deepActiveElement() {
  let elt = document.activeElement
  while (elt && elt.shadowRoot) elt = elt.shadowRoot.activeElement
  return elt
}

export function hasSelection(dom: HTMLElement, selection: SelectionRange): boolean {
  if (!selection.anchorNode) return false
  try {
    // Firefox will raise 'permission denied' errors when accessing
    // properties of `sel.anchorNode` when it's in a generated CSS
    // element.
    return contains(dom, selection.anchorNode)
  } catch(_) {
    return false
  }
}

export function clientRectsFor(dom: Node) {
  if (dom.nodeType == 3)
    return textRange(dom as Text, 0, dom.nodeValue!.length).getClientRects()
  else if (dom.nodeType == 1)
    return (dom as HTMLElement).getClientRects()
  else
    return [] as any as DOMRectList
}

// Scans forward and backward through DOM positions equivalent to the
// given one to see if the two are in the same place (i.e. after a
// text node vs at the end of that text node)
export function isEquivalentPosition(node: Node, off: number, targetNode: Node | null, targetOff: number): boolean {
  return targetNode ? (scanFor(node, off, targetNode, targetOff, -1) ||
                       scanFor(node, off, targetNode, targetOff, 1)) : false
}

export function domIndex(node: Node): number {
  for (var index = 0;; index++) {
    node = node.previousSibling!
    if (!node) return index
  }
}

function scanFor(node: Node, off: number, targetNode: Node, targetOff: number, dir: -1 | 1): boolean {
  for (;;) {
    if (node == targetNode && off == targetOff) return true
    if (off == (dir < 0 ? 0 : maxOffset(node))) {
      if (node.nodeName == "DIV") return false
      let parent = node.parentNode
      if (!parent || parent.nodeType != 1) return false
      off = domIndex(node) + (dir < 0 ? 0 : 1)
      node = parent
    } else if (node.nodeType == 1) {
      node = node.childNodes[off + (dir < 0 ? -1 : 0)]
      if (node.nodeType == 1 && (node as HTMLElement).contentEditable == "false") return false
      off = dir < 0 ? maxOffset(node) : 0
    } else {
      return false
    }
  }
}

export function maxOffset(node: Node): number {
  return node.nodeType == 3 ? node.nodeValue!.length : node.childNodes.length
}

/// Basic rectangle type.
export interface Rect {
  readonly left: number
  readonly right: number
  readonly top: number
  readonly bottom: number
}

export const Rect0 = {left: 0, right: 0, top: 0, bottom: 0}

export function flattenRect(rect: Rect, left: boolean) {
  let x = left ? rect.left : rect.right
  return {left: x, right: x, top: rect.top, bottom: rect.bottom}
}

function windowRect(win: Window): Rect {
  return {left: 0, right: win.innerWidth,
          top: 0, bottom: win.innerHeight}
}

const ScrollSpace = 5

export function scrollRectIntoView(dom: HTMLElement, rect: Rect, side: -1 | 1) {
  let doc = dom.ownerDocument!, win = doc.defaultView!

  for (let cur: any = dom.parentNode; cur;) {
    if (cur.nodeType == 1) { // Element
      let bounding: Rect, top = cur == doc.body
      if (top) {
        bounding = windowRect(win)
      } else {
        if (cur.scrollHeight <= cur.clientHeight && cur.scrollWidth <= cur.clientWidth) {
          cur = cur.parentNode
          continue
        }
        let rect = cur.getBoundingClientRect()
        // Make sure scrollbar width isn't included in the rectangle
        bounding = {left: rect.left, right: rect.left + cur.clientWidth,
                    top: rect.top, bottom: rect.top + cur.clientHeight}
      }

      let moveX = 0, moveY = 0
      if (rect.top < bounding.top) {
        moveY = -(bounding.top - rect.top + ScrollSpace)
        if (side > 0 && rect.bottom > bounding.bottom + moveY)
          moveY = rect.bottom - bounding.bottom + moveY + ScrollSpace
      } else if (rect.bottom > bounding.bottom) {
        moveY = rect.bottom - bounding.bottom + ScrollSpace
        if (side < 0 && (rect.top - moveY) < bounding.top)
          moveY = -(bounding.top + moveY - rect.top + ScrollSpace)
      }
      if (rect.left < bounding.left) {
        moveX = -(bounding.left - rect.left + ScrollSpace)
        if (side > 0 && rect.right > bounding.right + moveX)
          moveX = rect.right - bounding.right + moveX + ScrollSpace
      } else if (rect.right > bounding.right) {
        moveX = rect.right - bounding.right + ScrollSpace
        if (side < 0 && rect.left < bounding.left + moveX)
          moveX = -(bounding.left + moveX - rect.left + ScrollSpace)
      }
      if (moveX || moveY) {
        if (top) {
          win.scrollBy(moveX, moveY)
        } else {
          if (moveY) {
            let start = cur.scrollTop
            cur.scrollTop += moveY
            moveY = cur.scrollTop - start
          }
          if (moveX) {
            let start = cur.scrollLeft
            cur.scrollLeft += moveX
            moveX = cur.scrollLeft - start
          }
          rect = {left: rect.left - moveX, top: rect.top - moveY,
                  right: rect.right - moveX, bottom: rect.bottom - moveY} as ClientRect
        }
      }
      if (top) break
      cur = cur.assignedSlot || cur.parentNode
    } else if (cur.nodeType == 11) { // A shadow root
      cur = cur.host
    } else {
      break
    }
  }
}

export class DOMSelection {
  anchorNode: Node | null = null
  anchorOffset: number = 0
  focusNode: Node | null = null
  focusOffset: number = 0

  eq(domSel: SelectionRange): boolean {
    return this.anchorNode == domSel.anchorNode && this.anchorOffset == domSel.anchorOffset &&
      this.focusNode == domSel.focusNode && this.focusOffset == domSel.focusOffset
  }

  set(domSel: SelectionRange) {
    this.anchorNode = domSel.anchorNode; this.anchorOffset = domSel.anchorOffset
    this.focusNode = domSel.focusNode; this.focusOffset = domSel.focusOffset
  }
}

let preventScrollSupported: null | false | {preventScroll: boolean} = null
// Feature-detects support for .focus({preventScroll: true}), and uses
// a fallback kludge when not supported.
export function focusPreventScroll(dom: HTMLElement) {
  if ((dom as any).setActive) return (dom as any).setActive() // in IE
  if (preventScrollSupported) return dom.focus(preventScrollSupported)

  let stack = []
  for (let cur: Node | null = dom; cur; cur = cur.parentNode) {
    stack.push(cur, (cur as any).scrollTop, (cur as any).scrollLeft)
    if (cur == cur.ownerDocument) break
  }
  dom.focus(preventScrollSupported == null ? {
    get preventScroll() {
      preventScrollSupported = {preventScroll: true}
      return true
    }
  } : undefined)
  if (!preventScrollSupported) {
    preventScrollSupported = false
    for (let i = 0; i < stack.length;) {
      let elt = stack[i++] as HTMLElement, top = stack[i++] as number, left = stack[i++] as number
      if (elt.scrollTop != top) elt.scrollTop = top
      if (elt.scrollLeft != left) elt.scrollLeft = left
    }
  }
}

let scratchRange: Range | null

export function textRange(node: Text, from: number, to = from) {
  let range = scratchRange || (scratchRange = document.createRange())
  range.setEnd(node, to)
  range.setStart(node, from)
  return range
}

export function dispatchKey(elt: HTMLElement, name: string, code: number): boolean {
  let options = {key: name, code: name, keyCode: code, which: code, cancelable: true}
  let down = new KeyboardEvent("keydown", options)
  ;(down as any).synthetic = true
  elt.dispatchEvent(down)
  let up = new KeyboardEvent("keyup", options)
  ;(up as any).synthetic = true
  elt.dispatchEvent(up)
  return down.defaultPrevented || up.defaultPrevented
}

let _plainTextSupported: boolean | null = null
export function contentEditablePlainTextSupported() {
  if (_plainTextSupported == null) {
    _plainTextSupported = false
    let dummy = document.createElement("div")
    try {
      dummy.contentEditable = "plaintext-only"
      _plainTextSupported = dummy.contentEditable == "plaintext-only"
    } catch(_) {}
  }
  return _plainTextSupported
}

export function getRoot(node: Node | null | undefined): DocumentOrShadowRoot | null {
  while (node) {
    node = (node as HTMLElement).assignedSlot || node.parentNode
    if (node && (node.nodeType == 9 || node.nodeType == 11 && (node as ShadowRoot).host))
      return node as unknown as DocumentOrShadowRoot
  }
  return null
}
