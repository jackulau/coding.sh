// JSON Schema (draft 2020-12) for the coding.sh/trace format, generated from the
// TypeScript types in src/schema/index.ts. No new dependency: it reads the types with
// the TypeScript compiler the package already builds with.
//
//   node --no-warnings scripts/json-schema.ts            rewrite src/schema/trace.schema.json
//   node --no-warnings scripts/json-schema.ts --check    exit 1 when that file is stale
//   node --no-warnings scripts/json-schema.ts --out <f>  also write the schema to <f>
//
// The committed file ships as dist/schema.json (scripts/bundle.mjs copies it), is exported
// as `coding.sh/schema.json`, and is served at https://coding.sh/schema.json.
// test/schema/json-schema.test.ts fails when it drifts from the types.
//
// Mapping: interfaces and type aliases declared in src/schema/index.ts become `$defs`
// (referenced by `$ref`); JSDoc becomes `description`; optional properties are left out of
// `required`; objects without an index signature are closed (`additionalProperties: false`);
// `Record<string, T>` and index signatures become `additionalProperties: T`; unions of
// literals become `enum`; `typeof X` of a constant becomes `const`; a union with
// `(string & {})` (an open id like AgentId) becomes a string with the known values as
// `examples`.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export type Schema = { [k: string]: unknown };

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const SCHEMA_SOURCE = join(PKG, "src", "schema", "index.ts");
export const SCHEMA_JSON = join(PKG, "src", "schema", "trace.schema.json");
/** The types a document can be: the root schema accepts either. */
export const ROOT_TYPES = ["AgentEvent", "Session"] as const;
export const SCHEMA_URL = "https://coding.sh/schema.json";

