import {EditorSelection, EditorState, SelectionRange} from "@codemirror/state"
import {EditorView, DOMEventHandlers} from "./editorview"
import {ContentView} from "./contentview"
import {LineView} from "./blockview"
import {domEventHandlers, ViewUpdate, PluginValue, clickAddsSelectionRange, dragMovesSelection as dragBehavior,
        logException, mouseSelectionStyle} from "./extension"
import browser from "./browser"
import {groupAt} from "./cursor"
import {getSelection, focusPreventScroll, Rect, dispatchKey} from "./dom"

// This will also be where dragging info and such goes
export class InputState {
  lastKeyCode: number = 0
  lastKeyTime: number = 0

  // On iOS, some keys need to have their default behavior happen
  // (after which we retroactively handle them and reset the DOM) to
  // avoid messing up the virtual keyboard state.
  //
  // On Chrome Android, backspace near widgets is just completely
  // broken, and there are no key events, so we need to handle the
  // beforeinput event. Deleting stuff will often create a flurry of
  // events, and interrupting it before it is done just makes
  // subsequent events even more broken, so again, we hold off doing
  // anything until the browser is finished with whatever it is trying
  // to do.
  //
  // setPendingKey sets this, causing the DOM observer to pause for a
  // bit, and setting an animation frame (which seems the most
  // reliable way to detect 'browser is done flailing') to fire a fake
  // key event and re-sync the view again.
  pendingKey: undefined | {key: string, keyCode: number} = undefined

  lastSelectionOrigin: string | null = null
  lastSelectionTime: number = 0
  lastEscPress: number = 0
  lastContextMenu: number = 0
  scrollHandlers: ((event: Event) => boolean | void)[] = []

  registeredEvents: string[] = []
  customHandlers: readonly {
    plugin: PluginValue,
    handlers: DOMEventHandlers<any>
  }[] = []

  // -1 means not in a composition. Otherwise, this counts the number
  // of changes made during the composition. The count is used to
  // avoid treating the start state of the composition, before any
  // changes have been made, as part of the composition.
  composing = -1
  // Tracks whether the next change should be marked as starting the
  // composition (null means no composition, true means next is the
  // first, false means first has already been marked for this
  // composition)
  compositionFirstChange: boolean | null = null
  compositionEndedAt = 0
  rapidCompositionStart = false

  mouseSelection: MouseSelection | null = null

  notifiedFocused: boolean

  setSelectionOrigin(origin: string) {
    this.lastSelectionOrigin = origin
    this.lastSelectionTime = Date.now()
  }

  constructor(view: EditorView) {
    for (let type in handlers) {
      let handler = handlers[type]
      view.contentDOM.addEventListener(type, (event: Event) => {
        if (type == "keydown" && this.keydown(view, event as KeyboardEvent)) return
        if (!eventBelongsToEditor(view, event) || this.ignoreDuringComposition(event)) return
        if (this.mustFlushObserver(event)) view.observer.forceFlush()
        if (this.runCustomHandlers(type, view, event)) event.preventDefault()
        else handler(view, event)
      })
      this.registeredEvents.push(type)
    }
    this.notifiedFocused = view.hasFocus
    this.ensureHandlers(view)
    // On Safari adding an input event handler somehow prevents an
    // issue where the composition vanishes when you press enter.
    if (browser.safari) view.contentDOM.addEventListener("input", () => null)
  }

  ensureHandlers(view: EditorView) {
    let handlers = this.customHandlers = view.pluginField(domEventHandlers)
    for (let set of handlers) {
      for (let type in set.handlers) if (this.registeredEvents.indexOf(type) < 0 && type != "scroll") {
        this.registeredEvents.push(type)
        view.contentDOM.addEventListener(type, (event: Event) => {
          if (!eventBelongsToEditor(view, event)) return
          if (this.runCustomHandlers(type, view, event)) event.preventDefault()
        })
      }
    }
  }

  runCustomHandlers(type: string, view: EditorView, event: Event): boolean {
    for (let set of this.customHandlers) {
      let handler = set.handlers[type], handled: boolean | void = false
      if (handler) {
        try {
          handled = handler.call(set.plugin, event as any, view)
        } catch (e) {
          logException(view.state, e)
        }
        if (handled || event.defaultPrevented) {
          // Chrome for Android often applies a bunch of nonsensical
          // DOM changes after an enter press, even when
          // preventDefault-ed. This tries to ignore those.
          if (browser.android && type == "keydown" && (event as any).keyCode == 13) view.observer.flushSoon()
          return true
        }
      }
    }
    return false
  }

