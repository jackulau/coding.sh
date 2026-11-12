// Writes docs/reference/sdk.md from the SDK sources, so the SDK reference cannot
// drift from the code it documents:
//   - TypeScript: packages/sdk/src/index.ts and the files it re-exports, read with
//     the TypeScript compiler's parser (signatures, JSDoc, interface fields), plus
//     the defaults and env vars resolveConfig() in config.ts applies to InitOptions.
//   - Python: the names in packages/sdk-python/src/coding_sh/__init__.py `__all__`
//     and coding_sh/otel.py `__all__`, parsed from the .py files (signatures and
//     docstrings), plus the defaults and env vars Config.__init__ applies to init().
// Only the intros and examples below are hand-written.
//
//   node packages/coding.sh/scripts/sdk-reference.ts          # rewrite the file
//   node packages/coding.sh/scripts/sdk-reference.ts --check  # exit 1 when it is stale
//
// test/docs/sdk-reference.test.ts runs the same check in `npm test`.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export const SDK_REFERENCE_PATH = fileURLToPath(new URL("../../../docs/reference/sdk.md", import.meta.url));
const TS_SDK = fileURLToPath(new URL("../../sdk/", import.meta.url));
const PY_SDK = fileURLToPath(new URL("../../sdk-python/", import.meta.url));
const PY_PKG = `${PY_SDK}src/coding_sh/`;

const read = (path: string) => readFileSync(path, "utf8");

// ---------------------------------------------------------------- markdown helpers

/** Table cell: escape pipes (code spans included; the site and GitHub both unescape them). */
const cell = (s: string) => s.replace(/\|/g, "\\|");
/** A sentence: ends with a period. */
const sentence = (s: string) => (!s || /[.?!:)]$/.test(s) ? s : `${s}.`);
const code = (s: string) => (s.includes("`") ? `\`\` ${s} \`\`` : `\`${s}\``);
/** GitHub's heading anchor (same rule as apps/site/src/components/docs/markdown.ts). */
const slug = (heading: string) =>
  heading
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .toLowerCase()
    .replace(/[^a-z0-9 _-]/g, "")
    .replace(/ /g, "-");

/** Comment or docstring text → Markdown paragraphs (lines joined; indented lines become code). */
function prose(text: string, lang: string): string[] {
  const out: string[] = [];
  const lines = text.replace(/\r/g, "").split("\n");
  let para: string[] = [];
  let block: string[] = [];
  const flushPara = () => {
    if (para.length) out.push(para.join(" "), "");
    para = [];
  };
  const flushBlock = () => {
    if (block.length) out.push("```" + lang, ...dedent(block), "```", "");
    block = [];
  };
  for (const line of lines) {
    if (/^ {4}/.test(line) && line.trim()) {
      flushPara();
      block.push(line);
    } else if (!line.trim()) {
      flushPara();
      flushBlock();
    } else {
      flushBlock();
      para.push(line.trim());
    }
  }
  flushPara();
  flushBlock();
  return out;
}

function dedent(lines: string[]): string[] {
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^ */)![0].length));
  return lines.map((l) => l.slice(indent));
}

/** One parameter per line when the one-line form is long. */
function signature(head: string, params: string[], tail: string, max = 100): string {
  const one = `${head}(${params.join(", ")})${tail}`;
  return one.length <= max || !params.length ? one : `${head}(\n${params.map((p) => `    ${p},`).join("\n")}\n)${tail}`;
}

// ---------------------------------------------------------------- TypeScript

interface TsParam {
  name: string;
  type: string;
  optional: boolean;
  dflt?: string;
}

interface TsField {
  name: string;
  type: string;
  optional: boolean;
  doc: string;
}

export interface TsExport {
  name: string;
  /** Source file relative to packages/sdk/src. */
  file: string;
  kind: "function" | "interface" | "type";
  doc: string;
  /** Declaration as TypeScript (bodies and comments stripped). */
  decl: string;
  params: TsParam[];
  fields: TsField[];
}

const sources = new Map<string, ts.SourceFile>();
function sourceFile(path: string): ts.SourceFile {
  let sf = sources.get(path);
  if (!sf) {
    sf = ts.createSourceFile(path, read(path), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    sources.set(path, sf);
  }
  return sf;
}

function jsdoc(node: ts.Node): string {
  return ts
    .getJSDocCommentsAndTags(node)
    .filter(ts.isJSDoc)
    .map((d) => ts.getTextOfJSDocComment(d.comment) ?? "")
    .join("\n\n")
    .trim();
}

const oneLine = (s: string) => s.replace(/\s*\n\s*/g, " ").replace(/\(\s+/g, "(").replace(/,\s*\)/g, ")");

/** Local, non-exported type aliases of a file (`type Fetch = typeof fetch`), to inline them. */
function localAliases(sf: ts.SourceFile): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of sf.statements) {
    if (ts.isTypeAliasDeclaration(s) && !s.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) out.set(s.name.text, oneLine(s.type.getText()));
  }
  return out;
}

function inlineAliases(text: string, aliases: Map<string, string>): string {
  return text.replace(/\b[A-Z]\w*\b/g, (w) => aliases.get(w) ?? w);
}

function tsParams(node: ts.SignatureDeclarationBase): TsParam[] {
  const aliases = localAliases(node.getSourceFile());
  return node.parameters.map((p) => ({
    name: p.name.getText(),
    type: p.type ? inlineAliases(oneLine(p.type.getText()), aliases) : p.initializer && ts.isNumericLiteral(p.initializer) ? "number" : "",
    optional: !!p.questionToken || !!p.initializer,
    dflt: p.initializer ? oneLine(p.initializer.getText()) : undefined,
  }));
}

