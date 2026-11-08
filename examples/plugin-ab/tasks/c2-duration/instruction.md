Add `parseDuration(text)` to `src/duration.js` and export it. It turns strings like `"1h30m"`,
`"45s"`, `"2d"`, `"1h 5m"` and `"250ms"` into milliseconds. Units: d, h, m, s, ms. Spaces between
parts are fine. Anything else (empty string, unknown unit, a number with no unit, negative numbers)
throws a `RangeError`. Then give me a short summary of the edge cases you handled.
