import {WidgetType, BlockWrapper} from "./decoration"
import {Attrs} from "./attributes"

const noChildren: readonly Tile[] = []

export class Tile {
  parent: CompositeTile | null = null

  constructor(
    readonly dom: HTMLElement | Text,
    public length: number
  ) {}

  get breakAfter() { return 0 }

  get children() { return noChildren }
}

export class CompositeTile extends Tile {
  declare dom: HTMLElement
  _children: Tile[] = []

  constructor(dom: HTMLElement) {
    super(dom, 0)
  }

  get children() { return this._children }

  get lastChild() { return this.children.length ? this.children[this.children.length - 1] : null }

  append(child: Tile) {
    this.children.push(child)
    child.parent = this
    this.length += child.length + child.breakAfter
  }
}

export class DocTile extends CompositeTile {
  declare dom: HTMLElement
}

export class BlockWidgetTile extends Tile {
  declare dom: HTMLElement
  constructor(dom: HTMLElement, readonly widget: WidgetType, length: number) {
    super(dom, length)
  }
}

export class BlockWrapperTile extends CompositeTile {
  declare dom: HTMLElement
  constructor(dom: HTMLElement, readonly wrapper: BlockWrapper) {
    super(dom)
  }
}

export class LineTile extends CompositeTile {
  declare dom: HTMLElement
  constructor(dom: HTMLElement, readonly attrs: Attrs | null) {
    super(dom)
  }
}

export class TextTile extends Tile {
  declare dom: Text
  constructor(dom: Text, readonly text: string) {
    super(dom, text.length)
  }

  static of(text: string) {
    return new TextTile(document.createTextNode(text), text)
  }
}

export class WidgetTile extends Tile {
}
