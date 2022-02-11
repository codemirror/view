import {EditorView} from "./editorview"
import {inputHandler, editable} from "./extension"
import {contains, dispatchKey} from "./dom"
import browser from "./browser"
import {DOMReader, DOMPoint, LineBreakPlaceholder} from "./domreader"
import {compositionSurroundingNode} from "./docview"
import {EditorSelection, Text} from "@codemirror/state"

export function applyDOMChange(view: EditorView, start: number, end: number, typeOver: boolean) {
  let change: undefined | {from: number, to: number, insert: Text}, newSel
  let sel = view.state.selection.main
  if (start > -1) {
    let bounds = view.docView.domBoundsAround(start, end, 0)
    if (!bounds || view.state.readOnly) return
    let {from, to} = bounds
    let selPoints = view.docView.impreciseHead || view.docView.impreciseAnchor ? [] : selectionPoints(view)
    let reader = new DOMReader(selPoints, view.state)
    reader.readRange(bounds.startDOM, bounds.endDOM)

    let preferredPos = sel.from, preferredSide = null
    // Prefer anchoring to end when Backspace is pressed (or, on
    // Android, when something was deleted)
    if (view.inputState.lastKeyCode === 8 && view.inputState.lastKeyTime > Date.now() - 100 ||
        browser.android && reader.text.length < to - from) {
      preferredPos = sel.to
      preferredSide = "end"
    }
    let diff = findDiff(view.state.doc.sliceString(from, to, LineBreakPlaceholder), reader.text,
                        preferredPos - from, preferredSide)
    if (diff) {
      // Chrome inserts two newlines when pressing shift-enter at the
      // end of a line. This drops one of those.
      if (browser.chrome && view.inputState.lastKeyCode == 13 &&
          diff.toB == diff.from + 2 && reader.text.slice(diff.from, diff.toB) == LineBreakPlaceholder + LineBreakPlaceholder)
        diff.toB--

      change = {from: from + diff.from, to: from + diff.toA,
                insert: Text.of(reader.text.slice(diff.from, diff.toB).split(LineBreakPlaceholder))}
    }
    newSel = selectionFromPoints(selPoints, from)
  } else if (view.hasFocus || !view.state.facet(editable)) {
    let domSel = view.observer.selectionRange
    let {impreciseHead: iHead, impreciseAnchor: iAnchor} = view.docView
    let head = iHead && iHead.node == domSel.focusNode && iHead.offset == domSel.focusOffset ||
      !contains(view.contentDOM, domSel.focusNode)
      ? view.state.selection.main.head
      : view.docView.posFromDOM(domSel.focusNode!, domSel.focusOffset)
    let anchor = iAnchor && iAnchor.node == domSel.anchorNode && iAnchor.offset == domSel.anchorOffset ||
      !contains(view.contentDOM, domSel.anchorNode)
      ? view.state.selection.main.anchor
      : view.docView.posFromDOM(domSel.anchorNode!, domSel.anchorOffset)
    if (head != sel.head || anchor != sel.anchor)
      newSel = EditorSelection.single(anchor, head)
  }

  if (!change && !newSel) return

  // Heuristic to notice typing over a selected character
  if (!change && typeOver && !sel.empty && newSel && newSel.main.empty)
    change = {from: sel.from, to: sel.to, insert: view.state.doc.slice(sel.from, sel.to)}
  // If the change is inside the selection and covers most of it,
  // assume it is a selection replace (with identical characters at
  // the start/end not included in the diff)
  else if (change && change.from >= sel.from && change.to <= sel.to &&
           (change.from != sel.from || change.to != sel.to) &&
           (sel.to - sel.from) - (change.to - change.from) <= 4)
    change = {
      from: sel.from, to: sel.to,
      insert: view.state.doc.slice(sel.from, change.from).append(change.insert).append(view.state.doc.slice(change.to, sel.to))
    }

  if (change) {
    let startState = view.state
    if (browser.ios && view.inputState.flushIOSKey(view)) return
    // Android browsers don't fire reasonable key events for enter,
    // backspace, or delete. So this detects changes that look like
    // they're caused by those keys, and reinterprets them as key
    // events. (Some of these keys are also handled by beforeinput
    // events and the pendingAndroidKey mechanism, but that's not
    // reliable in all situations.)
    if (browser.android &&
        ((change.from == sel.from && change.to == sel.to &&
          change.insert.length == 1 && change.insert.lines == 2 &&
          dispatchKey(view.contentDOM, "Enter", 13)) ||
         (change.from == sel.from - 1 && change.to == sel.to && change.insert.length == 0 &&
          dispatchKey(view.contentDOM, "Backspace", 8)) ||
         (change.from == sel.from && change.to == sel.to + 1 && change.insert.length == 0 &&
          dispatchKey(view.contentDOM, "Delete", 46))))
      return

    let text = change.insert.toString()
    if (view.state.facet(inputHandler).some(h => h(view, change!.from, change!.to, text)))
      return

    if (view.inputState.composing >= 0) view.inputState.composing++
    let tr
    if (change.from >= sel.from && change.to <= sel.to && change.to - change.from >= (sel.to - sel.from) / 3 &&
        (!newSel || newSel.main.empty && newSel.main.from == change.from + change.insert.length) &&
        view.inputState.composing < 0) {
      let before = sel.from < change.from ? startState.sliceDoc(sel.from, change.from) : ""
      let after = sel.to > change.to ? startState.sliceDoc(change.to, sel.to) : ""
      tr = startState.replaceSelection(view.state.toText(
        before + change.insert.sliceString(0, undefined, view.state.lineBreak) + after))
    } else {
      let changes = startState.changes(change)
      let mainSel = newSel && !startState.selection.main.eq(newSel.main) && newSel.main.to <= changes.newLength
        ? newSel.main : undefined
      // Try to apply a composition change to all cursors
      if (startState.selection.ranges.length > 1 && view.inputState.composing >= 0 &&
          change.to <= sel.to && change.to >= sel.to - 10) {
        let replaced = view.state.sliceDoc(change.from, change.to)
        let compositionRange = compositionSurroundingNode(view) || view.state.doc.lineAt(sel.head)
        let offset = sel.to - change.to, size = sel.to - sel.from
        tr = startState.changeByRange(range => {
          if (range.from == sel.from && range.to == sel.to)
            return {changes, range: mainSel || range.map(changes)}
          let to = range.to - offset, from = to - replaced.length
          if (range.to - range.from != size || view.state.sliceDoc(from, to) != replaced ||
              // Unfortunately, there's no way to make multiple
              // changes in the same node work without aborting
              // composition, so cursors in the composition range are
              // ignored.
              compositionRange && range.to >= compositionRange.from && range.from <= compositionRange.to)
            return {range}
          let rangeChanges = startState.changes({from, to, insert: change!.insert}), selOff = range.to - sel.to
          return {
            changes: rangeChanges,
            range: !mainSel ? range.map(rangeChanges) :
              EditorSelection.range(Math.max(0, mainSel.anchor + selOff), Math.max(0, mainSel.head + selOff))
          }
        })
      } else {
        tr = {
          changes,
          selection: mainSel && startState.selection.replaceRange(mainSel)
        }
      }
    }
    let userEvent = "input.type"
    if (view.composing) {
      userEvent += ".compose"
      if (view.inputState.compositionFirstChange) {
        userEvent += ".start"
        view.inputState.compositionFirstChange = false
      }
    }
    view.dispatch(tr, {scrollIntoView: true, userEvent})
  } else if (newSel && !newSel.main.eq(sel)) {
    let scrollIntoView = false, userEvent = "select"
    if (view.inputState.lastSelectionTime > Date.now() - 50) {
      if (view.inputState.lastSelectionOrigin == "select") scrollIntoView = true
      userEvent = view.inputState.lastSelectionOrigin!
    }
    view.dispatch({selection: newSel, scrollIntoView, userEvent})
  }
}