  runScrollHandlers(view: EditorView, event: Event) {
    for (let set of this.customHandlers) {
      let handler = set.handlers.scroll
      if (handler) {
        try { handler.call(set.plugin, event, view) }
        catch (e) { logException(view.state, e) }
      }
    }
  }

  keydown(view: EditorView, event: KeyboardEvent) {
    // Must always run, even if a custom handler handled the event
    this.lastKeyCode = event.keyCode
    this.lastKeyTime = Date.now()
    if (this.screenKeyEvent(view, event as KeyboardEvent)) return true
    // Prevent the default behavior of Enter on iOS makes the
    // virtual keyboard get stuck in the wrong (lowercase)
    // state. So we let it go through, and then, in
    // applyDOMChange, notify key handlers of it and reset to
    // the state they produce.
    let pending
    if (browser.ios && (pending = PendingKeys.find(key => key.keyCode == event.keyCode)) &&
        !(event.ctrlKey || event.altKey || event.metaKey) && !(event as any).synthetic) {
      this.setPendingKey(view, pending)
      return true
    }
    return false
  }

  setPendingKey(view: EditorView, pending: {key: string, keyCode: number}) {
    this.pendingKey = pending
    requestAnimationFrame(() => {
      if (!this.pendingKey) return false
      let key = this.pendingKey
      this.pendingKey = undefined
      view.observer.processRecords()
      let startState = view.state
      dispatchKey(view.contentDOM, key.key, key.keyCode)
      if (view.state == startState) view.docView.reset(true)
    })
  }

  ignoreDuringComposition(event: Event): boolean {
    if (!/^key/.test(event.type)) return false
    if (this.composing > 0) return true
    // See https://www.stum.de/2016/06/24/handling-ime-events-in-javascript/.
    // On some input method editors (IMEs), the Enter key is used to
    // confirm character selection. On Safari, when Enter is pressed,
    // compositionend and keydown events are sometimes emitted in the
    // wrong order. The key event should still be ignored, even when
    // it happens after the compositionend event.
    if (browser.safari && Date.now() - this.compositionEndedAt < 500) {
      this.compositionEndedAt = 0
      return true
    }
    return false
  }

  screenKeyEvent(view: EditorView, event: KeyboardEvent) {
    let protectedTab = event.keyCode == 9 && Date.now() < this.lastEscPress + 2000
    if (event.keyCode == 27) this.lastEscPress = Date.now()
    else if (modifierCodes.indexOf(event.keyCode) < 0) this.lastEscPress = 0
    return protectedTab
  }

  mustFlushObserver(event: Event) {
    return (event.type == "keydown" && (event as any).keyCode != 229) ||
      event.type == "compositionend" && !browser.ios
  }

  startMouseSelection(view: EditorView, event: MouseEvent, style: MouseSelectionStyle) {
    if (this.mouseSelection) this.mouseSelection.destroy()
    this.mouseSelection = new MouseSelection(this, view, event, style)
  }

  update(update: ViewUpdate) {
    if (this.mouseSelection) this.mouseSelection.update(update)
    if (update.transactions.length) this.lastKeyCode = this.lastSelectionTime = 0
  }

  destroy() {
    if (this.mouseSelection) this.mouseSelection.destroy()
  }
}

const PendingKeys = [
  {key: "Backspace", keyCode: 8, inputType: "deleteContentBackward"},
  {key: "Enter", keyCode: 13, inputType: "insertParagraph"},
  {key: "Delete", keyCode: 46, inputType: "deleteContentForward"}
]

// Key codes for modifier keys
export const modifierCodes = [16, 17, 18, 20, 91, 92, 224, 225]

/// Interface that objects registered with
/// [`EditorView.mouseSelectionStyle`](#view.EditorView^mouseSelectionStyle)
/// must conform to.
export interface MouseSelectionStyle {
  /// Return a new selection for the mouse gesture that starts with
  /// the event that was originally given to the constructor, and ends
  /// with the event passed here. In case of a plain click, those may
  /// both be the `mousedown` event, in case of a drag gesture, the
  /// latest `mousemove` event will be passed.
  ///
  /// When `extend` is true, that means the new selection should, if
  /// possible, extend the start selection. If `multiple` is true, the
  /// new selection should be added to the original selection.
  get: (curEvent: MouseEvent, extend: boolean, multiple: boolean) => EditorSelection
  /// Called when the view is updated while the gesture is in
  /// progress. When the document changes, it may be necessary to map
  /// some data (like the original selection or start position)
  /// through the changes.
  ///
  /// This may return `true` to indicate that the `get` method should
  /// get queried again after the update, because something in the
  /// update could change its result. Be wary of infinite loops when
  /// using this (where `get` returns a new selection, which will
  /// trigger `update`, which schedules another `get` in response).
  update: (update: ViewUpdate) => boolean | void
}

