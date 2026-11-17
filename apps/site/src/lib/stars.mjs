// The GitHub star count the nav shows next to its GitHub link. The build makes
// no request: it reads SITE_GITHUB_STARS, which the deploy job sets from
// scripts/stars.mjs. Without it the nav shows no count.

/** A star count from an env value: a whole number above zero, or undefined. */
export function parseStars(raw) {
  const s = String(raw ?? "").trim();
  return /^[1-9]\d{0,8}$/.test(s) ? Number(s) : undefined;
}

/** 117 → "117", 1234 → "1.2k", 48200 → "48.2k", 1234567 → "1.2M". Rounds down, so it never shows more stars than there are. */
export function formatStars(n) {
  if (n < 1000) return String(n);
  const [unit, letter] = n < 1e6 ? [1e3, "k"] : [1e6, "M"];
  const tenths = Math.floor((n * 10) / unit);
  const whole = Math.floor(tenths / 10);
  const tenth = tenths % 10;
  return `${whole}${whole < 100 && tenth ? `.${tenth}` : ""}${letter}`;
}