function functionDecl(fn: ts.FunctionDeclaration): string {
  const tp = fn.typeParameters ? `<${fn.typeParameters.map((t) => t.getText()).join(", ")}>` : "";
  const aliases = localAliases(fn.getSourceFile());
  const params = fn.parameters.map((p) => inlineAliases(oneLine(p.getText()), aliases));
  return signature(`function ${fn.name!.text}${tp}`, params, fn.type ? `: ${inlineAliases(oneLine(fn.type.getText()), aliases)}` : "");
}

function interfaceDecl(node: ts.InterfaceDeclaration): string {
  const members = node.members.map((m) => `  ${oneLine(m.getText().replace(/\/\*\*[\s\S]*?\*\/\s*/g, ""))}`);
  const tp = node.typeParameters ? `<${node.typeParameters.map((t) => t.getText()).join(", ")}>` : "";
  return `interface ${node.name.text}${tp} {\n${members.join("\n")}\n}`;
}

function findDecl(sf: ts.SourceFile, name: string): ts.Statement[] {
  return sf.statements.filter(
    (s) => (ts.isFunctionDeclaration(s) || ts.isInterfaceDeclaration(s) || ts.isTypeAliasDeclaration(s) || ts.isClassDeclaration(s)) && s.name?.text === name,
  );
}

/** Everything packages/sdk/src/index.ts exports, in its order. */
export function tsExports(): TsExport[] {
  const src = `${TS_SDK}src/`;
  const index = sourceFile(`${src}index.ts`);
  const out: TsExport[] = [];
  for (const st of index.statements) {
    if (!ts.isExportDeclaration(st)) continue;
    if (!st.moduleSpecifier || !ts.isStringLiteral(st.moduleSpecifier) || !st.exportClause || !ts.isNamedExports(st.exportClause)) {
      throw new Error(`sdk-reference: unsupported export in packages/sdk/src/index.ts: ${st.getText()}`);
    }
    const file = st.moduleSpecifier.text.replace(/^\.\//, "");
    const sf = sourceFile(`${src}${file}`);
    for (const el of st.exportClause.elements) {
      const name = el.name.text;
      const local = el.propertyName?.text ?? name;
      const decls = findDecl(sf, local);
      if (!decls.length) throw new Error(`sdk-reference: ${name} is exported from ${file} but not declared there`);
      const first = decls[0]!;
      if (ts.isFunctionDeclaration(first)) {
        const fns = decls.filter(ts.isFunctionDeclaration);
        const overloads = fns.filter((f) => !f.body);
        const shown = overloads.length ? overloads : fns;
        out.push({
          name,
          file,
          kind: "function",
          doc: jsdoc(shown[0]!),
          decl: shown.map(functionDecl).join("\n"),
          params: tsParams(shown[0]!),
          fields: [],
        });
      } else if (ts.isInterfaceDeclaration(first)) {
        const fields: TsField[] = first.members.filter(ts.isPropertySignature).map((m) => ({
          name: m.name.getText(),
          type: m.type ? oneLine(m.type.getText()) : "unknown",
          optional: !!m.questionToken,
          doc: jsdoc(m),
        }));
        out.push({ name, file, kind: "interface", doc: jsdoc(first), decl: interfaceDecl(first), params: [], fields: fields.length === first.members.length ? fields : [] });
      } else if (ts.isTypeAliasDeclaration(first)) {
        out.push({ name, file, kind: "type", doc: jsdoc(first), decl: `type ${name} = ${oneLine(first.type.getText())};`, params: [], fields: [] });
      } else {
        throw new Error(`sdk-reference: ${name} is a class; teach the generator to document classes`);
      }
    }
  }
  return out;
}

interface OptionInfo {
  dflt?: string;
  env: string[];
}

/** InitOptions field → its default and env vars, read from resolveConfig() in config.ts. */
export function tsOptionDefaults(fields: string[]): Map<string, OptionInfo> {
  const sf = sourceFile(`${TS_SDK}src/config.ts`);
  const consts = new Map<string, ts.Expression>();
  let resolve: ts.FunctionDeclaration | undefined;
  for (const st of sf.statements) {
    if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name) && d.initializer) consts.set(d.name.text, d.initializer);
    if (ts.isFunctionDeclaration(st) && st.name?.text === "resolveConfig") resolve = st;
  }
  if (!resolve?.body) throw new Error("sdk-reference: resolveConfig() not found in packages/sdk/src/config.ts");

  // Units: `const x = …` statements and the properties of the returned object literal.
  const units: { local?: string; expr: ts.Expression }[] = [];
  for (const st of resolve.body.statements) {
    if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name) && d.initializer) units.push({ local: d.name.text, expr: d.initializer });
    if (ts.isReturnStatement(st) && st.expression && ts.isObjectLiteralExpression(st.expression)) {
      for (const p of st.expression.properties) if (ts.isPropertyAssignment(p)) units.push({ expr: p.initializer });
    }
  }
  const walk = (n: ts.Node, visit: (n: ts.Node) => void) => {
    visit(n);
    n.forEachChild((c) => walk(c, visit));
  };
  const mentions = (n: ts.Node, test: (n: ts.Node) => boolean) => {
    let hit = false;
    walk(n, (c) => (hit ||= test(c)));
    return hit;
  };
  const isOpt = (field: string) => (n: ts.Node) => ts.isPropertyAccessExpression(n) && n.expression.getText() === "opts" && n.name.text === field;
  const evalConst = (e: ts.Expression): string => {
    if (ts.isNumericLiteral(e)) return String(Number(e.text.replace(/_/g, "")));
    if (ts.isIdentifier(e) && consts.has(e.text)) return evalConst(consts.get(e.text)!);
    return e.getText();
  };

  const out = new Map<string, OptionInfo>();
  for (const field of fields) {
    const direct = units.filter((u) => mentions(u.expr, isOpt(field)));
    if (!direct.length) throw new Error(`sdk-reference: resolveConfig() does not read opts.${field}`);
    const locals = direct.map((u) => u.local).filter((l): l is string => !!l);
    const related = [...direct, ...units.filter((u) => !direct.includes(u) && locals.some((l) => mentions(u.expr, (n) => ts.isIdentifier(n) && n.text === l)))];
    const env = new Set<string>();
    let dflt: string | undefined;
    for (const u of related) {
      walk(u.expr, (n) => {
        if (direct.includes(u) && ts.isPropertyAccessExpression(n) && n.expression.getText() === "e" && /^(CODING_SH|OTEL)_/.test(n.name.text)) env.add(n.name.text);
        if (dflt === undefined && ts.isCallExpression(n) && n.expression.getText() === "posInt" && n.arguments[0] && isOpt(field)(n.arguments[0]) && n.arguments[1]) dflt = evalConst(n.arguments[1]);
        if (dflt === undefined && ts.isConditionalExpression(n) && ts.isStringLiteral(n.whenFalse)) dflt = JSON.stringify(n.whenFalse.text);
      });
    }
    out.set(field, { dflt, env: [...env] });
  }
  return out;
}

