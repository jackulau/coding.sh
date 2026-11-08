`parseLine` in `src/csv.js` breaks on real exports from our billing system: quoted fields that
contain commas, and quotes escaped by doubling them (`"say ""hi"" now"`). Fix it so it follows the
usual CSV rules for a single line, and tell me what you changed.
