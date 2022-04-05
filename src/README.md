The “view” is the part of the editor that the user sees—a DOM
component that displays the editor state and allows text input.

@EditorView

@Direction

@BlockInfo

@BlockType

@BidiSpan

@DOMEventHandlers

@DOMEventMap

@Rect

### Extending the View

@Command

@ViewPlugin

@PluginValue

@PluginSpec

@ViewUpdate

@logException

@MouseSelectionStyle

@drawSelection

@dropCursor

@highlightActiveLine

@highlightSpecialChars

@placeholder

@scrollPastEnd

### Key bindings

@KeyBinding

@keymap

@runScopeHandlers

### Decorations

Your code should not try to directly change the DOM structure
CodeMirror creates for its content—that will not work. Instead, the
way to influence how things are drawn is by providing decorations,
which can add styling or replace content with an alternative
representation.

@Decoration

@DecorationSet

@WidgetType

@Range

@MatchDecorator