// ---------------------------------------------------------------- Python

interface PyParam {
  name: string;
  type: string;
  dflt?: string;
}

export interface PyApi {
  name: string;
  /** Module file name, e.g. "_trace.py". */
  file: string;
  kind: "function" | "class" | "constant";
  doc: string;
  params: PyParam[];
  returns: string;
  /** Rendered `def`/`class` signature, or `NAME = value`. */
  decl: string;
}

/** The items of a Python list literal of strings, e.g. `__all__ = [...]`. */
function pyAll(source: string, file: string): string[] {
  const m = source.match(/^__all__\s*=\s*\[([\s\S]*?)\]/m);
  if (!m) throw new Error(`sdk-reference: no __all__ in ${file}`);
  return [...m[1]!.matchAll(/["']([\w.]+)["']/g)].map((x) => x[1]!);
}

/** Index of the bracket closing the one at `open`, skipping string literals. */
function closing(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const c = s[i]!;
    if (c === '"' || c === "'") {
      const end = s.indexOf(c, i + 1);
      i = end < 0 ? s.length : end;
    } else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c) && --depth === 0) return i;
  }
  throw new Error("sdk-reference: unbalanced brackets in Python source");
}

/** Split on commas (or `sep`) that are not inside brackets or strings. */
function splitTop(s: string, sep = ","): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === '"' || c === "'") {
      const end = s.indexOf(c, i + 1);
      cur += s.slice(i, end + 1);
      i = end;
      continue;
    }
    if ("([{".includes(c)) depth++;
    if (")]}".includes(c)) depth--;
    if (c === sep && depth === 0 && (sep !== "=" || (s[i + 1] !== "=" && !"=!<>".includes(s[i - 1] ?? "")))) {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out.map((x) => x.trim());
}

function pyParams(raw: string, keepSelf = false): PyParam[] {
  return splitTop(raw.replace(/\s*\n\s*/g, " "))
    .filter((p) => p && (keepSelf || (p !== "self" && p !== "cls")))
    .map((p) => {
      const [left, ...rest] = splitTop(p, "=");
      const dflt = rest.length ? rest.join("=").trim() : undefined;
      const [name, ...type] = splitTop(left!, ":");
      return { name: name!.trim(), type: type.join(":").trim(), dflt };
    });
}

/** inspect.cleandoc: drop the first line's indent and the common indent of the rest. */
function cleandoc(s: string): string {
  const lines = s.replace(/\r/g, "").split("\n");
  const rest = lines.slice(1);
  const indent = Math.min(...rest.filter((l) => l.trim()).map((l) => l.match(/^ */)![0].length), Infinity);
  return [lines[0]!.trim(), ...rest.map((l) => (Number.isFinite(indent) ? l.slice(indent) : l))].join("\n").trim();
}

/** The docstring right after position `at` (the end of a def/class header), if any. */
function docstringAfter(source: string, at: number): string {
  const m = source.slice(at).match(/^[^\n]*\n(?:[ \t]*\n)*[ \t]*(?:r?"""([\s\S]*?)"""|r?'''([\s\S]*?)''')/);
  return m ? cleandoc(m[1] ?? m[2] ?? "") : "";
}

function pyDef(source: string, file: string, name: string, prefix = "", keepSelf = false): { params: PyParam[]; returns: string; doc: string; end: number } {
  const re = new RegExp(`^${prefix}(?:async )?def ${name}\\(`, "m");
  const m = re.exec(source);
  if (!m) throw new Error(`sdk-reference: def ${name} not found in ${file}`);
  const open = m.index + m[0].length - 1;
  const close = closing(source, open);
  const head = source.slice(close + 1).match(/^\s*(?:->\s*([^:]+?))?\s*:/);
  if (!head) throw new Error(`sdk-reference: cannot read the signature of ${name} in ${file}`);
  const end = close + 1 + head[0].length;
  return { params: pyParams(source.slice(open + 1, close), keepSelf), returns: head[1]?.trim() ?? "", doc: docstringAfter(source, end), end };
}

