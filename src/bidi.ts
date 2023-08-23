import {EditorSelection, SelectionRange, Line, findClusterBreak} from "@codemirror/state"

/// Used to indicate [text direction](#view.EditorView.textDirection).
export enum Direction {
  // (These are chosen to match the base levels, in bidi algorithm
  // terms, of spans in that direction.)
  /// Left-to-right.
  LTR = 0,
  /// Right-to-left.
  RTL = 1
}

const LTR = Direction.LTR, RTL = Direction.RTL

// Codes used for character types:
const enum T {
  L = 1, // Left-to-Right
  R = 2, // Right-to-Left
  AL = 4, // Right-to-Left Arabic
  EN = 8, // European Number
  AN = 16, // Arabic Number
  ET = 64, // European Number Terminator
  CS = 128, // Common Number Separator
  NI = 256, // Neutral or Isolate (BN, N, WS),
  NSM = 512, // Non-spacing Mark
  Strong = T.L | T.R | T.AL,
  Num = T.EN | T.AN
}

// Decode a string with each type encoded as log2(type)
function dec(str: string): readonly T[] {
  let result = []
  for (let i = 0; i < str.length; i++) result.push(1 << +str[i])
  return result
}

// Character types for codepoints 0 to 0xf8
const LowTypes = dec("88888888888888888888888888888888888666888888787833333333337888888000000000000000000000000008888880000000000000000000000000088888888888888888888888888888888888887866668888088888663380888308888800000000000000000000000800000000000000000000000000000008")

// Character types for codepoints 0x600 to 0x6f9
const ArabicTypes = dec("4444448826627288999999999992222222222222222222222222222222222222222222222229999999999999999999994444444444644222822222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222999999949999999229989999223333333333")

const Brackets = Object.create(null), BracketStack: number[] = []
// There's a lot more in
// https://www.unicode.org/Public/UCD/latest/ucd/BidiBrackets.txt,
// which are left out to keep code size down.
for (let p of ["()", "[]", "{}"]) {
  let l = p.charCodeAt(0), r = p.charCodeAt(1)
  Brackets[l] = r; Brackets[r] = -l
}

// Tracks direction in and before bracketed ranges.
const enum Bracketed {
  OppositeBefore = 1,
  EmbedInside = 2,
  OppositeInside = 4,
  MaxDepth = 3 * 63
}

function charType(ch: number) {
  return ch <= 0xf7 ? LowTypes[ch] :
    0x590 <= ch && ch <= 0x5f4 ? T.R :
    0x600 <= ch && ch <= 0x6f9 ? ArabicTypes[ch - 0x600] :
    0x6ee <= ch && ch <= 0x8ac ? T.AL :
    0x2000 <= ch && ch <= 0x200b ? T.NI :
    0xfb50 <= ch && ch <= 0xfdff ? T.AL :
    ch == 0x200c ? T.NI : T.L
}

const BidiRE = /[\u0590-\u05f4\u0600-\u06ff\u0700-\u08ac\ufb50-\ufdff]/

/// Represents a contiguous range of text that has a single direction
/// (as in left-to-right or right-to-left).
export class BidiSpan {
  /// The direction of this span.
  get dir(): Direction { return this.level % 2 ? RTL : LTR }

  /// @internal
  constructor(
    /// The start of the span (relative to the start of the line).
    readonly from: number,
    /// The end of the span.
    readonly to: number,
    /// The ["bidi
    /// level"](https://unicode.org/reports/tr9/#Basic_Display_Algorithm)
    /// of the span (in this context, 0 means
    /// left-to-right, 1 means right-to-left, 2 means left-to-right
    /// number inside right-to-left text).
    readonly level: number
  ) {}

  /// @internal
  side(end: boolean, dir: Direction) { return (this.dir == dir) == end ? this.to : this.from }

  /// @internal
  static find(order: readonly BidiSpan[], index: number, level: number, assoc: number) {
    let maybe = -1
    for (let i = 0; i < order.length; i++) {
      let span = order[i]
      if (span.from <= index && span.to >= index) {
        if (span.level == level) return i
        // When multiple spans match, if assoc != 0, take the one that
        // covers that side, otherwise take the one with the minimum
        // level.
        if (maybe < 0 || (assoc != 0 ? (assoc < 0 ? span.from < index : span.to > index) : order[maybe].level > span.level))
          maybe = i
      }
    }
    if (maybe < 0) throw new RangeError("Index out of range")
    return maybe
  }
}