export function generateTraceSchema(source = SCHEMA_SOURCE): Schema {
  const program = ts.createProgram([source], {
    strict: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2022,
    lib: ["lib.es2022.d.ts"],
    types: [],
    skipLibCheck: true,
  });
  const checker = program.getTypeChecker();
  const sf = program.getSourceFile(source);
  if (!sf) throw new Error(`json-schema: cannot read ${source}`);

  const decls = new Map<string, ts.InterfaceDeclaration | ts.TypeAliasDeclaration>();
  for (const st of sf.statements) if (ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st)) decls.set(st.name.text, st);
  const local = (sym: ts.Symbol | undefined): string | undefined => {
    const d = sym?.declarations?.[0];
    return d && d.getSourceFile() === sf && (ts.isInterfaceDeclaration(d) || ts.isTypeAliasDeclaration(d)) ? d.name.text : undefined;
  };

  const defs = new Map<string, Schema>();
  const pending: string[] = [];
  const ref = (name: string): Schema => {
    if (!defs.has(name) && !pending.includes(name)) pending.push(name);
    return { $ref: `#/$defs/${name}` };
  };
  const docOf = (sym: ts.Symbol | undefined): string => (sym ? ts.displayPartsToString(sym.getDocumentationComment(checker)).trim() : "");
  const withDoc = (s: Schema, doc: string): Schema => (doc ? { description: doc, ...s } : s);
  const fail = (what: string, node?: ts.Node): never => {
    const at = node ? ` at ${source}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}` : "";
    throw new Error(`json-schema: cannot map ${what}${at}; extend scripts/json-schema.ts`);
  };

  /** Literals in a union become one const or enum (true + false: a boolean); with anything else, anyOf. */
  const union = (parts: Schema[]): Schema => {
    const flat = parts.flatMap((p) => (Array.isArray(p.anyOf) && Object.keys(p).length === 1 ? (p.anyOf as Schema[]) : [p]));
    let values: unknown[] = [];
    const rest: Schema[] = [];
    for (const p of flat) {
      const only = Object.keys(p).length === 1;
      if (only && "const" in p) values.push(p.const);
      else if (only && Array.isArray(p.enum)) values.push(...p.enum);
      else rest.push(p);
    }
    values = [...new Set(values)];
    if (values.includes(true) && values.includes(false)) {
      values = values.filter((v) => typeof v !== "boolean");
      rest.push({ type: "boolean" });
    }
    if (values.length) rest.unshift(values.length === 1 ? { const: values[0] } : { enum: values });
    return rest.length === 1 ? rest[0]! : { anyOf: rest };
  };

  /** A union that includes `(string & {})`: any string, the named literals as examples. */
  const openString = (members: readonly ts.Type[]): Schema | undefined => {
    const open = members.some((m) => m.flags & ts.TypeFlags.Intersection && (m as ts.IntersectionType).types.some((t) => t.flags & ts.TypeFlags.String));
    if (!open) return undefined;
    const known = members.filter((m) => m.isStringLiteral()).map((m) => (m as ts.StringLiteralType).value);
    return known.length ? { type: "string", examples: known } : { type: "string" };
  };

  const fromType = (t: ts.Type, node?: ts.Node): Schema => {
    const named = local(t.aliasSymbol) ?? (t.flags & ts.TypeFlags.Object ? local(t.symbol) : undefined);
    if (named && decls.has(named)) return ref(named);
    const f = t.flags;
    if (f & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return {};
    if (f & ts.TypeFlags.String) return { type: "string" };
    if (f & ts.TypeFlags.Number) return { type: "number" };
    if (f & ts.TypeFlags.Boolean) return { type: "boolean" };
    if (f & ts.TypeFlags.Null) return { type: "null" };
    if (t.isStringLiteral() || t.isNumberLiteral()) return { const: t.value };
    if (f & ts.TypeFlags.BooleanLiteral) return { const: checker.typeToString(t) === "true" };
    if (t.isUnion()) {
      const members = t.types.filter((m) => !(m.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)));
      return openString(members) ?? union(members.map((m) => fromType(m, node)));
    }
    if (t.isIntersection()) {
      if (t.types.some((m) => m.flags & ts.TypeFlags.String)) return { type: "string" };
      return { allOf: t.types.map((m) => fromType(m, node)) };
    }
    if (checker.isArrayType(t)) return { type: "array", items: fromType(checker.getTypeArguments(t as ts.TypeReference)[0]!, node) };
    if (checker.isTupleType(t)) {
      const items = checker.getTypeArguments(t as ts.TypeReference).map((m) => fromType(m, node));
      return { type: "array", prefixItems: items, minItems: items.length, maxItems: items.length };
    }
    if (f & ts.TypeFlags.Object) return objectFromType(t, node);
    return fail(`type ${checker.typeToString(t)}`, node);
  };

  const objectFromType = (t: ts.Type, node?: ts.Node): Schema => {
    if (checker.getSignaturesOfType(t, ts.SignatureKind.Call).length) return fail(`function type ${checker.typeToString(t)}`, node);
    const properties: Schema = {};
    const required: string[] = [];
    for (const p of checker.getPropertiesOfType(t)) {
      const decl = p.valueDeclaration;
      const typeNode = decl && (ts.isPropertySignature(decl) || ts.isPropertyDeclaration(decl)) ? decl.type : undefined;
      // Use the written type when there is one: it keeps alias names (EventKind, AgentId)
      // that the optional `| undefined` would otherwise drop.
      const s = typeNode ? fromTypeNode(typeNode) : fromType(checker.getNonNullableType(checker.getTypeOfSymbol(p)), node);
      properties[p.name] = withDoc(s, docOf(p));
      if (!(p.flags & ts.SymbolFlags.Optional)) required.push(p.name);
    }
    const index = checker.getIndexTypeOfType(t, ts.IndexKind.String);
    const out: Schema = { type: "object" };
    if (Object.keys(properties).length) out.properties = properties;
    if (required.length) out.required = required;
    if (!index) out.additionalProperties = false;
    else if (!(index.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown))) out.additionalProperties = fromType(index, node);
    return out;
  };

  const fromTypeNode = (n: ts.TypeNode): Schema => {
    if (ts.isParenthesizedTypeNode(n)) return fromTypeNode(n.type);
    if (ts.isTypeReferenceNode(n) && ts.isIdentifier(n.typeName) && !n.typeArguments && decls.has(n.typeName.text)) return ref(n.typeName.text);
    if (ts.isArrayTypeNode(n)) return { type: "array", items: fromTypeNode(n.elementType) };
    if (ts.isTypeLiteralNode(n)) return objectFromType(checker.getTypeFromTypeNode(n), n);
    if (ts.isUnionTypeNode(n)) {
      const open = openString(n.types.map((m) => checker.getTypeFromTypeNode(m)).flatMap((m) => (m.isUnion() ? m.types : [m])));
      if (open) return open;
      return union(n.types.filter((m) => m.kind !== ts.SyntaxKind.UndefinedKeyword).map(fromTypeNode));
    }
    return fromType(checker.getTypeFromTypeNode(n), n);
  };

  const defOf = (name: string): Schema => {
    const d = decls.get(name)!;
    const sym = checker.getSymbolAtLocation(d.name);
    const body = ts.isInterfaceDeclaration(d) ? objectFromType(checker.getDeclaredTypeOfSymbol(sym!), d) : fromTypeNode(d.type);
    return withDoc(body, docOf(sym));
  };

  for (const name of ROOT_TYPES) ref(name);
  while (pending.length) {
    const name = pending.shift()!;
    defs.set(name, defOf(name));
  }

  const SCHEMA_ID = constString(sf, "SCHEMA_ID");
  const SCHEMA_VERSION = constString(sf, "SCHEMA_VERSION");
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: SCHEMA_URL,
    title: `${SCHEMA_ID} v${SCHEMA_VERSION}`,
    description:
      "The coding.sh trace format: an AgentEvent (one normalized event) or a Session (the row ingest builds from a session's events). " +
      "Validate one of them with #/$defs/AgentEvent or #/$defs/Session. Generated from packages/coding.sh/src/schema/index.ts by scripts/json-schema.ts.",
    anyOf: ROOT_TYPES.map((n) => ({ $ref: `#/$defs/${n}` })),
    $defs: Object.fromEntries([...defs].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
  };
}

