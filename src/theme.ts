import {Facet} from "@codemirror/state"
import {StyleModule, StyleSpec} from "style-mod"

export const theme = Facet.define<string, string>({combine: strs => strs.join(" ")})

export const darkTheme = Facet.define<boolean, boolean>({combine: values => values.indexOf(true) > -1})

export const baseThemeID = StyleModule.newName()

export function buildTheme(main: string, spec: {[name: string]: StyleSpec}) {
  return new StyleModule(spec, {
    process(sel) {
      return /&/.test(sel) ? sel.replace(/&/g, main) : main + " " + sel
    },
    extend(template, sel) {
      return sel.slice(0, main.length + 1) == main + " "
        ? main + " " + template.replace(/&/g, sel.slice(main.length + 1))
        : template.replace(/&/g, sel)
    }
  })
}

export const baseTheme = buildTheme("." + baseThemeID, {
  "&": {
    position: "relative !important",
    boxSizing: "border-box",
    "&.cm-focused": {
      // FIXME it would be great if we could directly use the browser's
      // default focus outline, but it appears we can't, so this tries to
      // approximate that
      outline_fallback: "1px dotted #212121",
      outline: "5px auto -webkit-focus-ring-color"
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
    minHeight: "100%",
    display: "block",
    whiteSpace: "pre",
    boxSizing: "border-box",

    padding: "4px 0",
    outline: "none"
  },

  ".cm-lineWrapping": {
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere"
  },

  "&.cm-light .cm-content": { caretColor: "black" },
  "&.cm-dark .cm-content": { caretColor: "white" },

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
  "&.cm-light .cm-selectionBackground": {
    background: "#d9d9d9"
  },
  "&.cm-dark .cm-selectionBackground": {
    background: "#222"
  },
  "&.cm-focused.cm-light .cm-selectionBackground": {
    background: "#d7d4f0"
  },
  "&.cm-focused.cm-dark .cm-selectionBackground": {
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
  "@keyframes cm-blink": {"0%": {}, "50%": {visibility: "hidden"}, "100%": {}},
  "@keyframes cm-blink2": {"0%": {}, "50%": {visibility: "hidden"}, "100%": {}},

  ".cm-cursor": {
    position: "absolute",
    borderLeft: "1.2px solid black",
    marginLeft: "-0.6px",
    pointerEvents: "none",
    display: "none"
  },
  "&.cm-dark .cm-cursor": {
    borderLeftColor: "#444"
  },

  "&.cm-focused .cm-cursor": {
    display: "block"
  },

  "&.cm-light .cm-activeLine": { backgroundColor: "#f3f9ff" },
  "&.cm-dark .cm-activeLine": { backgroundColor: "#223039" },

  "&.cm-light .cm-specialChar": { color: "red" },
  "&.cm-dark .cm-specialChar": { color: "#f78" },

  ".cm-tab": {
    display: "inline-block",
    overflow: "hidden",
    verticalAlign: "bottom"
  },

  ".cm-placeholder": {
    color: "#888",
    display: "inline-block"
  },

  ".cm-button": {
    verticalAlign: "middle",
    color: "inherit",
    fontSize: "70%",
    padding: ".2em 1em",
    borderRadius: "3px"
  },

  "&.cm-light .cm-button": {
    backgroundImage: "linear-gradient(#eff1f5, #d9d9df)",
    border: "1px solid #888",
    "&:active": {
      backgroundImage: "linear-gradient(#b4b4b4, #d0d3d6)"
    }
  },

  "&.cm-dark .cm-button": {
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

  "&.cm-light .cm-textfield": {
    backgroundColor: "white"
  },

  "&.cm-dark .cm-textfield": {
    border: "1px solid #555",
    backgroundColor: "inherit"
  }
})