// Arrays of isolates are always sorted by position. Isolates are
// never empty. Nested isolates don't stick out of their parent.
type Isolate = {from: number, to: number, direction: Direction, inner: readonly Isolate[]}

// Reused array of character types
const types: T[] = []

// Fill in the character types (in `types`) from `from` to `to` and
// apply W normalization rules.
function computeCharTypes(line: string, from: number, to: number, isolates: readonly Isolate[], outerType: T) {
  for (let iI = 0; iI <= isolates.length; iI++) {
    let sFrom = iI ? isolates[iI].to : from, sTo = iI < isolates.length ? isolates[iI].from : to
    let prevType = iI ? T.NI : outerType
    
    // W1. Examine each non-spacing mark (NSM) in the level run, and
    // change the type of the NSM to the type of the previous
    // character. If the NSM is at the start of the level run, it will
    // get the type of sor.
    // W2. Search backwards from each instance of a European number
    // until the first strong type (R, L, AL, or sor) is found. If an
    // AL is found, change the type of the European number to Arabic
    // number.
    // W3. Change all ALs to R.
    // (Left after this: L, R, EN, AN, ET, CS, NI)
    for (let i = sFrom, prev = prevType, prevStrong = prevType; i < sTo; i++) {
      let type = charType(line.charCodeAt(i))
      if (type == T.NSM) type = prev
      else if (type == T.EN && prevStrong == T.AL) type = T.AN
      types[i] = type == T.AL ? T.R : type
      if (type & T.Strong) prevStrong = type
      prev = type
    }

    // W5. A sequence of European terminators adjacent to European
    // numbers changes to all European numbers.
    // W6. Otherwise, separators and terminators change to Other
    // Neutral.
    // W7. Search backwards from each instance of a European number
    // until the first strong type (R, L, or sor) is found. If an L is
    // found, then change the type of the European number to L.
    // (Left after this: L, R, EN+AN, NI)
    for (let i = sFrom, prev = prevType, prevStrong = prevType; i < sTo; i++) {
      let type = types[i]
      if (type == T.CS) {
        if (i < sTo - 1 && prev == types[i + 1] && (prev & T.Num)) type = types[i] = prev
        else types[i] = T.NI
      } else if (type == T.ET) {
        let end = i + 1
        while (end < sTo && types[end] == T.ET) end++
        let replace = (i && prev == T.EN) || (end < to && types[end] == T.EN) ? (prevStrong == T.L ? T.L : T.EN) : T.NI
        for (let j = i; j < end; j++) types[j] = replace
        i = end - 1
      } else if (type == T.EN && prevStrong == T.L) {
        types[i] = T.L
      }
      prev = type
      if (type & T.Strong) prevStrong = type
    }
  }
}

// Process brackets throughout a run sequence.
function processBracketPairs(line: string, ranges: number[], outerType: T) {
  let oppositeType = outerType == T.L ? T.R : T.L

  for (let r = 0, sI = 0, context = 0; r < ranges.length;) {
    let from = ranges[r++], to = ranges[r++]
    // N0. Process bracket pairs in an isolating run sequence
    // sequentially in the logical order of the text positions of the
    // opening paired brackets using the logic given below. Within this
    // scope, bidirectional types EN and AN are treated as R.
    for (let i = from, ch, br, type; i < to; i++) {
      // Keeps [startIndex, type, strongSeen] triples for each open
      // bracket on BracketStack.
      if (br = Brackets[ch = line.charCodeAt(i)]) {
        if (br < 0) { // Closing bracket
          for (let sJ = sI - 3; sJ >= 0; sJ -= 3) {
            if (BracketStack[sJ + 1] == -br) {
              let flags = BracketStack[sJ + 2]
              let type = (flags & Bracketed.EmbedInside) ? outerType :
                !(flags & Bracketed.OppositeInside) ? 0 :
                (flags & Bracketed.OppositeBefore) ? oppositeType : outerType
              if (type) types[i] = types[BracketStack[sJ]] = type
              sI = sJ
              break
            }
          }
        } else if (BracketStack.length == Bracketed.MaxDepth) {
          break
        } else {
          BracketStack[sI++] = i
          BracketStack[sI++] = ch
          BracketStack[sI++] = context
        }
      } else if ((type = types[i]) == T.R || type == T.L) {
        let embed = type == outerType
        context = embed ? 0 : Bracketed.OppositeBefore
        for (let sJ = sI - 3; sJ >= 0; sJ -= 3) {
          let cur = BracketStack[sJ + 2]
          if (cur & Bracketed.EmbedInside) break
          if (embed) {
            BracketStack[sJ + 2] |= Bracketed.EmbedInside
          } else {
            if (cur & Bracketed.OppositeInside) break
            BracketStack[sJ + 2] |= Bracketed.OppositeInside
          }
        }
      }
    }
  }
}

