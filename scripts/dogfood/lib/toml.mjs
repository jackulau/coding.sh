// Minimal TOML reader for eval task files. Scorer-owned on purpose: the
// scorer must not import parsing code from the package under test (a
// candidate could change it). Supports the subset task files use:
//   key = "basic" | 'literal' | """multi-line""" | '''multi-line''' | 123 | 1.5 | true
//   key = [ values, ... ]   (multi-line, trailing comma, nested arrays)
//   key = { a = 1, b = "x" } (inline tables)
//   dotted keys (a.b = 1), [table], [table.sub], [[array.of.tables]], # comments
// Anything else throws with a line number.

export function parseToml(src) {
  const root = {};
  let cur = root;
  let i = 0;
  let line = 1;
  const n = src.length;

  const fail = (msg) => {
    throw new Error(`toml: line ${line}: ${msg}`);
  };
  const peek = (k = 0) => src[i + k];
  const skipWs = () => {
    while (i < n && (src[i] === " " || src[i] === "\t")) i++;
  };
  const skipComment = () => {
    if (src[i] === "#") while (i < n && src[i] !== "\n") i++;
  };
  /** Whitespace, newlines and comments (inside arrays). */
  const skipAll = () => {
    for (;;) {
      skipWs();
      skipComment();
      if (src[i] === "\r") i++;
      if (src[i] === "\n") {
        i++;
        line++;
        continue;
      }
      break;
    }
  };
  const endOfLine = () => {
    skipWs();
    skipComment();
    if (src[i] === "\r") i++;
    if (i < n && src[i] !== "\n") fail(`unexpected ${JSON.stringify(src[i])}`);
    if (src[i] === "\n") {
      i++;
      line++;
    }
  };

  const bareKey = () => {
    const m = /^[A-Za-z0-9_-]+/.exec(src.slice(i, i + 256));
    if (!m) fail("expected a key");
    i += m[0].length;
    return m[0];
  };
  const keyPart = () => {
    skipWs();
    if (peek() === '"' || peek() === "'") return string();
    return bareKey();
  };
  const dottedKey = () => {
    const parts = [keyPart()];
    for (;;) {
      skipWs();
      if (peek() !== ".") break;
      i++;
      parts.push(keyPart());
    }
    return parts;
  };

  const ESC = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\" };
  function string() {
    const q = peek();
    const multi = src.startsWith(q.repeat(3), i);
    i += multi ? 3 : 1;
    if (multi && src[i] === "\n") {
      i++;
      line++;
    } else if (multi && src.startsWith("\r\n", i)) {
      i += 2;
      line++;
    }
    let out = "";
    for (;;) {
      if (i >= n) fail("unterminated string");
      const c = src[i];
      if (multi ? src.startsWith(q.repeat(3), i) : c === q) {
        i += multi ? 3 : 1;
        return out;
      }
      if (c === "\n") {
        if (!multi) fail("newline in string");
        line++;
      }
      if (c === "\\" && q === '"') {
        const e = src[i + 1];
        if (multi && (e === "\n" || e === " " || e === "\t" || e === "\r")) {
          // Line-ending backslash: trim whitespace through the next non-space.
          i++;
          while (i < n && /\s/.test(src[i])) {
            if (src[i] === "\n") line++;
            i++;
          }
          continue;
        }
        if (e === "u" || e === "U") {
          const len = e === "u" ? 4 : 8;
          const hex = src.slice(i + 2, i + 2 + len);
          if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== len) fail("bad unicode escape");
          out += String.fromCodePoint(parseInt(hex, 16));
          i += 2 + len;
          continue;
        }
        if (!(e in ESC)) fail(`bad escape \\${e}`);
        out += ESC[e];
        i += 2;
        continue;
      }
      out += c;
      i++;
    }
  }

  function value() {
    skipWs();
    const c = peek();
    if (c === '"' || c === "'") return string();
    if (c === "[") {
      i++;
      const arr = [];
      for (;;) {
        skipAll();
        if (peek() === "]") {
          i++;
          return arr;
        }
        arr.push(value());
        skipAll();
        if (peek() === ",") {
          i++;
          continue;
        }
        if (peek() === "]") {
          i++;
          return arr;
        }
        fail("expected , or ] in array");
      }
    }
    if (c === "{") {
      i++;
      const t = {};
      skipWs();
      if (peek() === "}") {
        i++;
        return t;
      }
      for (;;) {
        const k = dottedKey();
        skipWs();
        if (peek() !== "=") fail("expected = in inline table");
        i++;
        setPath(t, k, value());
        skipWs();
        if (peek() === ",") {
          i++;
          continue;
        }
        if (peek() === "}") {
          i++;
          return t;
        }
        fail("expected , or } in inline table");
      }
    }
    const m = /^(true|false|[+-]?(?:\d[\d_]*)(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)/.exec(src.slice(i, i + 64));
    if (!m) fail(`unsupported value at ${JSON.stringify(src.slice(i, i + 20))}`);
    i += m[0].length;
    if (m[0] === "true") return true;
    if (m[0] === "false") return false;
    return Number(m[0].replaceAll("_", ""));
  }

  function setPath(obj, parts, v) {
    let o = obj;
    for (const p of parts.slice(0, -1)) {
      if (o[p] === undefined) o[p] = {};
      else if (typeof o[p] !== "object" || Array.isArray(o[p])) fail(`key ${p} is not a table`);
      o = o[p];
    }
    const last = parts.at(-1);
    if (last in o) fail(`duplicate key ${parts.join(".")}`);
    o[last] = v;
  }

  function tableAt(parts, isArray) {
    let o = root;
    for (const [idx, p] of parts.entries()) {
      const lastPart = idx === parts.length - 1;
      if (lastPart && isArray) {
        if (o[p] === undefined) o[p] = [];
        if (!Array.isArray(o[p])) fail(`${parts.join(".")} is not an array of tables`);
        const t = {};
        o[p].push(t);
        return t;
      }
      if (o[p] === undefined) o[p] = {};
      o = Array.isArray(o[p]) ? o[p].at(-1) : o[p];
      if (typeof o !== "object") fail(`${parts.join(".")} is not a table`);
    }
    return o;
  }

  while (i < n) {
    skipAll();
    if (i >= n) break;
    if (peek() === "[") {
      const isArray = peek(1) === "[";
      i += isArray ? 2 : 1;
      const parts = dottedKey();
      skipWs();
      if (!src.startsWith(isArray ? "]]" : "]", i)) fail("unterminated table header");
      i += isArray ? 2 : 1;
      cur = tableAt(parts, isArray);
      endOfLine();
      continue;
    }
    const k = dottedKey();
    skipWs();
    if (peek() !== "=") fail("expected =");
    i++;
    setPath(cur, k, value());
    endOfLine();
  }
  return root;
}
