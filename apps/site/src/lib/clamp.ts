// No imports, so a node test can load this file directly.

/**
 * A meta description of at most `max` characters: whole sentences while they
 * fit, else whole words and an ellipsis. Search results cut longer ones anyway.
 * A sentence ends at . ! or ? before a space or the end of the text, so the dot
 * in "coding.sh" or "v0.1.2" does not end one.
 */
export function clampDescription(text: string, max = 155): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  let out = "";
  for (const s of t.match(/.+?[.!?]+(?:\s|$)|.+$/g) ?? []) {
    if ((out + s).trimEnd().length > max) break;
    out += s;
  }
  if (out.trim().length >= max * 0.6) return out.trim();
  const cut = t.slice(0, max - 1);
  return `${cut.slice(0, cut.lastIndexOf(" ")).replace(/[,;:]$/, "")}…`;
}