function processNeutrals(ranges: number[], outerType: T) {
  for (let r = 0, prev = outerType; r < ranges.length;) {
    let from = ranges[r++], to = ranges[r++]
    // N1. A sequence of neutrals takes the direction of the
    // surrounding strong text if the text on both sides has the same
    // direction. European and Arabic numbers act as if they were R in
    // terms of their influence on neutrals. Start-of-level-run (sor)
    // and end-of-level-run (eor) are used at level run boundaries.
    // N2. Any remaining neutrals take the embedding direction.
    // (Left after this: L, R, EN+AN)
    for (let i = from; i < to;) {
      let type = types[i]
      if (type == T.NI) {
        let end = i + 1
        for (;;) {
          if (end == to) {
            if (r == ranges.length) break
            end = ranges[r++]; to = ranges[r++]
          } else if (types[end] == T.NI) {
            end++
          } else {
            break
          }
        }
        let beforeL = prev == T.L
        let afterL = (end < ranges[ranges.length - 1] ? types[end] : outerType) == T.L
        let replace = beforeL == afterL ? (beforeL ? T.L : T.R) : outerType
        for (let j = end, rJ = r, fromJ = ranges[r - 2]; j > i;) {
          if (j == fromJ) { j = ranges[--rJ]; fromJ = ranges[--rJ] }
          types[--j] = replace
        }
        i = end
      } else {
        prev = type
        i++
      }
    }
  }
}

function emitSimpleSpans(from: number, to: number, direction: Direction, order: BidiSpan[]) {
  if (direction == Direction.LTR) {
    for (let i = from; i < to;) {
      let start = i, rtl = types[i++] != T.L
      while (i < to && rtl == (types[i] != T.L)) i++
      if (rtl) {
        for (let j = i; j > start;) {
          let end = j, l = types[--j] != T.R
          while (j > start && l == (types[j - 1] != T.R)) j--
          order.push(new BidiSpan(j, end, l ? 2 : 1))
        }
      } else {
        order.push(new BidiSpan(start, i, 0))
      }
    }
  } else {
    for (let i = from; i < to;) {
      let start = i, rtl = types[i++] == T.R
      while (i < to && rtl == (types[i] == T.R)) i++
      order.push(new BidiSpan(start, i, rtl ? 1 : 2))
    }
  }
}

// FIXME name
function emitSpans(line: string, from: number, to: number,
                   direction: Direction, baseDirection: Direction,
                   isolates: readonly Isolate[], order: BidiSpan[]) {
  let level = direction == Direction.RTL ? 1 : types[from] == T.L ? 0 : 2
  if (direction == baseDirection) { // Don't flip
    for (let iCh = from, iI = 0; iCh < to;) {
      if (iI < isolates.length) {
        let next = isolates[iI++]
        if (next.from > iCh) order.push(new BidiSpan(iCh, next.from, level))
        computeSectionOrder(line, next.direction, baseDirection, next.inner, next.from, next.to, order)
        iCh = next.to
      } else {
        order.push(new BidiSpan(iCh, to, level))
        break
      }
    }
  } else { // Flip the spans
    for (let iCh = to, iI = isolates.length - 1; iCh > from;) {
      if (iI) {
        let next = isolates[iI--]
        if (next.to < iCh) order.push(new BidiSpan(next.to, iCh, level))
        computeSectionOrder(line, next.direction, baseDirection, next.inner, next.from, next.to, order)
        iCh = next.from
      } else {
        order.push(new BidiSpan(from, iCh, level))
        break
      }
    }
  }
}

