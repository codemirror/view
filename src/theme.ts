import {Facet} from "@codemirror/state"
import {StyleModule, StyleSpec} from "style-mod"

export const theme = Facet.define<string, string>({combine: strs => strs.join(" ")})

export const darkTheme = Facet.define<boolean, boolean>({combine: values => values.indexOf(true) > -1})

export const baseThemeID = StyleModule.newName(), baseLightID = StyleModule.newName(), baseDarkID = StyleModule.newName()

export const lightDarkIDs = {"&light": "." + baseLightID, "&dark": "." + baseDarkID}

export function buildTheme(main: string, spec: {[name: string]: StyleSpec}, scopes?: {[name: string]: string}) {
  return new StyleModule(spec, {
    finish(sel) {
      return /&/.test(sel) ? sel.replace(/&\w*/, m => {
        if (m == "&") return main
        if (!scopes || !scopes[m]) throw new RangeError(`Unsupported selector: ${m}`)
        return scopes[m]
      }) : main + " " + sel
    }
  })
}

export const baseTheme = buildTheme("." + baseThemeID, {
  "&.cm-editor": {
    position: "relative !important",
    boxSizing: "border-box",
    "&.cm-focused": {
      // Provide a simple default outline to make sure a focused
      // editor is visually distinct. Can't leave the default behavior
      // because that will apply to the content element, which is
      // inside the scrollable container and doesn't include the
      // gutters. We also can't use an 'auto' outline, since those
      // are, for some reason, drawn behind the element content, which
      // will cause things like the active line background to cover
      // the outline (#297).
      outline: "1px dotted #212121"
    },
    display: "flex !important",
    flexDirection: "column"
  },

  ".cm-scroller": {
    display: "flex !important",
    alignItems: "flex-start !important",
    fontFamily: "monospace",
    lineHeight: 1.4,
    height: "100%",
    overflowX: "auto",
    position: "relative",
    zIndex: 0
  },

  ".cm-content": {
    margin: 0,
    flexGrow: 2,
    flexShrink: 0,
    minHeight: "100%",
    display: "block",
    whiteSpace: "pre",
    wordWrap: "normal", // https://github.com/codemirror/dev/issues/456
    boxSizing: "border-box",

    padding: "4px 0",
    outline: "none",

    "&[contenteditable=true]": {
      WebkitUserModify: "read-write-plaintext-only",
    }
  },

  ".cm-lineWrapping": {
    whiteSpace_fallback: "pre-wrap", // For IE
    whiteSpace: "break-spaces",
    wordBreak: "break-word", // For Safari, which doesn't support overflow-wrap: anywhere
    overflowWrap: "anywhere",
    flexShrink: 1
  },

  "&light .cm-content": { caretColor: "black" },
  "&dark .cm-content": { caretColor: "white" },

  ".cm-line": {
    display: "block",
    padding: "0 2px 0 4px"
  },

  ".cm-selectionLayer": {
    zIndex: -1,
    contain: "size style"
  },

  ".cm-selectionBackground": {
    position: "absolute",
  },
  "&light .cm-selectionBackground": {
    background: "#d9d9d9"
  },
  "&dark .cm-selectionBackground": {
    background: "#222"
  },
  "&light.cm-focused .cm-selectionBackground": {
    background: "#d7d4f0"
  },
  "&dark.cm-focused .cm-selectionBackground": {
    background: "#233"
  },

  ".cm-cursorLayer": {
    zIndex: 100,
    contain: "size style",
    pointerEvents: "none"
  },
  "&.cm-focused .cm-cursorLayer": {
    animation: "steps(1) cm-blink 1.2s infinite"
  },

  // Two animations defined so that we can switch between them to
  // restart the animation without forcing another style
  // recomputation.
  "@keyframes cm-blink": {"0%": {}, "50%": {opacity: 0}, "100%": {}},
  "@keyframes cm-blink2": {"0%": {}, "50%": {opacity: 0}, "100%": {}},

  ".cm-cursor, .cm-dropCursor": {
    position: "absolute",
    borderLeft: "1.2px solid black",
    marginLeft: "-0.6px",
    pointerEvents: "none",
  },
  ".cm-cursor": {
    display: "none"
  },
  "&dark .cm-cursor": {
    borderLeftColor: "#444"
  },

  "&.cm-focused .cm-cursor": {
    display: "block"
  },

  "&light .cm-activeLine": { backgroundColor: "#f3f9ff" },
  "&dark .cm-activeLine": { backgroundColor: "#223039" },

  "&light .cm-specialChar": { color: "red" },
  "&dark .cm-specialChar": { color: "#f78" },

  ".cm-gutters": {
    display: "flex",
    height: "100%",
    boxSizing: "border-box",
    left: 0,
    zIndex: 200
  },

  "&light .cm-gutters": {
    backgroundColor: "#f5f5f5",
    color: "#6c6c6c",
    borderRight: "1px solid #ddd"
  },

  "&dark .cm-gutters": {
    backgroundColor: "#333338",
    color: "#ccc"
  },

  ".cm-gutter": {
    display: "flex !important", // Necessary -- prevents margin collapsing
    flexDirection: "column",
    flexShrink: 0,
    boxSizing: "border-box",
    minHeight: "100%",
    overflow: "hidden"
  },

  ".cm-gutterElement": {
    boxSizing: "border-box"
  },

  ".cm-lineNumbers .cm-gutterElement": {
    padding: "0 3px 0 5px",
    minWidth: "20px",
    textAlign: "right",
    whiteSpace: "nowrap"
  },

  "&light .cm-activeLineGutter": {
    backgroundColor: "#e2f2ff"
  },

  "&dark .cm-activeLineGutter": {
    backgroundColor: "#222227"
  },

  ".cm-panels": {
    boxSizing: "border-box",
    position: "sticky",
    left: 0,
    right: 0
  },
  "&light .cm-panels": {
    backgroundColor: "#f5f5f5",
    color: "black"
  },
  "&light .cm-panels-top": {
    borderBottom: "1px solid #ddd"
  },
  "&light .cm-panels-bottom": {
    borderTop: "1px solid #ddd"
  },
  "&dark .cm-panels": {
    backgroundColor: "#333338",
    color: "white"
  },

  ".cm-tab": {
    display: "inline-block",
    overflow: "hidden",
    verticalAlign: "bottom"
  },

  ".cm-widgetBuffer": {
    verticalAlign: "text-top",
    height: "1em",
    display: "inline"
  },

  ".cm-placeholder": {
    color: "#888",
    display: "inline-block",
    verticalAlign: "top",
  },

  ".cm-button": {
    verticalAlign: "middle",
    color: "inherit",
    fontSize: "70%",
    padding: ".2em 1em",
    borderRadius: "1px"
  },

  "&light .cm-button": {
    backgroundImage: "linear-gradient(#eff1f5, #d9d9df)",
    border: "1px solid #888",
    "&:active": {
      backgroundImage: "linear-gradient(#b4b4b4, #d0d3d6)"
    }
  },

  "&dark .cm-button": {
    backgroundImage: "linear-gradient(#393939, #111)",
    border: "1px solid #888",
    "&:active": {
      backgroundImage: "linear-gradient(#111, #333)"
    }
  },

  ".cm-textfield": {
    verticalAlign: "middle",
    color: "inherit",
    fontSize: "70%",
    border: "1px solid silver",
    padding: ".2em .5em"
  },

  "&light .cm-textfield": {
    backgroundColor: "white"
  },

  "&dark .cm-textfield": {
    border: "1px solid #555",
    backgroundColor: "inherit"
  }
}, lightDarkIDs)
