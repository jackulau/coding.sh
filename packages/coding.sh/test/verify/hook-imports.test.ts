// The hook's import graph, read without running it: every module src/spool/hook.ts can load, and
// every built-in module those load. The hook runs inside the agent's own hook call, so AGENTS.md
// holds it to no network and no git work, and it starts one child process: the detached background
// ingest in kick.ts. This test fails when a module the hook can load
//
// - loads node:net, node:http, node:https, node:http2, node:tls, node:dns, node:dgram,
//   node:child_process, node:worker_threads or node:cluster (a connection or another process), or
//   node:inspector, node:module or node:vm (a port, or code this walk cannot follow), other than the
//   one load ALLOWED names, in the one way it names, with its reason;
// - uses fetch, WebSocket, EventSource or XMLHttpRequest, or calls eval or Function;
// - names one of those modules in a string no load takes (a computed load would hide it);
// - loads a package (coding.sh has no runtime dependencies) or a file that is not there;
// - makes a load this walk cannot work out: a require() or getBuiltinModule() whose argument is not
//   a string, or such an import() in a file that makes no URL for it to load.
//
// The walk follows static and side-effect imports, re-exports (`export ... from`), import(),
// require() and process.getBuiltinModule() of a string, and URLs made with
// `new URL("./x.ts", import.meta.url)`: an import() whose argument is not a string may load any such
// URL in its file. That is how the hook loads the redaction rules (./redact.ts from source, and
// hook-redact.mjs once bundled, which scripts/bundle.mjs builds from ./redact.ts) only for a payload
// that may hold a secret. Type-only imports and re-exports, and `typeof import("./x.ts")` in a type,
// are erased before the code runs, and the walk does not follow them.
//
// A small tokenizer reads each file. It skips comments and takes strings, template literals (their
// ${} parts as code) and regular expressions as single tokens, so words in a comment or a string
// are not taken for code. It catches a load or a call written as one. Code written to hide one, such
// as globalThis["fe" + "tch"], is out of its reach. The other tests check the walk and the tokenizer
// on small made-up trees, and show that each check fails on a module that breaks it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { join, posix } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const PKG_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const ENTRY = "src/spool/hook.ts";

/** Built-in modules that open a connection or start a process. */
const NETWORK_OR_PROCESS = ["net", "http", "https", "http2", "tls", "dns", "dgram", "child_process", "worker_threads", "cluster"];
/** Built-in modules that open a port, or load or run code this walk cannot follow. */
const OPAQUE = ["inspector", "module", "vm"];
const BANNED = new Set([...NETWORK_OR_PROCESS, ...OPAQUE]);
/** Globals that open a connection. */
const NETWORK_GLOBALS = new Set(["fetch", "WebSocket", "EventSource", "XMLHttpRequest"]);
/** Calls that run code from a string. */
const CODE_FROM_STRING = new Set(["eval", "Function"]);

type Via = "import" | "export from" | "import()" | "new URL" | "require()" | "process.getBuiltinModule";

interface Allowance {
  file: string;
  builtin: string;
  via: Via;
  why: string;
}

/** The one banned load a module the hook can load may make: which module, how, and why. */
const ALLOWED: readonly Allowance[] = [
  {
    file: "src/spool/kick.ts",
    builtin: "node:child_process",
    via: "process.getBuiltinModule",
    why:
      "kickIngest and kickProxy start the hook's one child process, a detached `coding.sh ingest --background` " +
      "(or `proxy --background`) that the hook does not wait for (spawnBackgroundIngest, kickProxy). " +
      "process.getBuiltinModule loads node:child_process only when one starts, so other hook runs never load it.",
  },
];

/** Files a URL may name that exist only once bundled, and the source scripts/bundle.mjs builds each from. */
const BUNDLED: Record<string, string> = { "src/spool/hook-redact.mjs": "src/spool/redact.ts" };

interface Token {
  kind: "name" | "string" | "template" | "regex" | "number" | "punct";
  text: string;
  line: number;
  /** A template literal with no ${} part: it reads as a string. */
  whole?: boolean;
  /** A template literal part that ends where a ${} part starts. */
  open?: boolean;
}

/** Names after which a `/` starts a regular expression rather than a division. */
const BEFORE_EXPRESSION = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"]);
const ESCAPES: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", "0": "\0" };

