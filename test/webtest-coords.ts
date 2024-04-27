import {tempView} from "./tempview.js"
import {EditorView, Decoration, WidgetType} from "@codemirror/view"
import {Range} from "@codemirror/state"
import ist from "ist"

const inline = new class extends WidgetType {
  toDOM() {
    let span = document.createElement("span")
    span.className = "widget"
    span.textContent = "X"
    return span
  }
}
const block = new class extends WidgetType {
  toDOM() {
    let span = document.createElement("div")
    span.className = "widget"
    span.textContent = "X"
    return span
  }
}

function deco(...deco: Range<Decoration>[]) {
  return EditorView.decorations.of(Decoration.set(deco))
}

describe("EditorView coords", () => {
  it("can find coordinates for simple text", () => {
    let cm = tempView("one two\n\nthree"), prev = null
    for (let i = 0; i < cm.state.doc.length; i++) {
      let coords = cm.coordsAtPos(i)!
      if (prev) ist(prev.top < coords.top - 5 || prev.left < coords.left)
      prev = coords
      ist(cm.posAtCoords({x: coords.left, y: coords.top + 1}), i)
    }
  })

  it("can find coordinates in text scrolled into view horizontally", () => {
    let cm = tempView("l1\n" + "l2 ".repeat(400))
    let rect = cm.dom.getBoundingClientRect(), line2 = cm.coordsAtPos(3)!.top + 2
    cm.scrollDOM.scrollLeft = 0
    let right = cm.posAtCoords({x: rect.right - 2, y: line2})
    cm.scrollDOM.scrollLeft = (rect.right - rect.left) - 10
    ist(cm.posAtCoords({x: rect.right - 2, y: line2}), right, ">")
  })

  function near(a: number, b: any) {
    return Math.abs(a - b) < 5
  }

  it("takes coordinates before side=1 widgets", () => {
    let widget = Decoration.widget({widget: inline, side: 1})
    let cm = tempView("abdefg", [deco(widget.range(0), widget.range(3), widget.range(6))])
    let sides = Array.prototype.map.call(cm.contentDOM.querySelectorAll(".widget"), w => w.getBoundingClientRect().left)
    ist(near(cm.coordsAtPos(0, 1)!.left, sides[0]))
    ist(near(cm.coordsAtPos(0, -1)!.left, sides[0]))
    ist(near(cm.coordsAtPos(3, 1)!.left, sides[1]))
    ist(near(cm.coordsAtPos(3, -1)!.left, sides[1]))
    ist(near(cm.coordsAtPos(6, 1)!.left, sides[2]))
    ist(near(cm.coordsAtPos(6, -1)!.left, sides[2]))
  })

  it("takes coordinates after side=-1 widgets", () => {
    let widget = Decoration.widget({widget: inline, side: -1})
    let cm = tempView("abdefg", [deco(widget.range(0), widget.range(3), widget.range(6))])
    let sides = Array.prototype.map.call(cm.contentDOM.querySelectorAll(".widget"), w => w.getBoundingClientRect().right)
    ist(near(cm.coordsAtPos(0, 1)!.left, sides[0]))
    ist(near(cm.coordsAtPos(0, -1)!.left, sides[0]))
    ist(near(cm.coordsAtPos(3, 1)!.left, sides[1]))
    ist(near(cm.coordsAtPos(3, -1)!.left, sides[1]))
    ist(near(cm.coordsAtPos(6, 1)!.left, sides[2]))
    ist(near(cm.coordsAtPos(6, -1)!.left, sides[2]))
  })

  it("respects sides for widgets wrapped in marks", () => {
    let cm = tempView("a\n\nb\n\nd", [
      deco(Decoration.widget({widget: inline, side: 1}).range(2),
           Decoration.widget({widget: inline, side: -1}).range(5)),
      deco(Decoration.mark({class: "test"}).range(0, 7))
    ])
    let widgets = cm.contentDOM.querySelectorAll(".widget")
    let pos2 = widgets[0].getBoundingClientRect().left
    ist(near(cm.coordsAtPos(2, 1)!.left, pos2))
    ist(near(cm.coordsAtPos(2, -1)!.left, pos2))
    let pos5 = widgets[1].getBoundingClientRect().right
    ist(near(cm.coordsAtPos(5, 1)!.left, pos5))
    ist(near(cm.coordsAtPos(5, -1)!.left, pos5))
  })

  it("takes coordinates between widgets", () => {
    let wb = Decoration.widget({widget: inline, side: -1})
    let wa = Decoration.widget({widget: inline, side: 1})
    let cm = tempView("abdefg", [deco(wb.range(0), wa.range(0), wb.range(3), wa.range(3), wb.range(6), wa.range(6))])
    let sides = Array.prototype.map.call(cm.contentDOM.querySelectorAll(".widget"), w => w.getBoundingClientRect().right)
    ist(near(cm.coordsAtPos(0, 1)!.left, sides[0]))
    ist(near(cm.coordsAtPos(0, -1)!.left, sides[0]))
    ist(near(cm.coordsAtPos(3, 1)!.left, sides[2]))
    ist(near(cm.coordsAtPos(3, -1)!.left, sides[2]))
    ist(near(cm.coordsAtPos(6, 1)!.left, sides[4]))
    ist(near(cm.coordsAtPos(6, -1)!.left, sides[4]))
  })

  it("takes coordinates before side=1 block widgets", () => {
    let widget = Decoration.widget({widget: block, side: 1, block: true})
    let cm = tempView("ab", [deco(widget.range(0), widget.range(1), widget.range(2))])
    let sides = Array.from(cm.contentDOM.querySelectorAll(".widget")).map(w => w.getBoundingClientRect().top)
    ist(near(cm.coordsAtPos(0, -1)!.bottom, sides[0]))
    ist(near(cm.coordsAtPos(0, 1)!.bottom, sides[0]))
    ist(near(cm.coordsAtPos(0, 2 as any)!.bottom, sides[1]))
    ist(near(cm.coordsAtPos(1, -1)!.bottom, sides[1]))
    ist(near(cm.coordsAtPos(1, 1)!.bottom, sides[1]))
    ist(near(cm.coordsAtPos(1, 2 as any)!.bottom, sides[2]))
    ist(near(cm.coordsAtPos(2, -1)!.bottom, sides[2]))
    ist(near(cm.coordsAtPos(2, 1)!.bottom, sides[2]))
  })

  it("takes coordinates after side=-1 block widgets", () => {
    let widget = Decoration.widget({widget: block, side: -1, block: true})
    let cm = tempView("ab", [deco(widget.range(0), widget.range(1), widget.range(2))])
    let sides = Array.prototype.map.call(cm.contentDOM.querySelectorAll(".widget"), w => w.getBoundingClientRect().bottom)
    ist(near(cm.coordsAtPos(0, -1)!.top, sides[0]))
    ist(near(cm.coordsAtPos(0, 1)!.top, sides[0]))
    ist(near(cm.coordsAtPos(1, -1)!.top, sides[1]))
    ist(near(cm.coordsAtPos(1, -2 as any)!.top, sides[0]))
    ist(near(cm.coordsAtPos(1, 1)!.top, sides[1]))
    ist(near(cm.coordsAtPos(2, -1)!.top, sides[2]))
    ist(near(cm.coordsAtPos(2, -2 as any)!.top, sides[1]))
    ist(near(cm.coordsAtPos(2, 1)!.top, sides[2]))
  })

  it("takes coordinates around non-inclusive block widgets", () => {
    let widget = Decoration.replace({widget: block, inclusive: false, block: true})
    let cm = tempView("ab", [deco(widget.range(0, 2))])
    let rect = cm.contentDOM.querySelector(".widget")!.getBoundingClientRect()
    ist(near(cm.coordsAtPos(0, 1)!.bottom, rect.top))
    ist(near(cm.coordsAtPos(2, -1)!.top, rect.bottom))
  })

  it("takes proper coordinates for elements on decoration boundaries", () => {
    let cm = tempView("a b c", [deco(Decoration.mark({attributes: {style: "padding: 0 10px"}}).range(2, 3))])
    ist(near(cm.coordsAtPos(2, 1)!.left, cm.coordsAtPos(2, -1)!.left + 10))
    ist(near(cm.coordsAtPos(3, -1)!.left, cm.coordsAtPos(3, 1)!.left - 10))
  })
})

