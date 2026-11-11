// Terminal cell width of text: East Asian wide and fullwidth characters and
// most emoji take two cells, combining marks and zero-width characters none,
// ANSI color codes none. Enough for CLI tables; no grapheme clustering.

const ANSI = /\u001b\[[0-9;]*m/g;

/** Cells one code point takes: 0, 1 or 2. */
export function cpWidth(cp: number): number {
  if (cp === 0 || (cp >= 0x300 && cp <= 0x36f) || (cp >= 0x200b && cp <= 0x200f) || cp === 0x2060 || (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0x1ab0 && cp <= 0x1aff) || (cp >= 0x20d0 && cp <= 0x20ff)) return 0;
  if (cp < 0x1100) return 1;
  if (
    cp <= 0x115f ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f680 && cp <= 0x1f6ff) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x1fa70 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  )
    return 2;
  return 1;
}

/** Cells the text takes in a terminal. */
export function textWidth(s: string): number {
  let w = 0;
  for (const ch of s.replace(ANSI, "")) w += cpWidth(ch.codePointAt(0)!);
  return w;
}

/** The text cut to at most `w` cells, with "…" when it was cut. */
export function cutToWidth(s: string, w: number): string {
  if (textWidth(s) <= w) return s;
  let out = "";
  let used = 0;
  for (const ch of s) {
    const c = cpWidth(ch.codePointAt(0)!);
    if (used + c > w - 1) break;
    out += ch;
    used += c;
  }
  return w > 0 ? `${out}…` : "";
}

/** The text padded with spaces to `w` cells. */
export function padToWidth(s: string, w: number, align: "left" | "right" = "left"): string {
  const gap = " ".repeat(Math.max(0, w - textWidth(s)));
  return align === "right" ? gap + s : s + gap;
}
