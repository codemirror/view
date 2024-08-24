import {EditorState, Transaction, ChangeSet, ChangeDesc, Facet, Line,
        StateEffect, Extension, SelectionRange, RangeSet, EditorSelection} from "@codemirror/state"
import {StyleModule} from "style-mod"
import {DecorationSet, Decoration} from "./decoration"
import {EditorView, DOMEventHandlers} from "./editorview"
import {Attrs} from "./attributes"
import {Isolate, autoDirection} from "./bidi"
import {Rect, ScrollStrategy} from "./dom"
import {MakeSelectionStyle} from "./input"

/// Command functions are used in key bindings and other types of user
/// actions. Given an editor view, they check whether their effect can
/// apply to the editor, and if it can, perform it as a side effect
/// (which usually means [dispatching](#view.EditorView.dispatch) a
/// transaction) and return `true`.
export type Command = (target: EditorView) => boolean

export const clickAddsSelectionRange = Facet.define<(event: MouseEvent) => boolean>()

export const dragMovesSelection = Facet.define<(event: MouseEvent) => boolean>()

export const mouseSelectionStyle = Facet.define<MakeSelectionStyle>()

export const exceptionSink = Facet.define<(exception: any) => void>()

export const updateListener = Facet.define<(update: ViewUpdate) => void>()

export const inputHandler = Facet.define<(view: EditorView, from: number, to: number, text: string,
                                          insert: () => Transaction) => boolean>()

export const focusChangeEffect = Facet.define<(state: EditorState, focusing: boolean) => StateEffect<any> | null>()

export const clipboardInputFilter = Facet.define<(text: string, state: EditorState) => string>()
export const clipboardOutputFilter = Facet.define<(text: string, state: EditorState) => string>()

export const perLineTextDirection = Facet.define<boolean, boolean>({
  combine: values => values.some(x => x)
})

export const nativeSelectionHidden = Facet.define<boolean, boolean>({
  combine: values => values.some(x => x)
})

export const scrollHandler = Facet.define<(
  view: EditorView,
  range: SelectionRange,
  options: {x: ScrollStrategy, y: ScrollStrategy, xMargin: number, yMargin: number}
) => boolean>()

export class ScrollTarget {
  constructor(
    readonly range: SelectionRange,
    readonly y: ScrollStrategy = "nearest",
    readonly x: ScrollStrategy = "nearest",
    readonly yMargin: number = 5,
    readonly xMargin: number = 5,
    // This data structure is abused to also store precise scroll
    // snapshots, instead of a `scrollIntoView` request. When this
    // flag is `true`, `range` points at a position in the reference
    // line, `yMargin` holds the difference between the top of that
    // line and the top of the editor, and `xMargin` holds the
    // editor's `scrollLeft`.
    readonly isSnapshot = false
  ) {}

  map(changes: ChangeDesc) {
    return changes.empty ? this :
      new ScrollTarget(this.range.map(changes), this.y, this.x, this.yMargin, this.xMargin, this.isSnapshot)
  }

  clip(state: EditorState) {
    return this.range.to <= state.doc.length ? this :
      new ScrollTarget(EditorSelection.cursor(state.doc.length), this.y, this.x, this.yMargin, this.xMargin, this.isSnapshot)
  }
}

export const scrollIntoView = StateEffect.define<ScrollTarget>({map: (t, ch) => t.map(ch)})

export const setEditContextFormatting = StateEffect.define<DecorationSet>()

/// Log or report an unhandled exception in client code. Should
/// probably only be used by extension code that allows client code to
/// provide functions, and calls those functions in a context where an
/// exception can't be propagated to calling code in a reasonable way
/// (for example when in an event handler).
///
/// Either calls a handler registered with
/// [`EditorView.exceptionSink`](#view.EditorView^exceptionSink),
/// `window.onerror`, if defined, or `console.error` (in which case
/// it'll pass `context`, when given, as first argument).
export function logException(state: EditorState, exception: any, context?: string) {
  let handler = state.facet(exceptionSink)
  if (handler.length) handler[0](exception)
  else if (window.onerror) window.onerror(String(exception), context, undefined, undefined, exception)
  else if (context) console.error(context + ":", exception)
  else console.error(exception)
}