export type MakeSelectionStyle = (view: EditorView, event: MouseEvent) => MouseSelectionStyle | null

class MouseSelection {
  dragging: null | false | SelectionRange
  dragMove: boolean
  extend: boolean
  multiple: boolean
  lastEvent: MouseEvent

  constructor(private inputState: InputState, private view: EditorView,
              startEvent: MouseEvent,
              private style: MouseSelectionStyle) {
    this.lastEvent = startEvent
    let doc = view.contentDOM.ownerDocument!
    doc.addEventListener("mousemove", this.move = this.move.bind(this))
    doc.addEventListener("mouseup", this.up = this.up.bind(this))

    this.extend = startEvent.shiftKey
    this.multiple = view.state.facet(EditorState.allowMultipleSelections) && addsSelectionRange(view, startEvent)
    this.dragMove = dragMovesSelection(view, startEvent)
    this.dragging = isInPrimarySelection(view, startEvent) ? null : false
    // When clicking outside of the selection, immediately apply the
    // effect of starting the selection
    if (this.dragging === false) {
      startEvent.preventDefault()
      this.select(startEvent)
    }
  }

  move(event: MouseEvent) {
    if (event.buttons == 0) return this.destroy()
    if (this.dragging !== false) return
    this.select(this.lastEvent = event)
  }

  up(event: MouseEvent) {
    if (this.dragging == null) this.select(this.lastEvent)
    if (!this.dragging) event.preventDefault()
    this.destroy()
  }

  destroy() {
    let doc = this.view.contentDOM.ownerDocument!
    doc.removeEventListener("mousemove", this.move)
    doc.removeEventListener("mouseup", this.up)
    this.inputState.mouseSelection = null
  }

  select(event: MouseEvent) {
    let selection = this.style.get(event, this.extend, this.multiple)
    if (!selection.eq(this.view.state.selection) || selection.main.assoc != this.view.state.selection.main.assoc)
      this.view.dispatch({
        selection,
        userEvent: "select.pointer",
        scrollIntoView: true
      })
  }

  update(update: ViewUpdate) {
    if (update.docChanged && this.dragging) this.dragging = this.dragging.map(update.changes)
    if (this.style.update(update)) setTimeout(() => this.select(this.lastEvent), 20)
  }
}

function addsSelectionRange(view: EditorView, event: MouseEvent) {
  let facet = view.state.facet(clickAddsSelectionRange)
  return facet.length ? facet[0](event) : browser.mac ? event.metaKey : event.ctrlKey
}

function dragMovesSelection(view: EditorView, event: MouseEvent) {
  let facet = view.state.facet(dragBehavior)
  return facet.length ? facet[0](event) : browser.mac ? !event.altKey : !event.ctrlKey
}

function isInPrimarySelection(view: EditorView, event: MouseEvent) {
  let {main} = view.state.selection
  if (main.empty) return false
  // On boundary clicks, check whether the coordinates are inside the
  // selection's client rectangles
  let sel = getSelection(view.root)
  if (sel.rangeCount == 0) return true
  let rects = sel.getRangeAt(0).getClientRects()
  for (let i = 0; i < rects.length; i++) {
    let rect = rects[i]
    if (rect.left <= event.clientX && rect.right >= event.clientX &&
        rect.top <= event.clientY && rect.bottom >= event.clientY) return true
  }
  return false
}

function eventBelongsToEditor(view: EditorView, event: Event): boolean {
  if (!event.bubbles) return true
  if (event.defaultPrevented) return false
  for (let node: Node | null = event.target as Node, cView; node != view.contentDOM; node = node.parentNode)
    if (!node || node.nodeType == 11 || ((cView = ContentView.get(node)) && cView.ignoreEvent(event)))
      return false
  return true
}

const handlers: {[key: string]: (view: EditorView, event: any) => void} = Object.create(null)