const pyParamText = (p: PyParam) => `${p.name}${p.type ? `: ${p.type}` : ""}${p.dflt !== undefined ? (p.type ? ` = ${p.dflt}` : `=${p.dflt}`) : ""}`;

function pyDefDecl(name: string, params: PyParam[], returns: string): string {
  return signature(`def ${name}`, params.map(pyParamText), returns ? ` -> ${returns}` : "");
}

/** One public name of a module: a def, a class (with its public methods) or a constant. */
function pyItem(file: string, name: string): PyApi {
  const source = read(`${PY_PKG}${file}`);
  if (new RegExp(`^(?:async )?def ${name}\\(`, "m").test(source)) {
    const d = pyDef(source, file, name);
    return { name, file, kind: "function", doc: d.doc, params: d.params, returns: d.returns, decl: pyDefDecl(name, d.params, d.returns) };
  }
  const cls = new RegExp(`^class ${name}\\b[^\\n]*:`, "m").exec(source);
  if (cls) {
    const bodyEnd = source.slice(cls.index + cls[0].length).search(/\n\S/);
    const body = bodyEnd < 0 ? source.slice(cls.index) : source.slice(cls.index, cls.index + cls[0].length + bodyEnd);
    const methods = [...body.matchAll(/^ {4}def ([a-z]\w*)\(/gm)].map((x) => x[1]!);
    const lines = [cls[0]];
    for (const meth of methods) {
      const d = pyDef(body, file, meth, " {4}", true);
      lines.push(`    ${pyDefDecl(meth, d.params, d.returns).replace(/\n/g, "\n    ")}: ...`);
    }
    return { name, file, kind: "class", doc: docstringAfter(source, cls.index + cls[0].length), params: [], returns: "", decl: lines.join("\n") };
  }
  const c = new RegExp(`^${name}(?:\\s*:\\s*[^=\\n]+)?\\s*=\\s*(.+)$`, "m").exec(source);
  if (c) return { name, file, kind: "constant", doc: "", params: [], returns: "", decl: `${name} = ${c[1]!.trim()}` };
  throw new Error(`sdk-reference: ${name} is in __all__ but not defined in ${file}`);
}

/** Every name in coding_sh.__all__, resolved to the module that defines it. */
export function pyPublic(): PyApi[] {
  const init = read(`${PY_PKG}__init__.py`);
  const where = new Map<string, string>();
  for (const m of init.matchAll(/^from \.(\w+) import (?:\(([^)]*)\)|([^\n]+))/gm)) {
    for (const n of (m[2] ?? m[3]!).split(",").map((s) => s.trim().split(/\s+as\s+/).pop()!)) if (n) where.set(n, `${m[1]}.py`);
  }
  return pyAll(init, "coding_sh/__init__.py").map((name) => {
    const file = where.get(name);
    if (!file) throw new Error(`sdk-reference: coding_sh.${name} is in __all__ but not imported from a submodule`);
    return pyItem(file, name);
  });
}

/** Every name in coding_sh.otel.__all__. */
export function pyOtel(): PyApi[] {
  return pyAll(read(`${PY_PKG}otel.py`), "coding_sh/otel.py").map((name) => pyItem("otel.py", name));
}

/** init() parameter → its effective default and env vars, read from Config.__init__ in _client.py. */
export function pyOptionDefaults(params: string[]): Map<string, OptionInfo> {
  const source = read(`${PY_PKG}_client.py`);
  const cls = /^class Config\b[^\n]*:/m.exec(source);
  if (!cls) throw new Error("sdk-reference: class Config not found in coding_sh/_client.py");
  const init = pyDef(source.slice(cls.index), "_client.py", "__init__", " {4}");
  const rest = source.slice(cls.index + init.end);
  const body = rest.slice(0, rest.search(/\n {4}\S|\n\S/)).split("\n").map((l) => l.trim()).filter(Boolean);
  const locals = new Map<string, string>();
  for (const l of body) {
    const m = l.match(/^(\w+)\s*=\s*(.+)$/);
    if (m) locals.set(m[1]!, m[2]!);
  }
  const out = new Map<string, OptionInfo>();
  for (const p of params) {
    const word = new RegExp(`(?<!\\.)\\b${p}\\b`);
    const lines = body.filter((l) => word.test(l.replace(/^self\.\w+\s*=/, "")));
    if (!lines.length) throw new Error(`sdk-reference: Config.__init__ does not use ${p}`);
    const related = [...lines];
    // A local that feeds this parameter's line (env_disabled = _env_bool("CODING_SH_DISABLED")).
    for (const [local, expr] of locals) if (lines.some((l) => new RegExp(`\\b${local}\\b`).test(l.replace(/^\w+\s*=/, "").replace(/^self\.\w+\s*=/, "")))) related.push(expr);
    const env = new Set<string>();
    let dflt: string | undefined;
    for (const l of related) {
      for (const m of l.matchAll(/_env(?:_bool)?\("([A-Z_]+)"\)/g)) env.add(m[1]!);
      dflt ??= l.match(new RegExp(`\\b([\\d.]+) if ${p} is None else ${p}\\b`))?.[1] ?? l.match(new RegExp(`\\b${p}\\b[^\\n]*\\bor "([^"]+)"\\)`))?.[1]?.replace(/^(.*)$/, '"$1"');
    }
    out.set(p, { dflt, env: [...env] });
  }
  return out;
}