/** The value of a string literal's text between its quotes. */
function unescape(raw: string): string {
  return raw.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|\r\n|[\s\S])/g, (_, e: string) => {
    if (e.length > 1 && (e[0] === "u" || e[0] === "x")) return String.fromCodePoint(Number.parseInt(e.replace(/[ux{}]/g, ""), 16));
    if (e === "\r\n" || e === "\n" || e === "\r" || e === " " || e === " ") return "";
    return ESCAPES[e] ?? e;
  });
}

/** The length of a backslash escape at src[i]: a line break after it may be \r\n. */
const escapeLength = (src: string, i: number): number => (src[i + 1] === "\r" && src[i + 2] === "\n" ? 3 : 2);

/** The tokens of a TypeScript source, without comments. Throws on a string, template or comment that does not end. */
function tokenize(src: string): Token[] {
  const out: Token[] = [];
  const subs: number[] = []; // the brace depth outside each open template ${} part
  let depth = 0;
  let line = 1;
  let i = src.startsWith("#!") ? src.indexOf("\n") : 0;
  if (i < 0) return out;
  const fail = (what: string): never => {
    throw new Error(`${what} at line ${line}`);
  };
  const countLines = (from: number, to: number): void => {
    for (let k = from; k < to; k++) if (src[k] === "\n") line++;
  };
  const regexAllowed = (): boolean => {
    const p = out[out.length - 1];
    if (!p) return true;
    if (p.kind === "punct") return p.text !== ")" && p.text !== "]" && p.text !== "}";
    if (p.kind === "template") return p.open === true;
    return p.kind === "name" && BEFORE_EXPRESSION.has(p.text) && out[out.length - 2]?.text !== ".";
  };
  // Template text from i (just past "`", or past the "}" that closes a ${} part) to "`" or "${".
  const template = (head: boolean): void => {
    const start = line;
    let raw = "";
    for (;;) {
      if (i >= src.length) fail("unterminated template literal");
      const c = src.charAt(i);
      if (c === "\\") {
        const n = escapeLength(src, i);
        countLines(i, i + n);
        raw += src.slice(i, i + n);
        i += n;
        continue;
      }
      if (c === "`") {
        i++;
        out.push({ kind: "template", text: unescape(raw), line: start, whole: head });
        return;
      }
      if (c === "$" && src[i + 1] === "{") {
        i += 2;
        out.push({ kind: "template", text: unescape(raw), line: start, open: true });
        subs.push(depth);
        depth++;
        return;
      }
      if (c === "\n") line++;
      raw += c;
      i++;
    }
  };
  while (i < src.length) {
    const c = src.charAt(i);
    const next = src.charAt(i + 1);
    if (c === "\n") {
      line++;
      i++;
      continue;
    }
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "/" && next === "/") {
      const end = src.indexOf("\n", i);
      i = end < 0 ? src.length : end;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      if (end < 0) fail("unterminated comment");
      countLines(i, end);
      i = end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let raw = "";
      for (;;) {
        const d = src.charAt(j);
        if (j >= src.length || d === "\n" || (d === "\r" && src[j + 1] === "\n")) fail("unterminated string");
        if (d === "\\") {
          const n = escapeLength(src, j);
          raw += src.slice(j, j + n);
          j += n;
          continue;
        }
        if (d === c) break;
        raw += d;
        j++;
      }
      out.push({ kind: "string", text: unescape(raw), line });
      countLines(i, j);
      i = j + 1;
      continue;
    }
    if (c === "`") {
      i++;
      template(true);
      continue;
    }
    if (c === "}" && subs[subs.length - 1] === depth - 1) {
      subs.pop();
      depth--;
      i++;
      template(false);
      continue;
    }
    if (c === "/" && regexAllowed()) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      for (; j < src.length; j++) {
        const d = src.charAt(j);
        if (d === "\n" || d === "\r") break;
        if (d === "\\") j++;
        else if (inClass) inClass = d !== "]";
        else if (d === "[") inClass = true;
        else if (d === "/") {
          closed = true;
          break;
        }
      }
      if (closed) {
        j++;
        while (/[A-Za-z]/.test(src.charAt(j))) j++;
        out.push({ kind: "regex", text: src.slice(i, j), line });
        i = j;
        continue;
      }
      // No closing slash on the line: a division after all.
    }
    if (/[A-Za-z_$\u0080-￿]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[\w$\u0080-￿]/.test(src.charAt(j))) j++;
      out.push({ kind: "name", text: src.slice(i, j), line });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(next))) {
      let j = i + 1;
      while (j < src.length && /[\w.]/.test(src.charAt(j))) j++;
      out.push({ kind: "number", text: src.slice(i, j), line });
      i = j;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") depth--;
    out.push({ kind: "punct", text: c, line });
    i++;
  }
  if (subs.length) fail("unterminated template literal");
  return out;
}

