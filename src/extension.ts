import {EditorState, Transaction, ChangeSet, ChangeDesc, Facet,
        StateEffect, Extension, SelectionRange} from "@codemirror/state"
import {RangeSet} from "@codemirror/rangeset"
import {StyleModule} from "style-mod"
import {DecorationSet} from "./decoration"
import {EditorView, DOMEventHandlers} from "./editorview"
import {Attrs} from "./attributes"
import {Rect, ScrollStrategy} from "./dom"
import {MakeSelectionStyle} from "./input"

/// Command functions are used in key bindings and other types of user
/// actions. Given an editor view, they check whether their effect can
/// apply to the editor, and if it can, perform it as a side effect
/// (which usually means [dispatching](#view.EditorView.dispatch) a
/// transaction) and return `true`.
export type Command = (target: EditorView) => boolean

const none: readonly any[] = []

export const clickAddsSelectionRange = Facet.define<(event: MouseEvent) => boolean>()

export const dragMovesSelection = Facet.define<(event: MouseEvent) => boolean>()

export const mouseSelectionStyle = Facet.define<MakeSelectionStyle>()

export const exceptionSink = Facet.define<(exception: any) => void>()

export const updateListener = Facet.define<(update: ViewUpdate) => void>()

export const inputHandler = Facet.define<(view: EditorView, from: number, to: number, text: string) => boolean>()

// FIXME remove
export const scrollTo = StateEffect.define<SelectionRange>({
  map: (range, changes) => range.map(changes)
})

// FIXME remove
export const centerOn = StateEffect.define<SelectionRange>({
  map: (range, changes) => range.map(changes)
})

export class ScrollTarget {
  constructor(
    readonly range: SelectionRange,
    readonly y: ScrollStrategy = "nearest",
    readonly x: ScrollStrategy = "nearest",
    readonly yMargin: number = 5,
    readonly xMargin: number = 5,
  ) {}

  map(changes: ChangeDesc) {
    return changes.empty ? this : new ScrollTarget(this.range.map(changes), this.y, this.x, this.yMargin, this.xMargin)
  }
}

export const scrollIntoView = StateEffect.define<ScrollTarget>({map: (t, ch) => t.map(ch)})

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
export interface PluginValue {
  /// Notifies the plugin of an update that happened in the view. This
  /// is called _before_ the view updates its own DOM. It is
  /// responsible for updating the plugin's internal state (including
  /// any state that may be read by plugin fields) and _writing_ to
  /// the DOM for the changes in the update. To avoid unnecessary
  /// layout recomputations, it should _not_ read the DOM layout—use
  /// [`requestMeasure`](#view.EditorView.requestMeasure) to schedule
  /// your code in a DOM reading phase if you need to.
  update?(_update: ViewUpdate): void

  /// Called when the plugin is no longer going to be used. Should
  /// revert any changes the plugin made to the DOM.
  destroy?(): void
}

declare const isFieldProvider: unique symbol

/// Used to [declare](#view.PluginSpec.provide) which
/// [fields](#view.PluginValue) a [view plugin](#view.ViewPlugin)
/// provides.
export class PluginFieldProvider<V> {
  // @ts-ignore
  private [isFieldProvider]!: true

  /// @internal
  constructor(
    /// @internal
    readonly field: PluginField<any>,
    /// @internal
    readonly get: (value: V) => any
  ) {}
}

/// Plugin fields are a mechanism for allowing plugins to provide
/// values that can be retrieved through the
/// [`pluginField`](#view.EditorView.pluginField) view method.
export class PluginField<T> {
  /// Create a [provider](#view.PluginFieldProvider) for this field,
  /// to use with a plugin's [provide](#view.PluginSpec.provide)
  /// option.
  from<V extends PluginValue>(get: (value: V) => T): PluginFieldProvider<V> {
    return new PluginFieldProvider(this, get)
  }

  /// Define a new plugin field.
  static define<T>() { return new PluginField<T>() }

  /// This field can be used by plugins to provide
  /// [decorations](#view.Decoration).
  ///
  /// **Note**: For reasons of data flow (plugins are only updated
  /// after the viewport is computed), decorations produced by plugins
  /// are _not_ taken into account when predicting the vertical layout
  /// structure of the editor. They **must not** introduce block
  /// widgets (that will raise an error) or replacing decorations that
  /// cover line breaks (these will be ignored if they occur). Such
  /// decorations, or others that cause a large amount of vertical
  /// size shift compared to the undecorated content, should be
  /// provided through the state-level [`decorations`
  /// facet](#view.EditorView^decorations) instead.
  static decorations = PluginField.define<DecorationSet>()