// ---------------------------------------------------------------- env vars

/** Env vars the SDK core reads (config.ts, _client.py). The generator fails on one missing here. */
const ENV: { name: string; desc: string }[] = [
  { name: "CODING_SH_URL", desc: "Base URL of your coding.sh server, e.g. `http://127.0.0.1:4318`. Unset: the SDK does nothing." },
  { name: "CODING_SH_INGEST_KEY", desc: "Ingest key (`csh_ik_...`), sent as a Bearer token. The key decides the project. Optional on a loopback server with no keys." },
  { name: "CODING_SH_SERVICE", desc: "Service name. The server turns it into the session's agent id, e.g. `support-agent`." },
  { name: "OTEL_SERVICE_NAME", desc: "Used as the service name when `CODING_SH_SERVICE` is unset." },
  { name: "CODING_SH_CAPTURE_MODE", desc: "`full` (default) or `metadata`. `metadata` drops message text and tool inputs and outputs before they leave the process." },
  { name: "CODING_SH_DISABLED", desc: "`1` (or `true`, `yes`, `on`) turns the SDK off." },
  { name: "CODING_SH_DEBUG", desc: "`1` (or `true`, `yes`, `on`) logs transport details to stderr. Keys and bodies are never logged." },
];

const ENV_RE = /\b((?:CODING_SH|OTEL)_[A-Z_]*[A-Z])\b/g;
const envIn = (path: string) => new Set([...read(path).matchAll(ENV_RE)].map((m) => m[1]!));

function envTable(): string[] {
  const tsEnv = envIn(`${TS_SDK}src/config.ts`);
  const pyEnv = envIn(`${PY_PKG}_client.py`);
  for (const v of [...tsEnv, ...pyEnv]) if (!ENV.some((e) => e.name === v)) throw new Error(`sdk-reference: the SDKs read ${v}; describe it in ENV in scripts/sdk-reference.ts`);
  const rows = ENV.map((e) => {
    if (!tsEnv.has(e.name) && !pyEnv.has(e.name)) throw new Error(`sdk-reference: neither SDK reads ${e.name} any more; remove it from ENV`);
    return `| \`${e.name}\` | ${tsEnv.has(e.name) ? "yes" : "no"} | ${pyEnv.has(e.name) ? "yes" : "no"} | ${cell(e.desc)} |`;
  });
  return ["| Variable | TypeScript | Python | Meaning |", "|---|---|---|---|", ...rows, ""];
}

// ---------------------------------------------------------------- hand-written parts

/** Descriptions for exported names or fields that have no JSDoc in the source. */
const TS_FALLBACK: Record<string, string> = {
  stats: "Counts of events queued, sent, dropped and failed in this process. Counts from a transport replaced by a later `init()` are kept.",
  TransportStats: "What `stats()` returns.",
  TraceHandle: "Passed to the function given to `trace()`. The ids of the trace and the session it records into.",
  AiSdkTracer: "What `aiSdkTracer()` returns: the subset of the OpenTelemetry `Tracer` interface the AI SDK calls.",
  "InitOptions.flushIntervalMs": "How often queued events are sent, in milliseconds.",
  "InitOptions.disabled": "Turn the SDK off.",
  "InitOptions.debug": "Log transport details to stderr (never keys or bodies).",
  "TraceOptions.userId": "Your user's id, recorded on the turn's `session.start` event.",
  "TraceOptions.metadata": "Any JSON object, recorded on the turn's `session.start` event.",
  "TraceHandle.traceId": "Id of this trace.",
  "TraceHandle.spanId": "Id of the trace's root span.",
  "TraceHandle.sessionId": "Session the trace records into: `sessionId` when given, else the trace id.",
  "TransportStats.queued": "Events waiting to be sent.",
  "TransportStats.sent": "Events the server accepted.",
  "TransportStats.dropped": "Events dropped before sending: the queue was full, or the event was too large or not serializable.",
  "TransportStats.failed": "Events the server rejected, or that were still unsent when retries or `shutdown()` gave up.",
};

