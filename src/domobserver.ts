import browser from "./browser"
import {ContentView, Dirty} from "./contentview"
import {EditorView} from "./editorview"
import {editable} from "./extension"
import {hasSelection, getSelection, DOMSelection, isEquivalentPosition, SelectionRange, deepActiveElement} from "./dom"

const observeOptions = {
  childList: true,
  characterData: true,
  subtree: true,
  attributes: true,
  characterDataOldValue: true
}

// IE11 has very broken mutation observers, so we also listen to
// DOMCharacterDataModified there
const useCharData = browser.ie && browser.ie_version <= 11

export class DOMObserver {
  dom: HTMLElement

  observer: MutationObserver
  active: boolean = false
  ignoreSelection: DOMSelection = new DOMSelection

  delayedFlush = -1
  queue: MutationRecord[] = []
  lastFlush = 0

  onCharData: any

  scrollTargets: HTMLElement[] = []
  intersection: IntersectionObserver | null = null
  intersecting: boolean = false
  gapIntersection: IntersectionObserver | null = null
  gaps: readonly HTMLElement[] = []

  // Used to work around a Safari Selection/shadow DOM bug (#414)
  _selectionRange: SelectionRange | null = null

  // Timeout for scheduling check of the parents that need scroll handlers
  parentCheck = -1

  constructor(private view: EditorView,
              private onChange: (from: number, to: number, typeOver: boolean) => void,
              private onScrollChanged: (event: Event) => void) {
    this.dom = view.contentDOM
    this.observer = new MutationObserver(mutations => {
      for (let mut of mutations) this.queue.push(mut)
      this._selectionRange = null
      // IE11 will sometimes (on typing over a selection or
      // backspacing out a single character text node) call the
      // observer callback before actually updating the DOM.
      //
      // Unrelatedly, iOS Safari will, when ending a composition,
      // sometimes first clear it, deliver the mutations, and then
      // reinsert the finished text. CodeMirror's handling of the
      // deletion will prevent the reinsertion from happening,
      // breaking composition.
      if ((browser.ie && browser.ie_version <= 11 || browser.ios && view.composing) &&
          mutations.some(m => m.type == "childList" && m.removedNodes.length ||
                         m.type == "characterData" && m.oldValue!.length > m.target.nodeValue!.length))
        this.flushSoon()
      else
        this.flush()
    })

    if (useCharData)
      this.onCharData = (event: MutationEvent) => {
        this.queue.push({target: event.target,
                         type: "characterData",
                         oldValue: event.prevValue} as MutationRecord)
        this.flushSoon()
      }

    this.onSelectionChange = this.onSelectionChange.bind(this)
    this.start()

    this.onScroll = this.onScroll.bind(this)
    window.addEventListener("scroll", this.onScroll)
    if (typeof IntersectionObserver == "function") {
      this.intersection = new IntersectionObserver(entries => {
        if (this.parentCheck < 0) this.parentCheck = setTimeout(this.listenForScroll.bind(this), 1000)
        if (entries.length > 0 && entries[entries.length - 1].intersectionRatio > 0 != this.intersecting) {
          this.intersecting = !this.intersecting
          if (this.intersecting != this.view.inView)
            this.onScrollChanged(document.createEvent("Event"))
        }
      }, {})
      this.intersection.observe(this.dom)
      this.gapIntersection = new IntersectionObserver(entries => {
        if (entries.length > 0 && entries[entries.length - 1].intersectionRatio > 0)
          this.onScrollChanged(document.createEvent("Event"));
      }, {})
    }
    this.listenForScroll()
  }

  onScroll(e: Event) {
    if (this.intersecting) this.flush()
    this.onScrollChanged(e)
  }

  updateGaps(gaps: readonly HTMLElement[]) {
    if (this.gapIntersection && (gaps.length != this.gaps.length || this.gaps.some((g, i) => g != gaps[i]))) {
      this.gapIntersection.disconnect()
      for (let gap of gaps) this.gapIntersection.observe(gap)
      this.gaps = gaps
    }
  }