describe("coordsForChar", () => {
  function near(a: number, b: number) {
    return Math.abs(a - b) < 0.01
  }

  it("returns reasonable coords", () => {
    let cm = tempView("abc\ndef")
    let a = cm.coordsForChar(0)!, c = cm.coordsForChar(2)!, d = cm.coordsForChar(4)!, f = cm.coordsForChar(6)!
    ist(a.right, a.left, ">")
    ist(a.bottom, a.top, ">")
    ist(a.top, c.top, near)
    ist(a.bottom, c.bottom, near)
    ist(c.left, a.right, ">")
    ist(a.bottom, d.bottom, "<")
    ist(d.top, f.top, near)
    ist(f.left, c.left, near)
  })

  it("returns null for non-rendered characters", () => {
    let cm = tempView("abc\ndef\n", [deco(Decoration.replace({}).range(1, 2))])
    ist(cm.coordsForChar(1), null)
    ist(cm.coordsForChar(3), null)
    ist(cm.coordsForChar(8), null)
  })

  it("returns proper rectangles in right-to-left text", () => {
    let cm = tempView("شاهد")
    let first = cm.coordsForChar(0)!, last = cm.coordsForChar(cm.state.doc.length - 1)!
    ist(first.left, first.right, "<")
    ist(last.left, last.right, "<")
    ist(first.left, last.right, ">")
  })

  it("doesn't include space taken up by widgets", () => {
    let cm = tempView("abc", [deco(Decoration.widget({widget: inline, side: 1}).range(1),
                                   Decoration.widget({widget: inline, side: -1}).range(2))])
    let a = cm.coordsForChar(0)!, b = cm.coordsForChar(1)!, c = cm.coordsForChar(2)!
    let ws = cm.contentDOM.querySelectorAll(".widget") as NodeListOf<HTMLElement>
    let w1 = ws[0].getBoundingClientRect(), w2 = ws[1].getBoundingClientRect()
    let ε = 0.01
    ist(a.right - ε, w1.left, "<=")
    ist(b.left + ε, w1.right, ">=")
    ist(b.right - ε, w2.left, "<=")
    ist(c.left + ε, w2.right, ">=")
  })

  it("returns positions for wrap points", () => {
    let cm = tempView("aaaaaaaaa bbbbbbbbbbbbb", [EditorView.theme({"&": {maxWidth: "7em"}}), EditorView.lineWrapping])
    let a = cm.coordsForChar(0)!, b = cm.coordsForChar(10)!, wrap = cm.coordsForChar(9)!
    ist(a.top, b.top, "<")
    ist(wrap)
    ist(wrap.top, a.top, near)
    ist(wrap.top, b.top, "<")
    ist(wrap.left, a.right, ">")
  })
})
