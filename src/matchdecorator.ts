import {Text} from "@codemirror/state"
import {RangeSetBuilder} from "@codemirror/rangeset"
import {EditorView} from "./editorview"
import {ViewUpdate} from "./extension"
import {Decoration, DecorationSet} from "./decoration"

function iterMatches(doc: Text, re: RegExp, from: number, to: number, f: (from: number, to: number, m: RegExpExecArray) => void) {
  re.lastIndex = 0
  for (let cursor = doc.iterRange(from, to), pos = from, m; !cursor.next().done; pos += cursor.value.length) {
    if (!cursor.lineBreak) while (m = re.exec(cursor.value))
      f(pos + m.index, pos + m.index + m[0].length, m)
  }
}

function matchRanges(view: EditorView, maxLength: number) {
  let visible = view.visibleRanges
  if (visible.length == 1 && visible[0].from == view.viewport.from &&
      visible[0].to == view.viewport.to) return visible
  let result = []
  for (let {from, to} of visible) {
    from = Math.max(view.state.doc.lineAt(from).from, from - maxLength)
    to = Math.min(view.state.doc.lineAt(to).to, to + maxLength)
    if (result.length && result[result.length - 1].to >= from) result[result.length - 1].to = to
    else result.push({from, to})
  }
  return result
}

/// Helper class used to make it easier to maintain decorations on
/// visible code that matches a given regular expression. To be used
/// in a [view plugin](#view.ViewPlugin). Instances of this object
/// represent a matching configuration.
export class MatchDecorator {
  private regexp: RegExp
  private getDeco: (match: RegExpExecArray, view: EditorView, pos: number) => Decoration
  private boundary: RegExp | undefined
  private maxLength: number

  /// Create a decorator.
  constructor(config: {
    /// The regular expression to match against the content. Will only
    /// be matched inside lines (not across them). Should have its 'g'
    /// flag set.
    regexp: RegExp,
    /// The decoration to apply to matches, either directly or as a
    /// function of the match.
    decoration: Decoration | ((match: RegExpExecArray, view: EditorView, pos: number) => Decoration),
    /// By default, changed lines are re-matched entirely. You can
    /// provide a boundary expression, which should match single
    /// character strings that can never occur in `regexp`, to reduce
    /// the amount of re-matching.
    boundary?: RegExp,
    /// Matching happens by line, by default, but when lines are
    /// folded or very long lines are only partially drawn, the
    /// decorator may avoid matching part of them for speed. This
    /// controls how much additional invisible content it should
    /// include in its matches. Defaults to 1000.
    maxLength?: number,
  }) {
    let {regexp, decoration, boundary, maxLength = 1000} = config
    if (!regexp.global) throw new RangeError("The regular expression given to MatchDecorator should have its 'g' flag set")
    this.regexp = regexp
    this.getDeco = typeof decoration == "function" ? decoration as any : () => decoration
    this.boundary = boundary
    this.maxLength = maxLength
  }

  /// Compute the full set of decorations for matches in the given
  /// view's viewport. You'll want to call this when initializing your
  /// plugin.
  createDeco(view: EditorView) {
    let build = new RangeSetBuilder<Decoration>()
    for (let {from, to} of matchRanges(view, this.maxLength))
      iterMatches(view.state.doc, this.regexp, from, to, (a, b, m) => build.add(a, b, this.getDeco(m, view, a)))
    return build.finish()
  }

  /// Update a set of decorations for a view update. `deco` _must_ be
  /// the set of decorations produced by _this_ `MatchDecorator` for
  /// the view state before the update.
  updateDeco(update: ViewUpdate, deco: DecorationSet) {
    let changeFrom = 1e9, changeTo = -1
    if (update.docChanged) update.changes.iterChanges((_f, _t, from, to) => {
      if (to > update.view.viewport.from && from < update.view.viewport.to) {
        changeFrom = Math.min(from, changeFrom)
        changeTo = Math.max(to, changeTo)
      }
    })
    if (update.viewportChanged || changeTo - changeFrom > 1000)
      return this.createDeco(update.view)
    if (changeTo > -1)
      return this.updateRange(update.view, deco.map(update.changes), changeFrom, changeTo)
    return deco
  }

  private updateRange(view: EditorView, deco: DecorationSet, updateFrom: number, updateTo: number) {
    for (let r of view.visibleRanges) {
      let from = Math.max(r.from, updateFrom), to = Math.min(r.to, updateTo)
      if (to > from) {
        let fromLine = view.state.doc.lineAt(from), toLine = fromLine.to < to ? view.state.doc.lineAt(to) : fromLine
        let start = Math.max(r.from, fromLine.from), end = Math.min(r.to, toLine.to)
        if (this.boundary) {
          for (; from > fromLine.from; from--) if (this.boundary.test(fromLine.text[from - 1 - fromLine.from])) {
            start = from
            break
          }
          for (; to < toLine.to; to++) if (this.boundary.test(toLine.text[to - toLine.from])) {
            end = to
            break
          }
        }
        let ranges = [], m
        if (fromLine == toLine) {
          this.regexp.lastIndex = start - fromLine.from
          while ((m = this.regexp.exec(fromLine.text)) && m.index < end - fromLine.from) {
            let pos = m.index + fromLine.from
            ranges.push(this.getDeco(m, view, pos).range(pos, pos + m[0].length))
          }
        } else {
          iterMatches(view.state.doc, this.regexp, start, end,
                      (from, to, m) => ranges.push(this.getDeco(m, view, from).range(from, to)))
        }
        deco = deco.update({filterFrom: start, filterTo: end, filter: (from, to) => from < start || to > end, add: ranges})
      }
    }
    return deco
  }
}