function findDiff(a: string, b: string, preferredPos: number, preferredSide: string | null)
    : {from: number, toA: number, toB: number} | null {
  let minLen = Math.min(a.length, b.length)
  let from = 0
  while (from < minLen && a.charCodeAt(from) == b.charCodeAt(from)) from++
  if (from == minLen && a.length == b.length) return null
  let toA = a.length, toB = b.length
  while (toA > 0 && toB > 0 && a.charCodeAt(toA - 1) == b.charCodeAt(toB - 1)) { toA--; toB-- }

  if (preferredSide == "end") {
    let adjust = Math.max(0, from - Math.min(toA, toB))
    preferredPos -= toA + adjust - from
  }
  if (toA < from && a.length < b.length) {
    let move = preferredPos <= from && preferredPos >= toA ? from - preferredPos : 0
    from -= move
    toB = from + (toB - toA)
    toA = from
  } else if (toB < from) {
    let move = preferredPos <= from && preferredPos >= toB ? from - preferredPos : 0
    from -= move
    toA = from + (toA - toB)
    toB = from
  }
  return {from, toA, toB}
}

function selectionPoints(view: EditorView) {
  let result: DOMPoint[] = []
  if (view.root.activeElement != view.contentDOM) return result
  let {anchorNode, anchorOffset, focusNode, focusOffset} = view.observer.selectionRange
  if (anchorNode) {
    result.push(new DOMPoint(anchorNode, anchorOffset))
    if (focusNode != anchorNode || focusOffset != anchorOffset)
      result.push(new DOMPoint(focusNode!, focusOffset))
  }
  return result
}

function selectionFromPoints(points: DOMPoint[], base: number): EditorSelection | null {
  if (points.length == 0) return null
  let anchor = points[0].pos, head = points.length == 2 ? points[1].pos : anchor
  return anchor > -1 && head > -1 ? EditorSelection.single(anchor + base, head + base) : null
}