const TS_INTRO = (engines: string) => [
  "### Install",
  "",
  "```sh",
  "npm install @codingdotsh/sdk",
  "export CODING_SH_URL=http://127.0.0.1:4318   # where coding.sh serve listens",
  "export CODING_SH_SERVICE=support-agent",
  "```",
  "",
  `Node \`${engines}\`. No runtime dependencies. Add \`CODING_SH_INGEST_KEY\` when your server requires ingest keys.`,
  "",
  "### Minimal use",
  "",
  "```ts",
  'import OpenAI from "openai";',
  'import { observe } from "@codingdotsh/sdk";',
  "",
  "const openai = observe(new OpenAI());",
  'const reply = await openai.chat.completions.create({ model: "gpt-4o-mini", messages: [{ role: "user", content: "Where is my order?" }] });',
  "```",
  "",
  "`observe()` also takes an Anthropic client. Each model call becomes one session with its tokens, model, latency, time to first token, stop reason and tool calls. The server prices it.",
  "",
  "### Traces, tools and conversations",
  "",
  "```ts",
  'import { span, trace } from "@codingdotsh/sdk";',
  "",
  "const answer = await trace(",
  '  "support-reply",',
  "  async () => {",
  '    const order = await span("tool", "lookup_order", () => orders.get(42), { input: { id: 42 } });',
  "    const res = await openai.chat.completions.create({",
  '      model: "gpt-4o-mini",',
  '      messages: [{ role: "user", content: `${question} Order status: ${order.status}` }],',
  "    });",
  "    return res.choices[0].message.content;",
  "  },",
  '  { sessionId: conversationId, userId: "user-17", input: question },',
  ");",
  "```",
  "",
  "Each top-level `trace()` is its own session unless you pass `sessionId`, which makes each trace one turn of that conversation. A string returned from the traced function becomes the turn's output. Context follows `AsyncLocalStorage`, so it crosses `await`.",
  "",
  "### Short-lived processes",
  "",
  "Events are sent in the background in batches. The SDK flushes on `beforeExit`, which does not fire on `process.exit()`, and a serverless function can freeze as soon as it responds:",
  "",
  "```ts",
  'import { flush, shutdown } from "@codingdotsh/sdk";',
  "",
  "await flush(); // serverless: waitUntil(flush())",
  "await shutdown(); // before process.exit()",
  "```",
  "",
  "### AI SDK",
  "",
  "```ts",
  'import { openai } from "@ai-sdk/openai";',
  'import { OpenTelemetry } from "@ai-sdk/otel";',
  'import { generateText } from "ai";',
  'import { aiSdkTracer } from "@codingdotsh/sdk";',
  "",
  "const { text } = await generateText({",
  '  model: openai("gpt-4o-mini"),',
  '  prompt: "Summarize this ticket.",',
  "  telemetry: { integrations: new OpenTelemetry({ tracer: aiSdkTracer() }) },",
  "});",
  "```",
  "",
  "That is AI SDK 7. On AI SDK 6 and older, pass `experimental_telemetry: { isEnabled: true, tracer: aiSdkTracer() }` instead.",
  "",
];

const PY_INTRO = (requires: string, extras: string[]) => [
  "### Install",
  "",
  "```sh",
  "pip install coding-sh",
  "export CODING_SH_URL=http://127.0.0.1:4318   # where coding.sh serve listens",
  "export CODING_SH_SERVICE=billing-agent",
  "```",
  "",
  `Python \`${requires}\`. Standard library only. Extras: ${extras.map((e) => `\`coding-sh[${e}]\``).join(", ")}. Add \`CODING_SH_INGEST_KEY\` when your server requires ingest keys.`,
  "",
  "### Minimal use",
  "",
  "```python",
  "import coding_sh",
  "from openai import OpenAI",
  "",
  "client = coding_sh.observe(OpenAI())",
  'reply = client.chat.completions.create(model="gpt-4o-mini", messages=[{"role": "user", "content": "Where is my order?"}])',
  "```",
  "",
  "`observe()` also takes `AsyncOpenAI`, `Anthropic` and `AsyncAnthropic` clients, sync, async and streaming.",
  "",
  "### Traces, tools and conversations",
  "",
  "```python",
  'with coding_sh.trace("billing-reply", session_id=conversation_id, user_id="user-17", input=question) as t:',
  '    with coding_sh.span("tool", "lookup_invoice", input={"id": 42}) as s:',
  "        s.set_output(invoices.get(42))",
  '    reply = client.chat.completions.create(model="gpt-4o-mini", messages=[{"role": "user", "content": question}])',
  "    t.set_output(reply.choices[0].message.content)",
  "",
  '@coding_sh.span("tool", "refund")',
  "def refund(invoice_id: int) -> dict:",
  "    return invoices.refund(invoice_id)",
  "",
  "coding_sh.flush(timeout=5)  # end of a script, a job or a serverless handler",
  "```",
  "",
  "`trace` and `span` work as context managers (`with` and `async with`) and as decorators. A decorated tool span records the call's arguments as input and the return value as output. Context follows `contextvars`, so it crosses `await` and asyncio tasks. Work handed to a thread pool starts untraced unless you run it with `contextvars.copy_context().run`.",
  "",
];

// ---------------------------------------------------------------- rendering

const tsHeading = (e: TsExport) => (e.kind === "function" ? `\`${e.name}(${e.params.map((p) => `${p.name}${p.optional ? "?" : ""}`).join(", ")})\`` : `\`${e.name}\``);

function linkTypes(type: string, names: Map<string, string>): string {
  const ref = [...names.keys()].find((n) => new RegExp(`^${n}$`).test(type));
  return ref ? `[${code(type)}](#${names.get(ref)})` : code(type);
}