// This is very crude, but unfortunately both these browsers _pretend_
// that they have a clipboard API—all the objects and methods are
// there, they just don't work, and they are hard to test.
const brokenClipboardAPI = (browser.ie && browser.ie_version < 15) ||
  (browser.ios && browser.webkit_version < 604)

function capturePaste(view: EditorView) {
  let parent = view.dom.parentNode
  if (!parent) return
  let target = parent.appendChild(document.createElement("textarea"))
  target.style.cssText = "position: fixed; left: -10000px; top: 10px"
  target.focus()
  setTimeout(() => {
    view.focus()
    target.remove()
    doPaste(view, target.value)
  }, 50)
}

function doPaste(view: EditorView, input: string) {
  let {state} = view, changes, i = 1, text = state.toText(input)
  let byLine = text.lines == state.selection.ranges.length
  let linewise = lastLinewiseCopy != null && state.selection.ranges.every(r => r.empty) && lastLinewiseCopy == text.toString()
  if (linewise) {
    let lastLine = -1
    changes = state.changeByRange(range => {
      let line = state.doc.lineAt(range.from)
      if (line.from == lastLine) return {range}
      lastLine = line.from
      let insert = state.toText((byLine ? text.line(i++).text : input) + state.lineBreak)
      return {changes: {from: line.from, insert},
              range: EditorSelection.cursor(range.from + insert.length)}
    })
  } else if (byLine) {
    changes = state.changeByRange(range => {
      let line = text.line(i++)
      return {changes: {from: range.from, to: range.to, insert: line.text},
              range: EditorSelection.cursor(range.from + line.length)}
    })
  } else {
    changes = state.replaceSelection(text)
  }
  view.dispatch(changes, {
    userEvent: "input.paste",
    scrollIntoView: true
  })
}

handlers.keydown = (view, event: KeyboardEvent) => {
  view.inputState.setSelectionOrigin("select")
}

let lastTouch = 0

handlers.touchstart = (view, e) => {
  lastTouch = Date.now()
  view.inputState.setSelectionOrigin("select.pointer")
}

handlers.touchmove = view => {
  view.inputState.setSelectionOrigin("select.pointer")
}

handlers.mousedown = (view, event: MouseEvent) => {
  view.observer.flush()
  if (lastTouch > Date.now() - 2000) return // Ignore touch interaction
  let style: MouseSelectionStyle | null = null
  for (let makeStyle of view.state.facet(mouseSelectionStyle)) {
    style = makeStyle(view, event)
    if (style) break
  }
  if (!style && event.button == 0) style = basicMouseSelection(view, event)
  if (style) {
    if (view.root.activeElement != view.contentDOM) view.observer.ignore(() => focusPreventScroll(view.contentDOM))
    view.inputState.startMouseSelection(view, event, style)
  }
}

function rangeForClick(view: EditorView, pos: number, bias: -1 | 1, type: number): SelectionRange {
  if (type == 1) { // Single click
    return EditorSelection.cursor(pos, bias)
  } else if (type == 2) { // Double click
    return groupAt(view.state, pos, bias)
  } else { // Triple click
    let visual = LineView.find(view.docView, pos), line = view.state.doc.lineAt(visual ? visual.posAtEnd : pos)
    let from = visual ? visual.posAtStart : line.from, to = visual ? visual.posAtEnd : line.to
    if (to < view.state.doc.length && to == line.to) to++
    return EditorSelection.range(from, to)
  }
}

let insideY = (y: number, rect: Rect) => y >= rect.top && y <= rect.bottom
let inside = (x: number, y: number, rect: Rect) => insideY(y, rect) && x >= rect.left && x <= rect.right

// Try to determine, for the given coordinates, associated with the
// given position, whether they are related to the element before or
// the element after the position.
function findPositionSide(view: EditorView, pos: number, x: number, y: number) {
  let line = LineView.find(view.docView, pos)
  if (!line) return 1
  let off = pos - line.posAtStart
  // Line boundaries point into the line
  if (off == 0) return 1
  if (off == line.length) return -1

  // Positions on top of an element point at that element
  let before = line.coordsAt(off, -1)
  if (before && inside(x, y, before)) return -1
  let after = line.coordsAt(off, 1)
  if (after && inside(x, y, after)) return 1
  // This is probably a line wrap point. Pick before if the point is
  // beside it.
  return before && insideY(y, before) ? -1 : 1
}

function queryPos(view: EditorView, event: MouseEvent): {pos: number, bias: 1 | -1} | null {
  let pos = view.posAtCoords({x: event.clientX, y: event.clientY}, false)
  return {pos, bias: findPositionSide(view, pos, event.clientX, event.clientY)}
}

