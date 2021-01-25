## 0.17.7 (2021-01-25)

### New features

Add an `EditorView.announce` state effect that can be used to conveniently provide screen reader announcements.

## 0.17.6 (2021-01-22)

### Bug fixes

Avoid creating very high scroll containers for large documents so that we don't overflow the DOM's fixed-precision numbers.

## 0.17.5 (2021-01-15)

### Bug fixes

Fix a bug that would create space-filling placeholders with incorrect height when document is very large.

## 0.17.4 (2021-01-14)

### Bug fixes

The `drawSelection` extension will now reuse cursor DOM nodes when the number of cursors stays the same, allowing some degree of cursor transition animation.

Makes highlighted special characters styleable (``) and fix their default look in dark themes to have appropriate contrast.

### New features

Adds a new `MatchDecorator` helper class which can be used to easily maintain decorations on content that matches a regular expression.

## 0.17.3 (2021-01-06)

### New features

The package now also exports a CommonJS module.

## 0.17.2 (2021-01-04)

### Bug fixes

Work around Chrome problem where the native shift-enter behavior inserts two line breaks.

Make bracket closing and bracket pair removing more reliable on Android.

Fix bad cursor position and superfluous change transactions after pressing enter when in a composition on Android.

Fix issue where the wrong character was deleted when backspacing out a character before an identical copy of that character on Android.

## 0.17.1 (2020-12-30)

### Bug fixes

Fix a bug that prevented `ViewUpdate.focusChanged` from ever being true.

## 0.17.0 (2020-12-29)

### Breaking changes

First numbered release.