  onSelectionChange(event: Event) {
    if (this.lastFlush < Date.now() - 50) this._selectionRange = null
    let {view} = this, sel = this.selectionRange
    if (view.state.facet(editable) ? view.root.activeElement != this.dom : !hasSelection(view.dom, sel))
      return
    let context = sel.anchorNode && view.docView.nearest(sel.anchorNode)
    if (context && context.ignoreEvent(event)) return

    // Deletions on IE11 fire their events in the wrong order, giving
    // us a selection change event before the DOM changes are
    // reported.
    // (Selection.isCollapsed isn't reliable on IE)
    if (browser.ie && browser.ie_version <= 11 && !view.state.selection.main.empty &&
      sel.focusNode && isEquivalentPosition(sel.focusNode, sel.focusOffset, sel.anchorNode, sel.anchorOffset))
      this.flushSoon()
    else
      this.flush()
  }

  get selectionRange(): SelectionRange {
    if (!this._selectionRange) {
      let {root} = this.view, sel: SelectionRange = getSelection(root)
      // The Selection object is broken in shadow roots in Safari. See
      // https://github.com/codemirror/codemirror.next/issues/414
      if (browser.safari && (root as any).nodeType == 11 && deepActiveElement() == this.view.contentDOM)
        sel = safariSelectionRangeHack(this.view) || sel
      this._selectionRange = sel
    }
    return this._selectionRange
  }

  setSelectionRange(anchor: {node: Node, offset: number}, head: {node: Node, offset: number}) {
    if (!(this._selectionRange as any)?.type)
      this._selectionRange = {anchorNode: anchor.node, anchorOffset: anchor.offset,
                              focusNode: head.node, focusOffset: head.offset}
  }

  listenForScroll() {
    this.parentCheck = -1
    let i = 0, changed: HTMLElement[] | null = null
    for (let dom = this.dom as any; dom;) {
      if (dom.nodeType == 1) {
        if (!changed && i < this.scrollTargets.length && this.scrollTargets[i] == dom) i++
        else if (!changed) changed = this.scrollTargets.slice(0, i)
        if (changed) changed.push(dom)
        dom = dom.assignedSlot || dom.parentNode
      } else if (dom.nodeType == 11) { // Shadow root
        dom = dom.host
      } else {
        break
      }
    }
    if (i < this.scrollTargets.length && !changed) changed = this.scrollTargets.slice(0, i)
    if (changed) {
      for (let dom of this.scrollTargets) dom.removeEventListener("scroll", this.onScroll)
      for (let dom of this.scrollTargets = changed) dom.addEventListener("scroll", this.onScroll)
    }
  }

  ignore<T>(f: () => T): T {
    if (!this.active) return f()
    try {
      this.stop()
      return f()
    } finally {
      this.start()
      this.clear()
    }
  }

  start() {
    if (this.active) return
    this.observer.observe(this.dom, observeOptions)
    this.dom.ownerDocument!.addEventListener("selectionchange", this.onSelectionChange)
    if (useCharData)
      this.dom.addEventListener("DOMCharacterDataModified", this.onCharData)
    this.active = true
  }

  stop() {
    if (!this.active) return
    this.active = false
    this.observer.disconnect()
    this.dom.ownerDocument!.removeEventListener("selectionchange", this.onSelectionChange)
    if (useCharData)
      this.dom.removeEventListener("DOMCharacterDataModified", this.onCharData)
  }

  clearSelection() {
    this.ignoreSelection.set(this.selectionRange)
  }

  // Throw away any pending changes
  clear() {
    this.observer.takeRecords()
    this.queue.length = 0
    this.clearSelection()
  }

  flushSoon() {
    if (this.delayedFlush < 0)
      this.delayedFlush = window.setTimeout(() => { this.delayedFlush = -1; this.flush() }, 20)
  }

  forceFlush() {
    if (this.delayedFlush >= 0) {
      window.clearTimeout(this.delayedFlush)
      this.delayedFlush = -1
      this.flush()
    }
  }