function emitRecursiveSpans(line: string, from: number, to: number,
                            direction: Direction, baseDirection: Direction,
                            isolates: readonly Isolate[], order: BidiSpan[]) {
  let iI = 0, ourType = direction == Direction.LTR ? T.L : T.R

  for (let iCh = from; iCh < to;) {
    let sameDir = iI < isolates.length && iCh == isolates[iI].from || types[iCh] == ourType
    let localIsolates = [], iEnd = iCh
    for (;;) {
      if (iI < isolates.length && iEnd == isolates[iI].from) {
        let iso = isolates[iI++]
        localIsolates.push(iso)
        iEnd = iso.to
      } else if (iEnd == to || (sameDir ? types[iEnd] != ourType : types[iEnd] == ourType)) {
        // Back up over isolates at the end of a range that doesn't match direction
        if (iEnd == to && !sameDir) {
          while (iI && isolates[iI - 1].to) iEnd = isolates[--iI].from
        }
        break
      } else {
        iEnd++
      }
    }
    let innerDir = ourType ? direction : direction == Direction.LTR ? Direction.RTL : Direction.LTR
    if (ourType || direction == Direction.RTL)
      emitSpans(line, iCh, iEnd, direction, baseDirection, localIsolates, order)
    else
      emitRecursiveSpans(line, iCh, iEnd, innerDir, baseDirection, localIsolates, order)
  }
}

function computeSectionOrder(line: string, direction: Direction, baseDirection: Direction,
                             isolates: readonly Isolate[],
                             from: number, to: number, order: BidiSpan[]) {
  let ranges = [from]
  for (let isolate of isolates) ranges.push(isolate.from, isolate.to)
  if (isolates) while (to > types.length) types[types.length] = T.NI // Make sure types array has no gaps
  ranges.push(to)

  let outerType = (direction == LTR ? T.L : T.R) as T
  computeCharTypes(line, from, to, isolates, outerType)
  processBracketPairs(line, ranges, outerType)
  processNeutrals(ranges, outerType)

  if (!isolates.length) emitSimpleSpans(from, to, direction, order)
  else emitRecursiveSpans(line, from, to, direction, baseDirection, isolates, order)
}

export function computeOrder(line: string, direction: Direction, isolates: readonly Isolate[]) {
  let len = line.length

  if (!line || direction == Direction.LTR && !isolates.length && !BidiRE.test(line)) return trivialOrder(len)

  let order: BidiSpan[] = []
  computeSectionOrder(line, direction, direction, isolates, 0, line.length, order)
  return order
}

export function trivialOrder(length: number) {
  return [new BidiSpan(0, length, 0)]
}

export let movedOver = ""

export function moveVisually(line: Line, order: readonly BidiSpan[], dir: Direction,
                             start: SelectionRange, forward: boolean) {
  let startIndex = start.head - line.from, spanI = -1
  if (startIndex == 0) {
    if (!forward || !line.length) return null
    if (order[0].level != dir) {
      startIndex = order[0].side(false, dir)
      spanI = 0
    }
  } else if (startIndex == line.length) {
    if (forward) return null
    let last = order[order.length - 1]
    if (last.level != dir) {
      startIndex = last.side(true, dir)
      spanI = order.length - 1
    }
  }

  if (spanI < 0) spanI = BidiSpan.find(order, startIndex, start.bidiLevel ?? -1, start.assoc)
  let span = order[spanI]
  // End of span. (But not end of line--that was checked for above.)
  if (startIndex == span.side(forward, dir)) {
    span = order[spanI += forward ? 1 : -1]
    startIndex = span.side(!forward, dir)
  }
  let indexForward = forward == (span.dir == dir)
  let nextIndex = findClusterBreak(line.text, startIndex, indexForward)
  movedOver = line.text.slice(Math.min(startIndex, nextIndex), Math.max(startIndex, nextIndex))

  if (nextIndex != span.side(forward, dir))
    return EditorSelection.cursor(nextIndex + line.from, indexForward ? -1 : 1, span.level)
  let nextSpan = spanI == (forward ? order.length - 1 : 0) ? null : order[spanI + (forward ? 1 : -1)]
  if (!nextSpan && span.level != dir)
    return EditorSelection.cursor(forward ? line.to : line.from, forward ? -1 : 1, dir)
  if (nextSpan && nextSpan.level < span.level)
    return EditorSelection.cursor(nextSpan.side(!forward, dir) + line.from, forward ? 1 : -1, nextSpan.level)
  return EditorSelection.cursor(nextIndex + line.from, forward ? -1 : 1, span.level)
}