function renderTsExport(e: TsExport, anchors: Map<string, string>, options: Map<string, OptionInfo>): string[] {
  const out = [`### ${tsHeading(e)}`, ""];
  const doc = e.doc || TS_FALLBACK[e.name] || "";
  out.push(...prose(doc, "ts"));
  out.push("```ts", e.decl, "```", "");
  if (e.kind === "function" && e.params.length) {
    out.push("| Parameter | Type | Default |", "|---|---|---|");
    for (const p of e.params) out.push(`| \`${p.name}\` | ${p.type ? cell(linkTypes(p.type, anchors)) : ""} | ${p.dflt !== undefined ? cell(code(p.dflt)) : p.optional ? "optional" : "required"} |`);
    out.push("");
  }
  if (e.kind === "interface" && e.fields.length) {
    const withEnv = e.name === "InitOptions";
    out.push(withEnv ? "| Field | Type | Default | Env | Description |" : "| Field | Type | Description |", withEnv ? "|---|---|---|---|---|" : "|---|---|---|");
    for (const f of e.fields) {
      const desc = sentence(cell((f.doc || TS_FALLBACK[`${e.name}.${f.name}`] || "").replace(/\s*\n\s*/g, " ")));
      const type = cell(linkTypes(f.type, anchors));
      if (withEnv) {
        const o = options.get(f.name);
        const dflt = o?.dflt ?? (f.type === "boolean" ? "false" : undefined);
        out.push(`| \`${f.name}\` | ${type} | ${dflt !== undefined ? cell(code(dflt)) : ""} | ${(o?.env ?? []).map((v) => `\`${v}\``).join(", ")} | ${desc} |`);
      } else out.push(`| \`${f.name}\` | ${type} | ${desc} |`);
    }
    out.push("");
  }
  return out;
}

function pyHeading(prefix: string, a: PyApi): string {
  if (a.kind !== "function") return `\`${prefix}${a.name}\``;
  const args = [...a.params.filter((p) => p.dflt === undefined).map((p) => p.name), ...(a.params.some((p) => p.dflt !== undefined) ? ["..."] : [])];
  return `\`${prefix}${a.name}(${args.join(", ")})\``;
}

function renderPy(prefix: string, a: PyApi, options?: Map<string, OptionInfo>): string[] {
  const out = [`### ${pyHeading(prefix, a)}`, ""];
  if (a.kind === "constant") {
    out.push(a.name === "__version__" ? "The package version, a string." : `A constant: ${code(a.decl.split(" = ")[1]!)}.`, "");
    return out;
  }
  out.push(...prose(a.doc, "python"));
  out.push("```python", a.decl, "```", "");
  if (a.kind === "function" && a.params.length) {
    if (options) {
      out.push("| Parameter | Type | Default when unset | Env |", "|---|---|---|---|");
      for (const p of a.params) {
        const o = options.get(p.name);
        const dflt = o?.dflt ?? (/\bbool\b/.test(p.type) ? "False" : undefined);
        out.push(`| \`${p.name}\` | ${cell(code(p.type))} | ${dflt !== undefined ? cell(code(dflt)) : ""} | ${(o?.env ?? []).map((v) => `\`${v}\``).join(", ")} |`);
      }
    } else {
      out.push("| Parameter | Type | Default |", "|---|---|---|");
      for (const p of a.params) out.push(`| \`${p.name}\` | ${p.type ? cell(code(p.type)) : ""} | ${p.dflt !== undefined ? cell(code(p.dflt)) : "required"} |`);
    }
    out.push("");
  }
  return out;
}