export const editable = Facet.define<boolean, boolean>({combine: values => values.length ? values[0] : true })

/// This is the interface plugin objects conform to.
export interface PluginValue extends Object {
  /// Notifies the plugin of an update that happened in the view. This
  /// is called _before_ the view updates its own DOM. It is
  /// responsible for updating the plugin's internal state (including
  /// any state that may be read by plugin fields) and _writing_ to
  /// the DOM for the changes in the update. To avoid unnecessary
  /// layout recomputations, it should _not_ read the DOM layout—use
  /// [`requestMeasure`](#view.EditorView.requestMeasure) to schedule
  /// your code in a DOM reading phase if you need to.
  update?(update: ViewUpdate): void

  /// Called when the document view is updated (due to content,
  /// decoration, or viewport changes). Should not try to immediately
  /// start another view update. Often useful for calling
  /// [`requestMeasure`](#view.EditorView.requestMeasure).
  docViewUpdate?(view: EditorView): void

  /// Called when the plugin is no longer going to be used. Should
  /// revert any changes the plugin made to the DOM.
  destroy?(): void
}

let nextPluginID = 0

export const viewPlugin = Facet.define<ViewPlugin<any>>()

/// Provides additional information when defining a [view
/// plugin](#view.ViewPlugin).
export interface PluginSpec<V extends PluginValue> {
  /// Register the given [event
  /// handlers](#view.EditorView^domEventHandlers) for the plugin.
  /// When called, these will have their `this` bound to the plugin
  /// value.
  eventHandlers?: DOMEventHandlers<V>,

  /// Registers [event observers](#view.EditorView^domEventObservers)
  /// for the plugin. Will, when called, have their `this` bound to
  /// the plugin value.
  eventObservers?: DOMEventHandlers<V>,

  /// Specify that the plugin provides additional extensions when
  /// added to an editor configuration.
  provide?: (plugin: ViewPlugin<V>) => Extension

  /// Allow the plugin to provide decorations. When given, this should
  /// be a function that take the plugin value and return a
  /// [decoration set](#view.DecorationSet). See also the caveat about
  /// [layout-changing decorations](#view.EditorView^decorations) that
  /// depend on the view.
  decorations?: (value: V) => DecorationSet
}

/// View plugins associate stateful values with a view. They can
/// influence the way the content is drawn, and are notified of things
/// that happen in the view.
export class ViewPlugin<V extends PluginValue> {
  /// Instances of this class act as extensions.
  extension: Extension

  private constructor(
    /// @internal
    readonly id: number,
    /// @internal
    readonly create: (view: EditorView) => V,
    /// @internal
    readonly domEventHandlers: DOMEventHandlers<V> | undefined,
    /// @internal
    readonly domEventObservers: DOMEventHandlers<V> | undefined,
    buildExtensions: (plugin: ViewPlugin<V>) => Extension
  ) {
    this.extension = buildExtensions(this)
  }

  /// Define a plugin from a constructor function that creates the
  /// plugin's value, given an editor view.
  static define<V extends PluginValue>(create: (view: EditorView) => V, spec?: PluginSpec<V>) {
    const {eventHandlers, eventObservers, provide, decorations: deco} = spec || {}
    return new ViewPlugin<V>(nextPluginID++, create, eventHandlers, eventObservers, plugin => {
      let ext = [viewPlugin.of(plugin)]
      if (deco) ext.push(decorations.of(view => {
        let pluginInst = view.plugin(plugin)
        return pluginInst ? deco(pluginInst) : Decoration.none
      }))
      if (provide) ext.push(provide(plugin))
      return ext
    })
  }

  /// Create a plugin for a class whose constructor takes a single
  /// editor view as argument.
  static fromClass<V extends PluginValue>(cls: {new (view: EditorView): V}, spec?: PluginSpec<V>) {
    return ViewPlugin.define(view => new cls(view), spec)
  }
}