  processRecords() {
    let records = this.queue
    for (let mut of this.observer.takeRecords()) records.push(mut)
    if (records.length) this.queue = []

    let from = -1, to = -1, typeOver = false
    for (let record of records) {
      let range = this.readMutation(record)
      if (!range) continue
      if (range.typeOver) typeOver = true
      if (from == -1) {
        ;({from, to} = range)
      } else {
        from = Math.min(range.from, from)
        to = Math.max(range.to, to)
      }
    }
    return {from, to, typeOver}
  }

  // Apply pending changes, if any
  flush() {
    // Completely hold off flushing when pending keys are set—the code
    // managing those will make sure processRecords is called and the
    // view is resynchronized after
    if (this.delayedFlush >= 0 || this.view.inputState.pendingKey) return

    this.lastFlush = Date.now()
    let {from, to, typeOver} = this.processRecords()
    let selection = this.selectionRange
    let newSel = !this.ignoreSelection.eq(selection) && hasSelection(this.dom, selection)
    if (from < 0 && !newSel) return

    let startState = this.view.state
    this.onChange(from, to, typeOver)
    
    // The view wasn't updated
    if (this.view.state == startState) this.view.docView.reset(newSel)
    this.clearSelection()
  }

  readMutation(rec: MutationRecord): {from: number, to: number, typeOver: boolean} | null {
    let cView = this.view.docView.nearest(rec.target)
    if (!cView || cView.ignoreMutation(rec)) return null
    cView.markDirty(rec.type == "attributes")
    if (rec.type == "attributes") cView.dirty |= Dirty.Attrs

    if (rec.type == "childList") {
      let childBefore = findChild(cView, rec.previousSibling || rec.target.previousSibling, -1)
      let childAfter = findChild(cView, rec.nextSibling || rec.target.nextSibling, 1)
      return {from: childBefore ? cView.posAfter(childBefore) : cView.posAtStart,
              to: childAfter ? cView.posBefore(childAfter) : cView.posAtEnd, typeOver: false}
    } else if (rec.type == "characterData") {
      return {from: cView.posAtStart, to: cView.posAtEnd, typeOver: rec.target.nodeValue == rec.oldValue}
    } else {
      return null
    }
  }

  destroy() {
    this.stop()
    if (this.intersection) this.intersection.disconnect()
    if (this.gapIntersection) this.gapIntersection.disconnect()
    for (let dom of this.scrollTargets) dom.removeEventListener("scroll", this.onScroll)
    window.removeEventListener("scroll", this.onScroll)
    clearTimeout(this.parentCheck)
  }
}

function findChild(cView: ContentView, dom: Node | null, dir: number): ContentView | null {
  while (dom) {
    let curView = ContentView.get(dom)
    if (curView && curView.parent == cView) return curView
    let parent = dom.parentNode
    dom = parent != cView.dom ? parent : dir > 0 ? dom.nextSibling : dom.previousSibling
  }
  return null
}

function safariSelectionRangeHack(view: EditorView) {
  let found = null as null | StaticRange
  // Because Safari (at least in 2018-2021) doesn't provide regular
  // access to the selection inside a shadowroot, we have to perform a
  // ridiculous hack to get at it—using `execCommand` to trigger a
  // `beforeInput` event so that we can read the target range from the
  // event.
  function read(event: InputEvent) {
    event.preventDefault()
    event.stopImmediatePropagation()
    found = (event as any).getTargetRanges()[0]
  }
  view.contentDOM.addEventListener("beforeinput", read, true)
  document.execCommand("indent")
  view.contentDOM.removeEventListener("beforeinput", read, true)
  if (!found) return null
  let anchorNode = found!.startContainer, anchorOffset = found!.startOffset
  let focusNode = found!.endContainer, focusOffset = found!.endOffset
  let curAnchor = view.docView.domAtPos(view.state.selection.main.anchor)
  // Since such a range doesn't distinguish between anchor and head,
  // use a heuristic that flips it around if its end matches the
  // current anchor.
  if (isEquivalentPosition(curAnchor.node, curAnchor.offset, focusNode, focusOffset))
    [anchorNode, anchorOffset, focusNode, focusOffset] = [focusNode, focusOffset, anchorNode, anchorOffset]
  return {anchorNode, anchorOffset, focusNode, focusOffset}
}
