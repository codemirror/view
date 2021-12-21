import {tempView} from "@codemirror/buildhelper/lib/tempview"
import {EditorView, Decoration, WidgetType} from "@codemirror/view"
import {Range} from "@codemirror/rangeset"
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
      ist(cm.posAtCoords({x: coords.left, y: coords.top}), i)
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
    let sides = Array.prototype.map.call(cm.contentDOM.querySelectorAll(".widget"), w => w.getBoundingClientRect().top)
    ist(near(cm.coordsAtPos(0, 1)!.bottom, sides[0]))
    ist(near(cm.coordsAtPos(0, -1)!.bottom, sides[0]))
    ist(near(cm.coordsAtPos(1, 1)!.bottom, sides[1]))
    ist(near(cm.coordsAtPos(1, -1)!.bottom, sides[1]))
    ist(near(cm.coordsAtPos(2, 1)!.bottom, sides[2]))
    ist(near(cm.coordsAtPos(2, -1)!.bottom, sides[2]))
  })

  it("takes coordinates after side=-1 block widgets", () => {
    let widget = Decoration.widget({widget: block, side: -1, block: true})
    let cm = tempView("ab", [deco(widget.range(0), widget.range(1), widget.range(2))])
    let sides = Array.prototype.map.call(cm.contentDOM.querySelectorAll(".widget"), w => w.getBoundingClientRect().bottom)
    ist(near(cm.coordsAtPos(0, 1)!.top, sides[0]))
    ist(near(cm.coordsAtPos(0, -1)!.top, sides[0]))
    ist(near(cm.coordsAtPos(1, 1)!.top, sides[1]))
    ist(near(cm.coordsAtPos(1, -1)!.top, sides[1]))
    ist(near(cm.coordsAtPos(2, 1)!.top, sides[2]))
    ist(near(cm.coordsAtPos(2, -1)!.top, sides[2]))
  })
})
