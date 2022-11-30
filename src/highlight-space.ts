import {Extension} from "@codemirror/state"
import {ViewPlugin} from "./extension"
import {MatchDecorator} from "./matchdecorator"
import {Decoration} from "./decoration"

const WhitespaceDeco = new Map<string, Decoration>()

function getWhitespaceDeco(space: string): Decoration {
  let deco = WhitespaceDeco.get(space)
  if (!deco) WhitespaceDeco.set(space, deco = Decoration.mark({
    attributes: space === "\t" ? {
      class: "cm-highlightTab",
    } : {
      class: "cm-highlightSpace",
      "data-display": space.replace(/ /g, "·")
    }
  }))
  return deco
}

function matcher(decorator: MatchDecorator): Extension {
  return ViewPlugin.define(view => ({
    decorations: decorator.createDeco(view),
    update(u): void {
      this.decorations = decorator.updateDeco(u, this.decorations)
    },
  }), {
    decorations: v => v.decorations
  })
}

const whitespaceHighlighter = matcher(new MatchDecorator({
  regexp: /\t| +/g,
  decoration: match => getWhitespaceDeco(match[0]),
  boundary: /\S/,
}))

/// Returns an extension that highlights whitespace, adding a
/// `cm-highlightSpace` class to stretches of spaces, and a
/// `cm-highlightTab` class to individual tab characters. By default,
/// the former are shown as faint dots, and the latter as arrows.
export function highlightWhitespace() {
  return whitespaceHighlighter
}

const trailingHighlighter = matcher(new MatchDecorator({
  regexp: /\s+$/g,
  decoration: Decoration.mark({class: "cm-trailingSpace"}),
  boundary: /\S/,
}))

/// Returns an extension that adds a `cm-trailingSpace` class to all
/// trailing whitespace.
export function highlightTrailingWhitespace() {
  return trailingHighlighter
}