  /// Used to provide ranges that should be treated as atoms as far as
  /// cursor motion is concerned. This causes methods like
  /// [`moveByChar`](#view.EditorView.moveByChar) and
  /// [`moveVertically`](#view.EditorView.moveVertically) (and the
  /// commands built on top of them) to skip across such regions when
  /// a selection endpoint would enter them. This does _not_ prevent
  /// direct programmatic [selection
  /// updates](#state.TransactionSpec.selection) from moving into such
  /// regions.
  static atomicRanges = PluginField.define<RangeSet<any>>()

  /// Plugins can provide additional scroll margins (space around the
  /// sides of the scrolling element that should be considered
  /// invisible) through this field. This can be useful when the
  /// plugin introduces elements that cover part of that element (for
  /// example a horizontally fixed gutter).
  static scrollMargins = PluginField.define<Partial<Rect> | null>()
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

  /// Allow the plugin to provide decorations. When given, this should
  /// a function that take the plugin value and return a [decoration
  /// set](#view.DecorationSet). See also the caveat about
  /// [layout-changing decorations](#view.PluginField^decorations)
  /// from plugins.
  decorations?: (value: V) => DecorationSet

  /// Specify that the plugin provides [plugin
  /// field](#view.PluginField) values. Use a field's
  /// [`from`](#view.PluginField.from) method to create these
  /// providers.
  provide?: PluginFieldProvider<V> | readonly PluginFieldProvider<V>[],
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
    readonly fields: readonly PluginFieldProvider<V>[]
  ) {
    this.extension = viewPlugin.of(this)
  }

  /// Define a plugin from a constructor function that creates the
  /// plugin's value, given an editor view.
  static define<V extends PluginValue>(create: (view: EditorView) => V, spec?: PluginSpec<V>) {
    let {eventHandlers, provide, decorations} = spec || {}
    let fields = []
    if (provide) for (let provider of Array.isArray(provide) ? provide : [provide])
      fields.push(provider)
    if (eventHandlers)
      fields.push(domEventHandlers.from((value: V) => ({plugin: value, handlers: eventHandlers} as any)))
    if (decorations) fields.push(PluginField.decorations.from(decorations))
    return new ViewPlugin<V>(nextPluginID++, create, fields)
  }

  /// Create a plugin for a class whose constructor takes a single
  /// editor view as argument.
  static fromClass<V extends PluginValue>(cls: {new (view: EditorView): V}, spec?: PluginSpec<V>) {
    return ViewPlugin.define(view => new cls(view), spec)
  }
}

export const domEventHandlers = PluginField.define<{
  plugin: PluginValue,
  handlers: DOMEventHandlers<any>
}>()

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

  takeField<T>(type: PluginField<T>, target: T[]) {
    if (this.spec) for (let {field, get} of this.spec.fields)
      if (field == type) target.push(get(this.value))
  }

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
  /// last one will actually be ran.
  key?: any
}

export type AttrSource = Attrs | ((view: EditorView) => Attrs | null)

export const editorAttributes = Facet.define<AttrSource>()

export const contentAttributes = Facet.define<AttrSource>()

// Provide decorations
export const decorations = Facet.define<DecorationSet>()

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

  /// @internal
  constructor(
    /// The editor view that the update is associated with.
    readonly view: EditorView,
    /// The new editor state.
    readonly state: EditorState,
    /// The transactions involved in the update. May be empty.
    readonly transactions: readonly Transaction[] = none
  ) {
    this.startState = view.state
    this.changes = ChangeSet.empty(this.startState.doc.length)
    for (let tr of transactions) this.changes = this.changes.compose(tr.changes)
    let changedRanges: ChangedRange[] = []
    this.changes.iterChangedRanges((fromA, toA, fromB, toB) => changedRanges.push(new ChangedRange(fromA, toA, fromB, toB)))
    this.changedRanges = changedRanges
    let focus = view.hasFocus
    if (focus != view.inputState.notifiedFocused) {
      view.inputState.notifiedFocused = focus
      this.flags |= UpdateFlag.Focus
    }
  }

  /// Tells you whether the [viewport](#view.EditorView.viewport) or
  /// [visible ranges](#view.EditorView.visibleRanges) changed in this
  /// update.
  get viewportChanged() {
    return (this.flags & UpdateFlag.Viewport) > 0
  }

  /// Indicates whether the height of an element in the editor changed
  /// in this update.
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

  /// Whether this transaction reconfigures the state
  /// (through a [configuration compartment](#state.Compartment) or
  /// with a top-level configuration
  /// [effect](#state.StateEffect^reconfigure)).
  get configurationChanged() {
    return this.transactions.some(tr => tr.reconfigured)
  }

  /// @internal
  get empty() { return this.flags == 0 && this.transactions.length == 0 }
}