export class PluginInstance {
  // When starting an update, all plugins have this field set to the
  // update object, indicating they need to be updated. When finished
  // updating, it is set to `false`. Retrieving a plugin that needs to
  // be updated with `view.plugin` forces an eager update.
  mustUpdate: ViewUpdate | null = null
  // This is null when the plugin is initially created, but
  // initialized on the first update.
  value: PluginValue | null = null

  constructor(public spec: ViewPlugin<any> | null) {}

  update(view: EditorView) {
    if (!this.value) {
      if (this.spec) {
        try { this.value = this.spec.create(view) }
        catch (e) {
          logException(view.state, e, "CodeMirror plugin crashed")
          this.deactivate()
        }
      }
    } else if (this.mustUpdate) {
      let update = this.mustUpdate
      this.mustUpdate = null
      if (this.value.update) {
        try {
          this.value.update(update)
        } catch (e) {
          logException(update.state, e, "CodeMirror plugin crashed")
          if (this.value.destroy) try { this.value.destroy() } catch (_) {}
          this.deactivate()
        }
      }
    }
    return this
  }

  destroy(view: EditorView) {
    if (this.value?.destroy) {
      try { this.value.destroy() }
      catch (e) { logException(view.state, e, "CodeMirror plugin crashed") }
    }
  }

  deactivate() {
    this.spec = this.value = null
  }
}

export interface MeasureRequest<T> {
  /// Called in a DOM read phase to gather information that requires
  /// DOM layout. Should _not_ mutate the document.
  read(view: EditorView): T
  /// Called in a DOM write phase to update the document. Should _not_
  /// do anything that triggers DOM layout.
  write?(measure: T, view: EditorView): void
  /// When multiple requests with the same key are scheduled, only the
  /// last one will actually be run.
  key?: any
}

export type AttrSource = Attrs | ((view: EditorView) => Attrs | null)

export const editorAttributes = Facet.define<AttrSource>()

export const contentAttributes = Facet.define<AttrSource>()

// Provide decorations
export const decorations = Facet.define<DecorationSet | ((view: EditorView) => DecorationSet)>()

export const outerDecorations = Facet.define<DecorationSet | ((view: EditorView) => DecorationSet)>()

export const atomicRanges = Facet.define<(view: EditorView) => RangeSet<any>>()

export const bidiIsolatedRanges = Facet.define<DecorationSet | ((view: EditorView) => DecorationSet)>()

export function getIsolatedRanges(view: EditorView, line: Line): readonly Isolate[] {
  let isolates = view.state.facet(bidiIsolatedRanges)
  if (!isolates.length) return isolates as any[]
  let sets = isolates.map<DecorationSet>(i => i instanceof Function ? i(view) : i)
  let result: Isolate[] = []
  RangeSet.spans(sets, line.from, line.to, {
    point() {},
    span(fromDoc, toDoc, active, open) {
      let from = fromDoc - line.from, to = toDoc - line.from
      let level = result
      for (let i = active.length - 1; i >= 0; i--, open--) {
        let direction = active[i].spec.bidiIsolate, update
        if (direction == null)
          direction = autoDirection(line.text, from, to)
        if (open > 0 && level.length &&
            (update = level[level.length - 1]).to == from && update.direction == direction) {
          update.to = to
          level = update.inner as Isolate[]
        } else {
          let add = {from, to, direction, inner: []}
          level.push(add)
          level = add.inner
        }
      }
    }
  })
  return result
}

export const scrollMargins = Facet.define<(view: EditorView) => Partial<Rect> | null>()

export function getScrollMargins(view: EditorView) {
  let left = 0, right = 0, top = 0, bottom = 0
  for (let source of view.state.facet(scrollMargins)) {
    let m = source(view)
    if (m) {
      if (m.left != null) left = Math.max(left, m.left)
      if (m.right != null) right = Math.max(right, m.right)
      if (m.top != null) top = Math.max(top, m.top)
      if (m.bottom != null) bottom = Math.max(bottom, m.bottom)
    }
  }
  return {left, right, top, bottom}
}

export const styleModule = Facet.define<StyleModule>()

export const enum UpdateFlag { Focus = 1, Height = 2, Viewport = 4, Geometry = 8 }

