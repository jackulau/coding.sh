#!/usr/bin/env python3
"""Cut the self-hosted Geist fonts down to what a first paint needs.

    python3 -m pip install fonttools brotli
    python3 apps/site/scripts/subset-fonts.py

Reads the originals in src/assets/fonts/source/ (never imported by the site)
and writes, next to them in src/assets/fonts/:

  geist-core.woff2       Geist, ASCII + the typographic extras the site uses
  geist-rest.woff2       Geist, every other codepoint the old face covered
  geist-mono-core.woff2  Geist Mono, same split
  geist-mono-rest.woff2
  geist-mono-box.woff2   Geist Mono box-drawing face

Each file also drops the weights below 400 (the wght axis keeps 400-900), which
global.css never asks for. The script then checks every glyph's outline and
advance against the original at each weight the CSS allows (every 10 units),
and keeps the file un-instanced if anything moved: the cut must not change a
pixel. (Cutting the top of the axis too, to 700/600, rescales the deltas, and
their rounding moved weight-600 headings by a subpixel in screenshot diffs.)

The core/rest split keeps the old coverage exactly: for each face it takes the
codepoints the old unicode-range allowed AND the font actually has, then puts
CORE ones in -core and the rest in -rest. It prints the unicode-range for each
file; paste them into global.css. A page loads a -rest file only if it uses
one of its characters. Only the -core files are preloaded (Layout.astro).

Outputs are deterministic (no timestamp bump), so an unchanged run keeps the
same /_astro hashes.
"""

import io
import os
import sys

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

HERE = os.path.dirname(os.path.abspath(__file__))
FONTS = os.path.join(HERE, "..", "src", "assets", "fonts")
SOURCE = os.path.join(FONTS, "source")

# The unicode-range the original latin faces were declared with.
LATIN = (
    "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,"
    "U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD"
)
BOX = "U+2000-2001,U+2004-2008,U+200A,U+23B8-23BD,U+2500-259F"

# What goes in the preloaded core file: printable ASCII plus the punctuation
# the site's pages and docs use (nbsp, section, guillemets, plus-minus, middle
# dot, times, dashes, curly quotes, bullet, ellipsis, primes, arrows, minus).
CORE = (
    "U+0020-007E,U+00A0,U+00A7,U+00AB,U+00B1,U+00B2,U+00B7,U+00BB,U+00D7,U+2013-2014,U+2018-201A,"
    "U+201C-201E,U+2022,U+2026,U+2032-2033,U+2039-203A,U+2190-2193,U+2212,U+2713,U+FEFF,U+FFFD"
)

# Lightest weight the site uses; the wght axis keeps its default (400) and max.
MIN_WGHT = 400

JOBS = [
    # source file, its declared unicode-range, heaviest weight the @font-face allows,
    # [(output, True=core / False=rest / None=all)]
    ("geist-latin.woff2", LATIN, 700, [("geist-core.woff2", True), ("geist-rest.woff2", False)]),
    ("geist-mono-latin.woff2", LATIN, 600, [("geist-mono-core.woff2", True), ("geist-mono-rest.woff2", False)]),
    ("geist-mono-box.woff2", BOX, 600, [("geist-mono-box.woff2", None)]),
]


def ranges(cps):
    """Codepoints -> a compact CSS unicode-range."""
    out, cps = [], sorted(cps)
    i = 0
    while i < len(cps):
        j = i
        while j + 1 < len(cps) and cps[j + 1] == cps[j] + 1:
            j += 1
        out.append(f"U+{cps[i]:04X}" if i == j else f"U+{cps[i]:04X}-{cps[j]:04X}")
        i = j + 1
    return ", ".join(out)


def options():
    o = subset.Options()
    o.layout_features = ["*"]  # keep kerning, ss01, tnum, case, ... intact
    o.name_IDs = ["*"]
    o.name_languages = ["*"]
    o.notdef_outline = True
    o.glyph_names = False
    o.flavor = "woff2"
    return o


def to_bytes(font, flavor=None):
    buf = io.BytesIO()
    font.flavor = flavor
    font.save(buf)
    return buf.getvalue()


def same_glyphs(src, cut, max_wght):
    """True if every glyph in `cut` draws exactly as in `src` at each allowed weight."""
    for w in range(MIN_WGHT, max_wght + 1, 10):
        a = instancer.instantiateVariableFont(TTFont(io.BytesIO(src)), {"wght": w})
        b = instancer.instantiateVariableFont(TTFont(io.BytesIO(cut)), {"wght": w})
        ac, bc = a.getBestCmap(), b.getBestCmap()
        for cp, gb in bc.items():
            ga = ac[cp]
            pa = list(a["glyf"][ga].getCoordinates(a["glyf"])[0])
            pb = list(b["glyf"][gb].getCoordinates(b["glyf"])[0])
            if pa != pb or a["hmtx"][ga] != b["hmtx"][gb]:
                return False
    return True


def build(src, unicodes, max_wght, dest):
    with open(src, "rb") as f:
        original = to_bytes(TTFont(f, recalcTimestamp=False))
    font = TTFont(io.BytesIO(original), recalcTimestamp=False)
    sub = subset.Subsetter(options())
    sub.populate(unicodes=unicodes)
    sub.subset(font)
    subsetted = to_bytes(font)
    cut = to_bytes(instancer.instantiateVariableFont(TTFont(io.BytesIO(subsetted), recalcTimestamp=False), {"wght": (MIN_WGHT, None)}))
    instanced = same_glyphs(original, cut, max_wght)
    data = to_bytes(TTFont(io.BytesIO(cut if instanced else subsetted), recalcTimestamp=False), "woff2")
    with open(dest, "wb") as f:
        f.write(data)
    return len(data), instanced


def main():
    core = set(subset.parse_unicodes(CORE))
    for name, declared, max_wght, outs in JOBS:
        src = os.path.join(SOURCE, name)
        have = set(TTFont(src).getBestCmap())
        covered = have & set(subset.parse_unicodes(declared))
        print(f"{name}  {os.path.getsize(src)} B, {len(covered)} codepoints in its unicode-range")
        for out, is_core in outs:
            cps = covered if is_core is None else {c for c in covered if (c in core) == is_core}
            size, instanced = build(src, cps, max_wght, os.path.join(FONTS, out))
            wght = f"wght {MIN_WGHT}+" if instanced else "all weights (a glyph moved when cut)"
            print(f"  {out}  {size} B, {len(cps)} codepoints, {wght}")
            print(f"    unicode-range: {ranges(cps)};")
            if size < 4096:
                print("    WARNING: under Vite's 4KB inline limit; it would be base64'd into the CSS", file=sys.stderr)


if __name__ == "__main__":
    main()