/** The initializer text of `export const NAME = <literal> as const`, unquoted. */
function constString(sf: ts.SourceFile, name: string): string {
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue;
    for (const d of st.declarationList.declarations) {
      if (!ts.isIdentifier(d.name) || d.name.text !== name || !d.initializer) continue;
      const init = ts.isAsExpression(d.initializer) ? d.initializer.expression : d.initializer;
      if (ts.isStringLiteral(init) || ts.isNumericLiteral(init)) return init.text;
    }
  }
  throw new Error(`json-schema: no literal const ${name} in ${sf.fileName}`);
}

/** The schema as the committed file holds it. */
export function renderTraceSchema(source = SCHEMA_SOURCE): string {
  return JSON.stringify(generateTraceSchema(source), null, 2) + "\n";
}

function main(argv: string[]): number {
  const text = renderTraceSchema();
  if (argv.includes("--check")) {
    let current = "";
    try {
      current = readFileSync(SCHEMA_JSON, "utf8");
    } catch {}
    if (current === text) return 0;
    console.error(`json-schema: ${SCHEMA_JSON} is stale; run node --no-warnings packages/coding.sh/scripts/json-schema.ts`);
    return 1;
  }
  writeFileSync(SCHEMA_JSON, text);
  const i = argv.indexOf("--out");
  if (i >= 0) {
    const out = argv[i + 1];
    if (!out) {
      console.error("json-schema: --out needs a file");
      return 2;
    }
    writeFileSync(resolve(out), text);
  }
  console.log(`wrote ${SCHEMA_JSON}${i >= 0 ? ` and ${resolve(argv[i + 1]!)}` : ""}`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