const BadMouseDetail = browser.ie && browser.ie_version <= 11
let lastMouseDown: MouseEvent | null = null, lastMouseDownCount = 0, lastMouseDownTime = 0

function getClickType(event: MouseEvent) {
  if (!BadMouseDetail) return event.detail
  let last = lastMouseDown, lastTime = lastMouseDownTime
  lastMouseDown = event
  lastMouseDownTime = Date.now()
  return lastMouseDownCount = !last || (lastTime > Date.now() - 400 && Math.abs(last.clientX - event.clientX) < 2 &&
                                        Math.abs(last.clientY - event.clientY) < 2) ? (lastMouseDownCount + 1) % 3 : 1
}

function basicMouseSelection(view: EditorView, event: MouseEvent) {
  let start = queryPos(view, event), type = getClickType(event)
  let startSel = view.state.selection
  let last = start, lastEvent: MouseEvent | null = event
  return {
    update(update) {
      if (update.changes) {
        if (start) start.pos = update.changes.mapPos(start.pos)
        startSel = startSel.map(update.changes)
        lastEvent = null
      }
    },
    get(event, extend, multiple) {
      let cur
      if (lastEvent && event.clientX == lastEvent.clientX && event.clientY == lastEvent.clientY) cur = last
      else { cur = last = queryPos(view, event); lastEvent = event }
      if (!cur || !start) return startSel
      let range = rangeForClick(view, cur.pos, cur.bias, type)
      if (start.pos != cur.pos && !extend) {
        let startRange = rangeForClick(view, start.pos, start.bias, type)
        let from = Math.min(startRange.from, range.from), to = Math.max(startRange.to, range.to)
        range = from < range.from ? EditorSelection.range(from, to) : EditorSelection.range(to, from)
      }
      if (extend)
        return startSel.replaceRange(startSel.main.extend(range.from, range.to))
      else if (multiple)
        return startSel.addRange(range)
      else
        return EditorSelection.create([range])
    }
  } as MouseSelectionStyle
}

handlers.dragstart = (view, event: DragEvent) => {
  let {selection: {main}} = view.state
  let {mouseSelection} = view.inputState
  if (mouseSelection) mouseSelection.dragging = main

  if (event.dataTransfer) {
    event.dataTransfer.setData("Text", view.state.sliceDoc(main.from, main.to))
    event.dataTransfer.effectAllowed = "copyMove"
  }
}

function dropText(view: EditorView, event: DragEvent, text: string, direct: boolean) {
  let dropPos = view.posAtCoords({x: event.clientX, y: event.clientY})
  if (dropPos == null || !text) return

  event.preventDefault()

  let {mouseSelection} = view.inputState
  let del = direct && mouseSelection && mouseSelection.dragging && mouseSelection.dragMove ?
    {from: mouseSelection.dragging.from, to: mouseSelection.dragging.to} : null
  let ins = {from: dropPos, insert: text}
  let changes = view.state.changes(del ? [del, ins] : ins)

  view.focus()
  view.dispatch({
    changes,
    selection: {anchor: changes.mapPos(dropPos, -1), head: changes.mapPos(dropPos, 1)},
    userEvent: del ? "move.drop" : "input.drop"
  })
}

handlers.drop = (view, event: DragEvent) => {
  if (!event.dataTransfer) return
  if (view.state.readOnly) return event.preventDefault()

  let files = event.dataTransfer.files
  if (files && files.length) { // For a file drop, read the file's text.
    event.preventDefault()
    let text = Array(files.length), read = 0
    let finishFile = () => {
      if (++read == files.length)
        dropText(view, event, text.filter(s => s != null).join(view.state.lineBreak), false)
    }
    for (let i = 0; i < files.length; i++) {
      let reader = new FileReader
      reader.onerror = finishFile
      reader.onload = () => {
        if (!/[\x00-\x08\x0e-\x1f]{2}/.test(reader.result as string)) text[i] = reader.result
        finishFile()
      }
      reader.readAsText(files[i])
    }
  } else {
    dropText(view, event, event.dataTransfer.getData("Text"), true)
  }
}

handlers.paste = (view: EditorView, event: ClipboardEvent) => {
  if (view.state.readOnly) return event.preventDefault()
  view.observer.flush()
  let data = brokenClipboardAPI ? null : event.clipboardData
  if (data) {
    doPaste(view, data.getData("text/plain"))
    event.preventDefault()
  } else {
    capturePaste(view)
  }
}