export class ChangedRange {
  constructor(readonly fromA: number, readonly toA: number, readonly fromB: number, readonly toB: number) {}

  join(other: ChangedRange): ChangedRange {
    return new ChangedRange(Math.min(this.fromA, other.fromA), Math.max(this.toA, other.toA),
                            Math.min(this.fromB, other.fromB), Math.max(this.toB, other.toB))
  }

  addToSet(set: ChangedRange[]): ChangedRange[] {
    let i = set.length, me: ChangedRange = this
    for (; i > 0; i--) {
      let range = set[i - 1]
      if (range.fromA > me.toA) continue
      if (range.toA < me.fromA) break
      me = me.join(range)
      set.splice(i - 1, 1)
    }
    set.splice(i, 0, me)
    return set
  }

  static extendWithRanges(diff: readonly ChangedRange[], ranges: number[]): readonly ChangedRange[] {
    if (ranges.length == 0) return diff
    let result: ChangedRange[] = []
    for (let dI = 0, rI = 0, posA = 0, posB = 0;; dI++) {
      let next = dI == diff.length ? null : diff[dI], off = posA - posB
      let end = next ? next.fromB : 1e9
      while (rI < ranges.length && ranges[rI] < end) {
        let from = ranges[rI], to = ranges[rI + 1]
        let fromB = Math.max(posB, from), toB = Math.min(end, to)
        if (fromB <= toB) new ChangedRange(fromB + off, toB + off, fromB, toB).addToSet(result)
        if (to > end) break
        else rI += 2
      }
      if (!next) return result
      new ChangedRange(next.fromA, next.toA, next.fromB, next.toB).addToSet(result)
      posA = next.toA; posB = next.toB
    }
  }
}

/// View [plugins](#view.ViewPlugin) are given instances of this
/// class, which describe what happened, whenever the view is updated.
export class ViewUpdate {
  /// The changes made to the document by this update.
  readonly changes: ChangeSet
  /// The previous editor state.
  readonly startState: EditorState
  /// @internal
  flags = 0
  /// @internal
  changedRanges: readonly ChangedRange[]

  private constructor(
    /// The editor view that the update is associated with.
    readonly view: EditorView,
    /// The new editor state.
    readonly state: EditorState,
    /// The transactions involved in the update. May be empty.
    readonly transactions: readonly Transaction[]
  ) {
    this.startState = view.state
    this.changes = ChangeSet.empty(this.startState.doc.length)
    for (let tr of transactions) this.changes = this.changes.compose(tr.changes)
    let changedRanges: ChangedRange[] = []
    this.changes.iterChangedRanges((fromA, toA, fromB, toB) => changedRanges.push(new ChangedRange(fromA, toA, fromB, toB)))
    this.changedRanges = changedRanges
  }

  /// @internal
  static create(view: EditorView, state: EditorState, transactions: readonly Transaction[]) {
    return new ViewUpdate(view, state, transactions)
  }

  /// Tells you whether the [viewport](#view.EditorView.viewport) or
  /// [visible ranges](#view.EditorView.visibleRanges) changed in this
  /// update.
  get viewportChanged() {
    return (this.flags & UpdateFlag.Viewport) > 0
  }

  /// Indicates whether the height of a block element in the editor
  /// changed in this update.
  get heightChanged() {
    return (this.flags & UpdateFlag.Height) > 0
  }

  /// Returns true when the document was modified or the size of the
  /// editor, or elements within the editor, changed.
  get geometryChanged() {
    return this.docChanged || (this.flags & (UpdateFlag.Geometry | UpdateFlag.Height)) > 0
  }

  /// True when this update indicates a focus change.
  get focusChanged() {
    return (this.flags & UpdateFlag.Focus) > 0
  }

  /// Whether the document changed in this update.
  get docChanged() {
    return !this.changes.empty
  }

  /// Whether the selection was explicitly set in this update.
  get selectionSet() {
    return this.transactions.some(tr => tr.selection)
  }

  /// @internal
  get empty() { return this.flags == 0 && this.transactions.length == 0 }
}