interface Load {
  /** Undefined when the argument is not a string. */
  spec: string | undefined;
  via: Via;
  line: number;
}

interface Scan {
  loads: Load[];
  /** Relative URLs made with `new URL(..., import.meta.url)`. */
  urls: { spec: string; line: number }[];
  /** Network globals and calls that run code from a string. */
  uses: { name: string; line: number }[];
  /** String literals no load or URL takes. */
  strings: { text: string; line: number }[];
}

/** What a source loads, the URLs it makes, and the globals and strings the checks look at. */
function scan(src: string): Scan {
  const t = tokenize(src);
  const taken = new Set<number>();
  const loads: Load[] = [];
  const urls: Scan["urls"] = [];
  const uses: Scan["uses"] = [];
  const code = (k: number, text: string): boolean => {
    const x = t[k];
    return x !== undefined && x.kind !== "string" && x.kind !== "template" && x.text === text;
  };
  const literal = (k: number): string | undefined => {
    const x = t[k];
    return x && (x.kind === "string" || (x.kind === "template" && x.whole === true)) ? x.text : undefined;
  };
  const take = (k: number, via: Via, line: number): void => {
    taken.add(k);
    loads.push({ spec: literal(k), via, line });
  };
  // A call at the "(" at k: a load of its argument when that is one string, else one the walk cannot follow.
  const call = (k: number, via: Via, line: number): void => {
    if (literal(k + 1) !== undefined && (code(k + 2, ")") || code(k + 2, ","))) take(k + 1, via, line);
    else loads.push({ spec: undefined, via, line });
  };
  for (let k = 0; k < t.length; k++) {
    const tok = t[k];
    if (!tok || tok.kind !== "name") continue;
    const line = tok.line;
    if (tok.text === "getBuiltinModule" && code(k + 1, "(")) {
      call(k + 1, "process.getBuiltinModule", line);
      continue;
    }
    if (CODE_FROM_STRING.has(tok.text) && code(k + 1, "(")) {
      uses.push({ name: tok.text, line });
      continue;
    }
    if (code(k - 1, ".")) {
      if (NETWORK_GLOBALS.has(tok.text)) uses.push({ name: tok.text, line }); // globalThis.fetch
      continue;
    }
    if (tok.text === "import") {
      if (code(k + 1, "(") && code(k - 1, "typeof")) {
        if (literal(k + 2) !== undefined) taken.add(k + 2); // `typeof import("./x.ts")` is a type, erased
      } else if (code(k + 1, "(")) call(k + 1, "import()", line);
      else if (code(k + 1, ".")) continue; // import.meta
      else if (literal(k + 1) !== undefined) take(k + 1, "import", line);
      else {
        // `import type X from` and `import type { X } from` are erased; `import type from` imports a default named type.
        const typeOnly = code(k + 1, "type") && !code(k + 2, "from") && !code(k + 2, ",");
        let j = k + 1;
        while (j < t.length && !code(j, ";") && !(code(j, "from") && literal(j + 1) !== undefined)) j++;
        if (!code(j, "from")) continue;
        if (typeOnly) taken.add(j + 1);
        else take(j + 1, "import", line);
      }
      continue;
    }
    if (tok.text === "export") {
      let j = k + 1;
      const typeOnly = code(j, "type") && (code(j + 1, "{") || code(j + 1, "*"));
      if (typeOnly) j++;
      if (code(j, "*")) j += code(j + 1, "as") ? 3 : 1;
      else if (code(j, "{")) {
        while (j < t.length && !code(j, "}")) j++;
        j++;
      } else continue;
      if (!code(j, "from") || literal(j + 1) === undefined) continue;
      if (typeOnly) taken.add(j + 1);
      else take(j + 1, "export from", line);
      continue;
    }
    if (tok.text === "require" && code(k + 1, "(")) {
      call(k + 1, "require()", line);
      continue;
    }
    if (tok.text === "new" && code(k + 1, "URL") && code(k + 2, "(")) {
      const relative: number[] = [];
      let meta = false;
      for (let j = k + 3, d = 1; j < t.length && d > 0; j++) {
        if (code(j, "(")) d++;
        else if (code(j, ")")) d--;
        else if (code(j, "import") && code(j + 1, ".") && code(j + 2, "meta") && code(j + 3, ".") && code(j + 4, "url")) meta = true;
        else if (/^\.\.?\//.test(literal(j) ?? "")) relative.push(j);
      }
      if (meta)
        for (const j of relative) {
          taken.add(j);
          urls.push({ spec: literal(j) ?? "", line: t[j]?.line ?? line });
        }
      continue;
    }
    // An object key or a property declared in a type (`{ fetch: f }`, `fetch?: F;`) is not a use.
    const key = (code(k + 1, ":") || (code(k + 1, "?") && code(k + 2, ":"))) && (code(k - 1, "{") || code(k - 1, ",") || code(k - 1, ";"));
    if (NETWORK_GLOBALS.has(tok.text) && !key) uses.push({ name: tok.text, line });
  }
  const strings = t.flatMap((x, k) => (literal(k) !== undefined && !taken.has(k) ? [{ text: x.text, line: x.line }] : []));
  return { loads, urls, uses, strings };
}

interface Walked {
  modules: string[];
  builtins: { module: string; builtin: string; via: Via; line: number }[];
  problems: string[];
}

/**
 * Every module `entry` can load, read through `read` (a path under the package, `/`-separated, to
 * its text or undefined), the built-in modules they load, and what breaks the rules above.
 */
function walk(entry: string, read: (file: string) => string | undefined, bundled: Record<string, string>, allowed: readonly Allowance[]): Walked {
  const seen = new Set([entry]);
  const queue = [entry];
  const builtins: Walked["builtins"] = [];
  const problems: string[] = [];
  const used = new Set<Allowance>();
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    const src = read(file);
    if (src === undefined) {
      problems.push(`${file} is not a file`);
      continue;
    }
    let s: Scan;
    try {
      s = scan(src);
    } catch (e) {
      problems.push(`${file}: cannot read it: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    const from = file;
    const follow = (spec: string, line: number, via: Via): void => {
      const target = posix.join(posix.dirname(from), spec);
      const real = read(target) === undefined ? bundled[target] : target;
      if (real === undefined) problems.push(`${from}:${line} loads ${spec} (${via}), which is not a file`);
      else if (!seen.has(real)) {
        seen.add(real);
        queue.push(real);
      }
    };
    let byUrl = false;
    for (const l of s.loads) {
      if (l.spec === undefined) {
        if (l.via === "import()" && s.urls.length) byUrl = true;
        else problems.push(`${from}:${l.line} loads something the walk cannot follow (${l.via} of a value that is not a string)`);
        continue;
      }
      if (/^\.\.?\//.test(l.spec)) {
        follow(l.spec, l.line, l.via);
        continue;
      }
      const name = l.spec.replace(/^node:/, "");
      if (!builtinModules.includes(name) && !builtinModules.includes(l.spec)) {
        problems.push(
          l.spec.startsWith("node:")
            ? `${from}:${l.line} loads ${l.spec} (${l.via}), which is not a built-in module`
            : `${from}:${l.line} loads the package ${l.spec} (${l.via}); coding.sh has no runtime dependencies`,
        );
        continue;
      }
      const builtin = `node:${name}`;
      builtins.push({ module: from, builtin, via: l.via, line: l.line });
      const base = name.split("/")[0] ?? name;
      if (!BANNED.has(base)) continue;
      const allow = allowed.find((a) => a.file === from && a.builtin === builtin);
      if (allow && allow.via === l.via) used.add(allow);
      else if (allow) problems.push(`${from}:${l.line} loads ${builtin} (${l.via}); ALLOWED lets it load ${builtin} only through ${allow.via}: ${allow.why}`);
      else if (OPAQUE.includes(base)) problems.push(`${from}:${l.line} loads ${builtin} (${l.via}), which opens a port or loads code this walk cannot follow`);
      else problems.push(`${from}:${l.line} loads ${builtin} (${l.via}): a module the hook loads opens no connection and starts no process`);
    }
    if (byUrl) for (const u of s.urls) follow(u.spec, u.line, "new URL");
    for (const u of s.uses)
      problems.push(NETWORK_GLOBALS.has(u.name) ? `${from}:${u.line} uses ${u.name}, which opens a connection` : `${from}:${u.line} calls ${u.name}, which runs code this walk cannot follow`);
    for (const str of s.strings) {
      const m = /^node:([a-z0-9_]+)(?:\/.*)?$/.exec(str.text);
      if (m?.[1] && BANNED.has(m[1])) problems.push(`${from}:${str.line} names ${str.text} in a string no load takes, so a load made from it would be hidden from this walk`);
    }
  }
  for (const a of allowed) if (!used.has(a)) problems.push(`ALLOWED lets ${a.file} load ${a.builtin} through ${a.via}, and no module the hook loads does: remove the allowance`);
  return { modules: [...seen].sort(), builtins, problems };
}

const readSource = (file: string): string | undefined => {
  try {
    return readFileSync(join(PKG_ROOT, ...file.split("/")), "utf8");
  } catch {
    return undefined;
  }
};

/** An import or re-export a line-by-line search finds: the check that the tokenizer misses none in the real files. */
const LINE_IMPORT = /^\s*(?:import|export)\s(?!type\s)[^;]*?\sfrom\s+"([^"]+)"|^\s*import\s+"([^"]+)"/;

test("no module the hook can load opens a connection, starts a process or runs code the walk cannot follow, but kick.ts's background ingest", (t) => {
  assert.match(
    readFileSync(join(PKG_ROOT, "scripts", "bundle.mjs"), "utf8"),
    /"hook-redact":\s*"src\/spool\/redact\.ts"/,
    "scripts/bundle.mjs no longer builds hook-redact.mjs from src/spool/redact.ts: update BUNDLED",
  );
  const w = walk(ENTRY, readSource, BUNDLED, ALLOWED);
  t.diagnostic(`${w.modules.length} modules: ${w.modules.join(", ")}`);
  const byBuiltin = new Map<string, Set<string>>();
  for (const b of w.builtins) byBuiltin.set(b.builtin, (byBuiltin.get(b.builtin) ?? new Set()).add(b.module.replace(/^src\//, "")));
  t.diagnostic(`built-in modules: ${[...byBuiltin].map(([b, m]) => `${b} (${[...m].join(", ")})`).join("; ")}`);
  assert.deepEqual(w.problems, []);

  // The walk went through each kind of load the hook makes: the redaction rules through the URL,
  // the lock through kick.ts, and the child process through getBuiltinModule.
  for (const m of ["src/spool/write.ts", "src/spool/kick.ts", "src/core/lock.ts", "src/spool/redact.ts", "src/core/redact.ts", "src/core/toml.ts"])
    assert.ok(w.modules.includes(m), `${m} is not in the walk: ${w.modules.join(", ")}`);
  assert.ok(w.builtins.some((b) => b.module === "src/spool/kick.ts" && b.builtin === "node:child_process" && b.via === "process.getBuiltinModule"));

  // The tokenizer finds every import a line-by-line search of the same files finds.
  for (const m of w.modules) {
    const src = readSource(m) ?? "";
    const found = scan(src).loads.flatMap((l) => (l.spec === undefined ? [] : [l.spec]));
    for (const lineText of src.split("\n")) {
      const x = LINE_IMPORT.exec(lineText);
      const spec = x?.[1] ?? x?.[2];
      if (spec !== undefined) assert.ok(found.includes(spec), `${m}: the tokenizer missed ${JSON.stringify(lineText.trim())}`);
    }
  }
});

// A made-up graph for the walk. The entry reaches each module through one kind of load, and names
// others in ways that load nothing.
const TREE_ENTRY = "src/spool/hook.ts";
const TREE_BUNDLED: Record<string, string> = { "src/spool/engine.mjs": "src/spool/engine.ts" };
const LEAVES = [
  "src/spool/static.ts",
  "src/spool/default.ts",
  "src/spool/namespace.ts",
  "src/spool/side.ts",
  "src/spool/multi.ts",
  "src/spool/mixed.ts",
  "src/core/star.ts",
  "src/core/star-as.ts",
  "src/core/named.ts",
  "src/spool/engine.ts",
  "src/spool/lazy.ts",
  "src/spool/lazy-template.ts",
  "src/spool/required.ts",
  "src/spool/kick.ts",
];
const TREE: Record<string, string> = {
  [TREE_ENTRY]: [
    `import { a } from "./static.ts";`,
    `import def, { b } from "./default.ts";`,
    `import * as ns from "./namespace.ts";`,
    `import "./side.ts";`,
    `import {`,
    `  c,`,
    `  from,`,
    `} from "./multi.ts";`,
    `import type { T } from "./type-only.ts";`,
    `import { type U, e } from "./mixed.ts";`,
    `import { kick } from "./kick.ts";`,
    `export * from "../core/star.ts";`,
    `export * as all from "../core/star-as.ts";`,
    `export { f } from "../core/named.ts";`,
    `export type { V } from "./type-export.ts";`,
    `export type * from "./type-star.ts";`,
    `export { a, b, c, def, e, from, ns };`,
    `const engine = new URL(import.meta.url.endsWith(".ts") ? "./engine.ts" : "./engine.mjs", import.meta.url);`,
    `export const load = async () => [await import("./lazy.ts"), await import(\`./lazy-template.ts\`), await import(engine.href)];`,
    `const req = typeof require === "function" ? require("./required.ts") : undefined;`,
    `const fs = process.getBuiltinModule("node:fs");`,
    `// import "./line-comment.ts";`,
    `/* export * from "./block-comment.ts"; */`,
    `const s = 'import "./in-string.ts"';`,
    `const u = new URL("./not-loaded.ts", "https://example.com/");`,
  ].join("\n"),
  ...Object.fromEntries(LEAVES.map((m) => [m, `export const x = 1;\n`])),
  "src/spool/kick.ts": `export const kick = () => process.getBuiltinModule("node:child_process").spawn;\n`,
};
const treeRead = (tree: Record<string, string>) => (file: string): string | undefined => tree[file];

test("the walk follows each way a module loads another, and no type-only import, comment or string", () => {
  const w = walk(TREE_ENTRY, treeRead(TREE), TREE_BUNDLED, ALLOWED);
  assert.deepEqual(w.problems, []);
  assert.deepEqual(w.modules, [TREE_ENTRY, ...LEAVES].sort());
  assert.deepEqual(
    w.builtins.map((b) => `${b.module} ${b.builtin} ${b.via}`),
    [`${TREE_ENTRY} node:fs process.getBuiltinModule`, "src/spool/kick.ts node:child_process process.getBuiltinModule"],
  );
});

test("the tokenizer takes comments, strings, template literals and regular expressions for what they are", () => {
  const src = [
    `// import "node:https"; fetch(u)`,
    `/* import "node:net";`,
    `   fetch(u) */`,
    `const a = "fetch(u) and import('node:tls')", b = 'it\\'s "node:dns" in a sentence';`,
    `const quotes = /["'\`]+/g; import { q } from "./q.ts";`,
    `const inClass = /[/"]/; import "./class.ts";`,
    `const half = 1 / 2, third = half / 3; import "./division.ts";`,
    `const nested = \`a \${\`b \${"c" + \`d\`}\`} e\`; import "./nested.ts";`,
    `const braces = \`\${{ a: 1 }.a} \${/"/.source}\`; import "./braces.ts";`,
    `const slash = /\\/"/; import "./slash.ts";`,
    `const r = x.return / 2; import "./property.ts"; const z = 4 / 5;`,
    `const obj = { fetch: 1 }, typed: { fetch?: number } = {};`,
    `const crlf = "a\\\r\nb";\r\nimport "./crlf.ts";`,
  ].join("\n");
  const s = scan(src);
  assert.deepEqual(
    s.loads.map((l) => l.spec),
    ["./q.ts", "./class.ts", "./division.ts", "./nested.ts", "./braces.ts", "./slash.ts", "./property.ts", "./crlf.ts"],
  );
  assert.deepEqual(s.uses, []);
  assert.ok(s.strings.some((x) => x.text === "ab"), "a backslash before \\r\\n continues the string");
  assert.equal(s.loads.at(-1)?.line, 15, "line numbers count every line break");
});

test("each check fails on a module that breaks it, whichever kind of load reaches the module", () => {
  const problems = (change: Record<string, string>): string[] => walk(TREE_ENTRY, treeRead({ ...TREE, ...change }), TREE_BUNDLED, ALLOWED).problems;
  const fails = (change: Record<string, string>, expected: RegExp): void => {
    const got = problems(change);
    assert.ok(got.some((p) => expected.test(p)), `expected a problem matching ${expected}, got:\n${got.join("\n") || "none"}`);
  };
  const leaf = "src/spool/lazy.ts";
  const add = (file: string, text: string): Record<string, string> => ({ [file]: `${TREE[file] ?? ""}${text}\n` });

  // node:https in each module, each reached through a different kind of load.
  for (const m of [TREE_ENTRY, ...LEAVES]) fails(add(m, `import "node:https";`), new RegExp(`^${m}:\\d+ loads node:https \\(import\\)`));

  const cases: [string, RegExp][] = [
    [`export { request } from "node:http";`, /loads node:http \(export from\)/],
    [`export const n = () => import("node:net");`, /loads node:net \(import\(\)\)/],
    [`export const d = require("node:dgram");`, /loads node:dgram \(require\(\)\)/],
    [`export const w = process.getBuiltinModule("node:worker_threads");`, /loads node:worker_threads \(process.getBuiltinModule\)/],
    [`import "node:dns/promises";`, /loads node:dns\/promises/],
    [`import { connect } from "tls";`, /loads node:tls \(import\)/],
    [`import "node:vm";`, /loads node:vm .*cannot follow/],
    [`export const g = () => fetch("https://example.com/");`, /uses fetch/],
    [`export const g = () => globalThis.fetch("https://example.com/");`, /uses fetch/],
    [`export const g = (u: string) => \`\${await fetch(u)}\`;`, /uses fetch/],
    [`export const g = (useNet: boolean) => (useNet ? fetch : undefined);`, /uses fetch/],
    [`export const ws = (u: string) => new WebSocket(u);`, /uses WebSocket/],
    [`export const ev = (code: string) => eval(code);`, /calls eval/],
    [`export const fn = (code: string) => new Function(code);`, /calls Function/],
    [`const name = "node:child_process";`, /names node:child_process in a string/],
    [`const name = "\\x6e\\x6fde:https";`, /names node:https in a string/],
    [`export const dyn = (name: string) => import(name);`, /cannot follow \(import\(\) of a value that is not a string\)/],
    [`export const dyn = (name: string) => process.getBuiltinModule(name);`, /cannot follow \(process.getBuiltinModule of a value/],
    [`export const dyn = (name: string) => require(name);`, /cannot follow \(require\(\) of a value/],
    [`export const ev = (code: string) => globalThis.eval(code);`, /calls eval/],
    [`import "undici";`, /loads the package undici/],
    [`import "node:nothing";`, /node:nothing .*not a built-in module/],
    [`import "./missing.ts";`, /loads \.\/missing\.ts \(import\), which is not a file/],
    [`const broken = "no end;`, /cannot read it: unterminated string at line 2/],
  ];
  for (const [text, expected] of cases) fails(add(leaf, text), expected);
  // A type is erased before the code runs, so naming a module in one loads nothing.
  assert.deepEqual(problems(add(leaf, `export type Engine = typeof import("node:https");\nimport type { Agent } from "node:http";`)), []);

  // The allowance: only kick.ts, only node:child_process, only through getBuiltinModule, and only while it does.
  fails(add("src/spool/static.ts", `export const s = process.getBuiltinModule("node:child_process");`), /^src\/spool\/static\.ts:\d+ loads node:child_process/);
  fails({ "src/spool/kick.ts": `import { spawn } from "node:child_process";\nexport const kick = () => spawn;\n` }, /loads node:child_process \(import\); ALLOWED lets it load node:child_process only through process.getBuiltinModule/);
  fails({ "src/spool/kick.ts": `export const kick = () => undefined;\n` }, /no module the hook loads does: remove the allowance/);
  fails(add("src/spool/kick.ts", `export const net = () => process.getBuiltinModule("node:net");`), /^src\/spool\/kick\.ts:\d+ loads node:net/);
});