function captureCopy(view: EditorView, text: string) {
  // The extra wrapper is somehow necessary on IE/Edge to prevent the
  // content from being mangled when it is put onto the clipboard
  let parent = view.dom.parentNode
  if (!parent) return
  let target = parent.appendChild(document.createElement("textarea"))
  target.style.cssText = "position: fixed; left: -10000px; top: 10px"
  target.value = text
  target.focus()
  target.selectionEnd = text.length
  target.selectionStart = 0
  setTimeout(() => {
    target.remove()
    view.focus()
  }, 50)
}

function copiedRange(state: EditorState) {
  let content = [], ranges: {from: number, to: number}[] = [], linewise = false
  for (let range of state.selection.ranges) if (!range.empty) {
    content.push(state.sliceDoc(range.from, range.to))
    ranges.push(range)
  }
  if (!content.length) {
    // Nothing selected, do a line-wise copy
    let upto = -1
    for (let {from} of state.selection.ranges) {
      let line = state.doc.lineAt(from)
      if (line.number > upto) {
        content.push(line.text)
        ranges.push({from: line.from, to: Math.min(state.doc.length, line.to + 1)})
      }
      upto = line.number
    }
    linewise = true
  }

  return {text: content.join(state.lineBreak), ranges, linewise}
}

let lastLinewiseCopy: string | null = null

handlers.copy = handlers.cut = (view, event: ClipboardEvent) => {
  let {text, ranges, linewise} = copiedRange(view.state)
  if (!text && !linewise) return
  lastLinewiseCopy = linewise ? text : null

  let data = brokenClipboardAPI ? null : event.clipboardData
  if (data) {
    event.preventDefault()
    data.clearData()
    data.setData("text/plain", text)
  } else {
    captureCopy(view, text)
  }
  if (event.type == "cut" && !view.state.readOnly)
    view.dispatch({
      changes: ranges,
      scrollIntoView: true,
      userEvent: "delete.cut"
    })
}

handlers.focus = handlers.blur = view => {
  setTimeout(() => {
    if (view.hasFocus != view.inputState.notifiedFocused) view.update([])
  }, 10)
}

handlers.beforeprint = view => {
  view.viewState.printing = true
  view.requestMeasure()
  setTimeout(() => {
    view.viewState.printing = false
    view.requestMeasure()
  }, 2000)
}

function forceClearComposition(view: EditorView, rapid: boolean) {
  if (view.docView.compositionDeco.size) {
    view.inputState.rapidCompositionStart = rapid
    try { view.update([]) }
    finally { view.inputState.rapidCompositionStart = false }
  }
}

handlers.compositionstart = handlers.compositionupdate = view => {
  if (view.inputState.compositionFirstChange == null)
    view.inputState.compositionFirstChange = true
  if (view.inputState.composing < 0) {
    if (view.docView.compositionDeco.size) {
      view.observer.flush()
      forceClearComposition(view, true)
    }
    // FIXME possibly set a timeout to clear it again on Android
    view.inputState.composing = 0
  }
}

handlers.compositionend = view => {
  view.inputState.composing = -1
  view.inputState.compositionEndedAt = Date.now()
  view.inputState.compositionFirstChange = null
  setTimeout(() => {
    if (view.inputState.composing < 0) forceClearComposition(view, false)
  }, 50)
}

handlers.contextmenu = view => {
  view.inputState.lastContextMenu = Date.now()
}

handlers.beforeinput = (view, event) => {
  // Because Chrome Android doesn't fire useful key events, use
  // beforeinput to detect backspace (and possibly enter and delete,
  // but those usually don't even seem to fire beforeinput events at
  // the moment) and fake a key event for it.
  //
  // (preventDefault on beforeinput, though supported in the spec,
  // seems to do nothing at all on Chrome).
  let pending
  if (browser.chrome && browser.android && (pending = PendingKeys.find(key => key.inputType == event.inputType))) {
    view.inputState.setPendingKey(view, pending)
    let startViewHeight = window.visualViewport?.height || 0
    setTimeout(() => {
      // Backspacing near uneditable nodes on Chrome Android sometimes
      // closes the virtual keyboard. This tries to crudely detect
      // that and refocus to get it back.
      if ((window.visualViewport?.height || 0) > startViewHeight + 10 && view.hasFocus) {
        view.contentDOM.blur()
        view.focus()
      }
    }, 50)
  }
}