/** The whole reference as Markdown. Deterministic: no version, no date. */
export function renderSdkReference(): string {
  const tsPkg = JSON.parse(read(`${TS_SDK}package.json`)) as { name: string; engines?: { node?: string } };
  const pyProject = read(`${PY_SDK}pyproject.toml`);
  const pyName = pyProject.match(/^name\s*=\s*"([^"]+)"/m)?.[1];
  const pyRequires = pyProject.match(/^requires-python\s*=\s*"([^"]+)"/m)?.[1] ?? "";
  const extrasBlock = pyProject.split(/^\[project\.optional-dependencies\]$/m)[1]?.split(/^\[/m)[0] ?? "";
  const pyExtras = [...extrasBlock.matchAll(/^(\w[\w-]*)\s*=/gm)].map((m) => m[1]!);
  if (tsPkg.name !== "@codingdotsh/sdk" || pyName !== "coding-sh") throw new Error("sdk-reference: package names changed; update the intros");

  const ts_ = tsExports();
  const anchors = new Map<string, string>(ts_.filter((e) => e.kind !== "function").map((e) => [e.name, slug(tsHeading(e))]));
  const initOptions = ts_.find((e) => e.name === "InitOptions");
  const tsOptions = initOptions ? tsOptionDefaults(initOptions.fields.map((f) => f.name)) : new Map<string, OptionInfo>();
  const py = pyPublic();
  const pyInit = py.find((a) => a.name === "init");
  const pyOptions = pyInit ? pyOptionDefaults(pyInit.params.map((p) => p.name)) : undefined;
  const otel = pyOtel();

  const tsFlush = ts_.find((e) => e.name === "flush")?.params[0]?.dflt;
  const tsShutdown = ts_.find((e) => e.name === "shutdown")?.params[0]?.dflt;
  const pyFlush = py.find((a) => a.name === "flush")?.params[0]?.dflt;
  const pyShutdown = py.find((a) => a.name === "shutdown")?.params[0]?.dflt;
  const tsExit = read(`${TS_SDK}src/client.ts`).match(/^const EXIT_FLUSH_MS = ([\d_]+);/m)?.[1]?.replace(/_/g, "");
  const pyExit = read(`${PY_PKG}_client.py`).match(/^ATEXIT_TIMEOUT_S = ([\d.]+)/m)?.[1];
  if (!tsFlush || !tsShutdown || !pyFlush || !pyShutdown || !tsExit || !pyExit) throw new Error("sdk-reference: flush/shutdown defaults not found; update renderSdkReference()");

  const out = [
    "# SDK reference",
    "",
    "The TypeScript and Python SDKs send model calls, traces and tool spans from your app to a coding.sh server. This page is generated from the SDK source.",
    "",
    "Site version: [coding.sh/docs/sdk](https://coding.sh/docs/sdk).",
    "",
    "<!-- Generated from packages/sdk and packages/sdk-python by packages/coding.sh/scripts/sdk-reference.ts. Do not edit by hand. -->",
    "",
    "Both SDKs send to a server you run with `coding.sh serve` ([production guide](https://coding.sh/docs/production), [serverless apps](https://coding.sh/docs/deploy)). Without `CODING_SH_URL` they do nothing. They never change return values, errors or stream behavior, and never throw into your app. The one exception is `weightsDelta()` (`coding_sh.weights_delta()` in Python), a pure helper you call on purpose: it throws on bad input. The SDKs do not price calls; the server does.",
    "",
    "## Environment variables",
    "",
    "Both SDKs read the same variables. Options passed to `init()` win over them. Every other variable coding.sh reads is in the [configuration reference](https://coding.sh/docs/config).",
    "",
    ...envTable(),
    `## TypeScript: \`${tsPkg.name}\``,
    "",
    ...TS_INTRO(tsPkg.engines?.node ?? ""),
    "### Exports",
    "",
    "| Name | Kind |",
    "|---|---|",
    ...ts_.map((e) => `| [\`${e.name}\`](#${slug(tsHeading(e))}) | ${e.kind} |`),
    "",
  ];
  for (const e of ts_.filter((x) => x.kind === "function")) out.push(...renderTsExport(e, anchors, tsOptions));
  for (const e of ts_.filter((x) => x.kind !== "function")) out.push(...renderTsExport(e, anchors, tsOptions));

  out.push(
    `## Python: \`${pyName}\``,
    "",
    "Import it as `coding_sh`.",
    "",
    ...PY_INTRO(pyRequires, pyExtras),
    "### Public names",
    "",
    "Everything in `coding_sh.__all__`:",
    "",
    "| Name | Kind |",
    "|---|---|",
    ...py.map((a) => `| [\`coding_sh.${a.name}\`](#${slug(pyHeading("coding_sh.", a))}) | ${a.kind} |`),
    "",
  );
  for (const a of py) out.push(...renderPy("coding_sh.", a, a.name === "init" ? pyOptions : undefined));

  out.push(
    "### `coding_sh.otel`",
    "",
    "For apps that already emit OpenTelemetry gen_ai spans. Needs `pip install coding-sh[otel]`. `configure()` picks the endpoint from its `url` argument, then `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` or `OTEL_EXPORTER_OTLP_ENDPOINT`, then `CODING_SH_URL` with `CODING_SH_INGEST_KEY`. See [OpenTelemetry](https://coding.sh/docs/otel).",
    "",
    "| Name | Kind |",
    "|---|---|",
    ...otel.map((a) => `| [\`coding_sh.otel.${a.name}\`](#${slug(pyHeading("coding_sh.otel.", a))}) | ${a.kind} |`),
    "",
  );
  for (const a of otel) out.push(...renderPy("coding_sh.otel.", a));

  out.push(
    "## Differences between the SDKs",
    "",
    `- \`flush()\` waits at most \`${tsFlush}\` ms by default in TypeScript. In Python, \`flush()\` with \`timeout=${pyFlush}\` waits until the queue is sent or the sender gives up on it.`,
    `- \`shutdown()\` waits at most \`${tsShutdown}\` ms in TypeScript and \`${pyShutdown}\` s in Python. Without a call, Python flushes at exit for at most \`${pyExit}\` s, and TypeScript flushes on \`beforeExit\` for at most \`${tsExit}\` ms.`,
    "- TypeScript times are in milliseconds (`timeoutMs`, `flushIntervalMs`). Python timeouts are in seconds; only `flush_interval_ms` is in milliseconds.",
    "- In TypeScript, `trace()`, `span()` and `withSession()` take the function to run. In Python, they are context managers and decorators.",
    "- `aiSdkTracer()` and `observeFetch()` are TypeScript only. `coding_sh.otel` is Python only.",
    "- `weightsEdit()` takes one object in TypeScript; `weights_edit()` takes arguments in Python. Both record the same event. `weightsDelta()` returns `maxAbs` where `weights_delta()` returns `max_abs`, and throws a `TypeError` or `RangeError` where Python raises `ValueError`.",
    "- A weight count or dimension must be an integer below 2^53 in TypeScript; Python takes any integer. Python also takes numpy scalars as numbers, and `weights_delta()` reads anything with `.tolist()`; in TypeScript `weightsDelta()` reads arrays and typed arrays.",
    "- A long tensor name or note is cut. TypeScript cuts at 64 KiB of UTF-8 and sets `payload.truncated`; Python cuts at 65,536 characters and appends `…[truncated]`.",
    "",
  );
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

function isMain(): boolean {
  return !!process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
}

if (isMain()) {
  const want = renderSdkReference();
  if (process.argv.includes("--check")) {
    let have = "";
    try {
      have = readFileSync(SDK_REFERENCE_PATH, "utf8");
    } catch {}
    if (have !== want) {
      process.stderr.write(`${SDK_REFERENCE_PATH} is stale. Regenerate it: node packages/coding.sh/scripts/sdk-reference.ts\n`);
      process.exit(1);
    }
    process.stdout.write("docs/reference/sdk.md is up to date\n");
  } else {
    writeFileSync(SDK_REFERENCE_PATH, want);
    process.stdout.write(`wrote ${SDK_REFERENCE_PATH}\n`);
  }
}
