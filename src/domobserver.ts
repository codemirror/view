import browser from "./browser"
import {ContentView, ViewFlag} from "./contentview"
import {EditorView} from "./editorview"
import {editable} from "./extension"
import {hasSelection, getSelection, DOMSelectionState, isEquivalentPosition,
        deepActiveElement, dispatchKey, atElementStart} from "./dom"
import {DOMChange, applyDOMChange} from "./domchange"

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
  win: Window

  observer: MutationObserver
  active: boolean = false

  // The known selection. Kept in our own object, as opposed to just
  // directly accessing the selection because:
  //  - Safari doesn't report the right selection in shadow DOM
  //  - Reading from the selection forces a DOM layout
  //  - This way, we can ignore selectionchange events if we have
  //    already seen the 'new' selection
  selectionRange: DOMSelectionState = new DOMSelectionState
  // Set when a selection change is detected, cleared on flush
  selectionChanged = false

  delayedFlush = -1
  resizeTimeout = -1
  queue: MutationRecord[] = []
  delayedAndroidKey: {key: string, keyCode: number, force: boolean} | null = null
  flushingAndroidKey = -1
  lastChange = 0

  onCharData: any

  scrollTargets: HTMLElement[] = []
  intersection: IntersectionObserver | null = null
  resizeScroll: ResizeObserver | null = null
  intersecting: boolean = false
  gapIntersection: IntersectionObserver | null = null
  gaps: readonly HTMLElement[] = []
  printQuery: MediaQueryList | null = null

  // Timeout for scheduling check of the parents that need scroll handlers
  parentCheck = -1

  constructor(private view: EditorView) {
    this.dom = view.contentDOM
    this.observer = new MutationObserver(mutations => {
      for (let mut of mutations) this.queue.push(mut)
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
    this.onResize = this.onResize.bind(this)
    this.onPrint = this.onPrint.bind(this)
    this.onScroll = this.onScroll.bind(this)

    if (window.matchMedia) this.printQuery = window.matchMedia("print")
    if (typeof ResizeObserver == "function") {
      this.resizeScroll = new ResizeObserver(() => {
        if (this.view.docView?.lastUpdate < Date.now() - 75) this.onResize()
      })
      this.resizeScroll.observe(view.scrollDOM)
    }
    this.addWindowListeners(this.win = view.win)

    this.start()

    if (typeof IntersectionObserver == "function") {
      this.intersection = new IntersectionObserver(entries => {
        if (this.parentCheck < 0) this.parentCheck = setTimeout(this.listenForScroll.bind(this), 1000)
        if (entries.length > 0 && (entries[entries.length - 1].intersectionRatio > 0) != this.intersecting) {
          this.intersecting = !this.intersecting
          if (this.intersecting != this.view.inView)
            this.onScrollChanged(document.createEvent("Event"))
        }
      }, {threshold: [0, .001]})
      this.intersection.observe(this.dom)
      this.gapIntersection = new IntersectionObserver(entries => {
        if (entries.length > 0 && entries[entries.length - 1].intersectionRatio > 0)
          this.onScrollChanged(document.createEvent("Event"));
      }, {})
    }
    this.listenForScroll()
    this.readSelectionRange()
  }

  onScrollChanged(e: Event) {
    this.view.inputState.runHandlers("scroll", e)
    if (this.intersecting) this.view.measure()
  }

  onScroll(e: Event) {
    if (this.intersecting) this.flush(false)
    this.onScrollChanged(e)
  }

  onResize() {
    if (this.resizeTimeout < 0) this.resizeTimeout = setTimeout(() => {
      this.resizeTimeout = -1
      this.view.requestMeasure()
    }, 50)
  }

  onPrint(event: Event) {
    if (event.type == "change" && !(event as MediaQueryListEvent).matches) return
    this.view.viewState.printing = true
    this.view.measure()
    setTimeout(() => {
      this.view.viewState.printing = false
      this.view.requestMeasure()
    }, 500)
  }

  updateGaps(gaps: readonly HTMLElement[]) {
    if (this.gapIntersection && (gaps.length != this.gaps.length || this.gaps.some((g, i) => g != gaps[i]))) {
      this.gapIntersection.disconnect()
      for (let gap of gaps) this.gapIntersection.observe(gap)
      this.gaps = gaps
    }
  }

  onSelectionChange(event: Event) {
    let wasChanged = this.selectionChanged
    if (!this.readSelectionRange() || this.delayedAndroidKey) return
    let {view} = this, sel = this.selectionRange
    if (view.state.facet(editable) ? view.root.activeElement != this.dom : !hasSelection(view.dom, sel))
      return

    let context = sel.anchorNode && view.docView.nearest(sel.anchorNode)
    if (context && context.ignoreEvent(event)) {
      if (!wasChanged) this.selectionChanged = false
      return
    }

    // Deletions on IE11 fire their events in the wrong order, giving
    // us a selection change event before the DOM changes are
    // reported.
    // Chrome Android has a similar issue when backspacing out a
    // selection (#645).
    if ((browser.ie && browser.ie_version <= 11 || browser.android && browser.chrome) && !view.state.selection.main.empty &&
        // (Selection.isCollapsed isn't reliable on IE)
        sel.focusNode && isEquivalentPosition(sel.focusNode, sel.focusOffset, sel.anchorNode, sel.anchorOffset))
      this.flushSoon()
    else
      this.flush(false)
  }

  readSelectionRange() {
    let {view} = this
    // The Selection object is broken in shadow roots in Safari. See
    // https://github.com/codemirror/dev/issues/414
    let selection = getSelection(view.root)
    if (!selection) return false
    let range = browser.safari && (view.root as any).nodeType == 11 &&
      deepActiveElement(this.dom.ownerDocument) == this.dom &&
      safariSelectionRangeHack(this.view, selection) || selection
    if (!range || this.selectionRange.eq(range)) return false
    let local = hasSelection(this.dom, range)
    // Detect the situation where the browser has, on focus, moved the
    // selection to the start of the content element. Reset it to the
    // position from the editor state.
    if (local && !this.selectionChanged &&
        view.inputState.lastFocusTime > Date.now() - 200 &&
        view.inputState.lastTouchTime < Date.now() - 300 &&
        atElementStart(this.dom, range)) {
      this.view.inputState.lastFocusTime = 0
      view.docView.updateSelection()
      return false
    }
    this.selectionRange.setRange(range)
    if (local) this.selectionChanged = true
    return true
  }

  setSelectionRange(anchor: {node: Node, offset: number}, head: {node: Node, offset: number}) {
    this.selectionRange.set(anchor.node, anchor.offset, head.node, head.offset)
    this.selectionChanged = false
  }

  clearSelectionRange() {
    this.selectionRange.set(null, 0, null, 0)
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
    if (useCharData)
      this.dom.addEventListener("DOMCharacterDataModified", this.onCharData)
    this.active = true
  }

  stop() {
    if (!this.active) return
    this.active = false
    this.observer.disconnect()
    if (useCharData)
      this.dom.removeEventListener("DOMCharacterDataModified", this.onCharData)
  }

  // Throw away any pending changes
  clear() {
    this.processRecords()
    this.queue.length = 0
    this.selectionChanged = false
  }

  // Chrome Android, especially in combination with GBoard, not only
  // doesn't reliably fire regular key events, but also often
  // surrounds the effect of enter or backspace with a bunch of
  // composition events that, when interrupted, cause text duplication
  // or other kinds of corruption. This hack makes the editor back off
  // from handling DOM changes for a moment when such a key is
  // detected (via beforeinput or keydown), and then tries to flush
  // them or, if that has no effect, dispatches the given key.
  delayAndroidKey(key: string, keyCode: number) {
    if (!this.delayedAndroidKey) {
      let flush = () => {
        let key = this.delayedAndroidKey
        if (key) {
          this.clearDelayedAndroidKey()
          this.view.inputState.lastKeyCode = key.keyCode
          this.view.inputState.lastKeyTime = Date.now()
          let flushed = this.flush()
          if (!flushed && key.force)
            dispatchKey(this.dom, key.key, key.keyCode)
        }
      }
      this.flushingAndroidKey = this.view.win.requestAnimationFrame(flush)
    }
    // Since backspace beforeinput is sometimes signalled spuriously,
    // Enter always takes precedence.
    if (!this.delayedAndroidKey || key == "Enter")
      this.delayedAndroidKey = {
        key, keyCode,
        // Only run the key handler when no changes are detected if
        // this isn't coming right after another change, in which case
        // it is probably part of a weird chain of updates, and should
        // be ignored if it returns the DOM to its previous state.
        force: this.lastChange < Date.now() - 50 || !!this.delayedAndroidKey?.force
      }
  }

  clearDelayedAndroidKey() {
    this.win.cancelAnimationFrame(this.flushingAndroidKey)
    this.delayedAndroidKey = null
    this.flushingAndroidKey = -1
  }

  flushSoon() {
    if (this.delayedFlush < 0)
      this.delayedFlush = this.view.win.requestAnimationFrame(() => { this.delayedFlush = -1; this.flush() })
  }

  forceFlush() {
    if (this.delayedFlush >= 0) {
      this.view.win.cancelAnimationFrame(this.delayedFlush)
      this.delayedFlush = -1
    }
    this.flush()
  }

  pendingRecords() {
    for (let mut of this.observer.takeRecords()) this.queue.push(mut)
    return this.queue
  }

  processRecords() {
    let records = this.pendingRecords()
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

  readChange() {
    let {from, to, typeOver} = this.processRecords()
    let newSel = this.selectionChanged && hasSelection(this.dom, this.selectionRange)
    if (from < 0 && !newSel) return null
    if (from > -1) this.lastChange = Date.now()
    this.view.inputState.lastFocusTime = 0
    this.selectionChanged = false
    let change = new DOMChange(this.view, from, to, typeOver)
    this.view.docView.domChanged = {newSel: change.newSel ? change.newSel.main : null}
    return change
  }

  // Apply pending changes, if any
  flush(readSelection = true) {
    // Completely hold off flushing when pending keys are set—the code
    // managing those will make sure processRecords is called and the
    // view is resynchronized after
    if (this.delayedFlush >= 0 || this.delayedAndroidKey) return false

    if (readSelection) this.readSelectionRange()

    let domChange = this.readChange()
    if (!domChange) {
      this.view.requestMeasure()
      return false
    }
    let startState = this.view.state
    let handled = applyDOMChange(this.view, domChange)
    // The view wasn't updated
    if (this.view.state == startState) this.view.update([])
    return handled
  }

  readMutation(rec: MutationRecord): {from: number, to: number, typeOver: boolean} | null {
    let cView = this.view.docView.nearest(rec.target)
    if (!cView || cView.ignoreMutation(rec)) return null
    cView.markDirty(rec.type == "attributes")
    if (rec.type == "attributes") cView.flags |= ViewFlag.AttrsDirty

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

  setWindow(win: Window) {
    if (win != this.win) {
      this.removeWindowListeners(this.win)
      this.win = win
      this.addWindowListeners(this.win)
    }
  }

  addWindowListeners(win: Window) {
    win.addEventListener("resize", this.onResize)
    if (this.printQuery) this.printQuery.addEventListener("change", this.onPrint)
    else win.addEventListener("beforeprint", this.onPrint)
    win.addEventListener("scroll", this.onScroll)
    win.document.addEventListener("selectionchange", this.onSelectionChange)
  }

  removeWindowListeners(win: Window) {
    win.removeEventListener("scroll", this.onScroll)
    win.removeEventListener("resize", this.onResize)
    if (this.printQuery) this.printQuery.removeEventListener("change", this.onPrint)
    else win.removeEventListener("beforeprint", this.onPrint)
    win.document.removeEventListener("selectionchange", this.onSelectionChange)
  }

  destroy() {
    this.stop()
    this.intersection?.disconnect()
    this.gapIntersection?.disconnect()
    this.resizeScroll?.disconnect()
    for (let dom of this.scrollTargets) dom.removeEventListener("scroll", this.onScroll)
    this.removeWindowListeners(this.win)
    clearTimeout(this.parentCheck)
    clearTimeout(this.resizeTimeout)
    this.win.cancelAnimationFrame(this.delayedFlush)
    this.win.cancelAnimationFrame(this.flushingAndroidKey)
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

function buildSelectionRangeFromRange(view: EditorView, range: StaticRange) {
  let anchorNode = range.startContainer, anchorOffset = range.startOffset
  let focusNode = range.endContainer, focusOffset = range.endOffset
  let curAnchor = view.docView.domAtPos(view.state.selection.main.anchor)
  // Since such a range doesn't distinguish between anchor and head,
  // use a heuristic that flips it around if its end matches the
  // current anchor.
  if (isEquivalentPosition(curAnchor.node, curAnchor.offset, focusNode, focusOffset))
    [anchorNode, anchorOffset, focusNode, focusOffset] = [focusNode, focusOffset, anchorNode, anchorOffset]
  return {anchorNode, anchorOffset, focusNode, focusOffset}
}

// Used to work around a Safari Selection/shadow DOM bug (#414)
function safariSelectionRangeHack(view: EditorView, selection: Selection) {
  if ((selection as any).getComposedRanges) {
    let range = (selection as any).getComposedRanges(view.root)[0] as StaticRange
    if (range) return buildSelectionRangeFromRange(view, range)
  }

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
  view.dom.ownerDocument.execCommand("indent")
  view.contentDOM.removeEventListener("beforeinput", read, true)
  return found ? buildSelectionRangeFromRange(view, found) : null
}
