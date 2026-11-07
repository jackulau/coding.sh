// Tiny glob → RegExp for overlay/hidden-test selection. Supports "**" (any
// depth, including zero dirs), "*" and "?" within a segment, and "{a,b}".
// Paths are POSIX-style and relative. A pattern without glob characters also
// matches everything under it when it names a directory ("dir" ≡ "dir/**").

const cache = new Map<string, RegExp>();

export function hasGlob(p: string): boolean {
  return /[*?{[]/.test(p);
}

export function globToRegExp(pattern: string): RegExp {
  const hit = cache.get(pattern);
  if (hit) return hit;
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i] as string;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        const slashAfter = pattern[i + 2] === "/";
        re += slashAfter ? "(?:.*/)?" : ".*";
        i += slashAfter ? 2 : 1;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const end = pattern.indexOf("}", i);
      if (end < 0) re += "\\{";
      else {
        re += `(?:${pattern
          .slice(i + 1, end)
          .split(",")
          .map((s) => s.replace(/[.+^$()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"))
          .join("|")})`;
        i = end;
      }
    } else re += c.replace(/[.+^$()|[\]\\/]/g, "\\$&");
  }
  const out = new RegExp(`^${re}$`);
  cache.set(pattern, out);
  return out;
}

export function matchGlob(path: string, pattern: string): boolean {
  const p = pattern.replace(/^\.\//, "").replace(/\/$/, "");
  if (!hasGlob(p)) return path === p || path.startsWith(`${p}/`);
  return globToRegExp(p).test(path);
}

export function matchAny(path: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => matchGlob(path, p));
}

/** Leading directory of a pattern that contains no glob characters ("" for none). */
export function staticPrefix(pattern: string): string {
  const segs = pattern.replace(/^\.\//, "").split("/");
  const out: string[] = [];
  for (const s of segs) {
    if (hasGlob(s)) break;
    out.push(s);
  }
  return out.join("/");
}
