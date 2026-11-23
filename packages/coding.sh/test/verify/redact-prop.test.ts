// Redaction (core/redact.ts createRedactor and redactBlobValue, spool/redact.ts redactPayload), checked on
// generated text and values. A text is built from pieces: filler words, separators (spaces, line ends,
// quotes, brackets, accented and CJK letters, an emoji), a secret in each format the secret rules know
// (vendor tokens, private keys, bearer and basic credentials, a password in a URL, a secret in a query,
// an env assignment, a JSON or YAML field, a secret named in prose), and text that looks like a secret
// but is not one (commit and content hashes, UUIDs, code and prose that name a token). A value nests
// such text in objects and arrays, with secret-named keys, command lines with a secret flag, and strings
// that hold a JSON document. The properties:
//
// - No 12 characters in a row of a generated secret are left: in the text, in any string of a value, or
//   in a JSON document a string holds. A secret-named key keeps its key and holds a marker, and so does
//   the value of a secret flag.
// - Text with no secret comes out as it went in, and the hashes, UUIDs and code in any text survive.
// - Redaction is idempotent: redacting the output again gives the output.
// - A value keeps its keys in order, its types and its array lengths, and each of its strings comes out
//   as the string rules give it. A string that holds a JSON document still holds one of the same shape
//   after the hook's pass (redactPayload), and a blob's text (redactBlobValue) parses to the shape it
//   came from.
// - Ingest's pass (Redactor.value) over the hook's output changes nothing.
//
// The last test shows each check fails on a redactor with a rule taken out or a pattern added.
// CODING_SH_PROP_RUNS=n runs n cases per test (default 100); CODING_SH_PROP_SEED=s replays one. The last
// test reads neither.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRedactor, isSecretAttrKey, marker, redactBlobValue, redactionTally, type Redactor, type RedactRule } from "../../src/core/redact.ts";
import { redactPayload } from "../../src/spool/redact.ts";
import { forAll, gen, PropertyFailure, sample, type ForAllOptions, type Gen } from "../_prop.ts";

const RUNS = 100;
/** A secret counts as left when this many of its characters in a row are in the output. */
const WINDOW = 12;
const MARKER = /^\[redacted:[a-z-]+\]$/;

const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const LOWER = "abcdefghijklmnopqrstuvwxyz";
const DIGITS = "0123456789";
const ALNUM = UPPER + LOWER + DIGITS;
const B64URL = `${ALNUM}_-`;
const BASE64 = `${ALNUM}+/`;
const HEX = "0123456789abcdef";

/** `min` to `max` characters of `alphabet`. */
const chars = (alphabet: string, min: number, max = min): Gen<string> => gen.string({ alphabet, minLength: min, maxLength: max });
/** A letter, a digit, then letters and digits: a value the rules that want both take. */
const mixed = (min: number, max: number): Gen<string> =>
  gen.map(gen.tuple(gen.char(UPPER + LOWER), gen.char(DIGITS), chars(ALNUM, min - 2, max - 2)), (xs) => xs.join(""));

/** A piece of generated text: kept as it is, a secret, or text the output must still hold. */
interface Part {
  text: string;
  role: "plain" | "secret" | "survives";
  /** For a secret: the rule meant to find it. */
  kind?: string;
}
const plain = (text: string): Part => ({ text, role: "plain" });
const secret = (kind: string, text: string): Part => ({ text, role: "secret", kind });
const survives = (text: string): Part => ({ text, role: "survives" });
const isSecret = (p: Part): boolean => p.role === "secret";
const joined = (parts: readonly Part[]): string => parts.map((p) => p.text).join("");

const FILLERS = ["alpha", "build", "cache", "delta", "event", "field", "graph", "hello", "index", "join", "lambda", "merge", "node", "order", "print", "query", "route", "stage", "table", "under", "vector", "write", "yield", "zone", "naïve", "café", "日本語", "Привет"];
const SEPS = [" ", "\n", "\t", "\r\n", ",", ";", '"', "'", "(", ")", "[", "]", " ", "é", "中", "😀"];
/** Separators a JSON string holds as they are, with no escape. */
const DOC_SEPS = SEPS.filter((s) => !/[\n\t\r"]/.test(s));

/** Tokens in each vendor format, built from parts so no whole token is in this file. */
const VENDOR: Gen<Part[]>[] = [
  gen.map(chars(B64URL, 20, 60), (s) => [secret("anthropic-key", ["sk", "ant", "api03", s].join("-"))]),
  gen.map(mixed(21, 48), (s) => [secret("openai-key", ["sk", "proj", s].join("-"))]),
  gen.map(gen.tuple(gen.char("pousr"), chars(ALNUM, 36)), ([c, s]) => [secret("github-token", ["gh", c, "_", s].join(""))]),
  gen.map(gen.tuple(chars(ALNUM, 22), chars(ALNUM, 59)), ([a, b]) => [secret("github-token", ["github", "pat", a, b].join("_"))]),
  gen.map(chars(B64URL, 20, 40), (s) => [secret("gitlab-token", ["glpat", s].join("-"))]),
  gen.map(gen.tuple(gen.char("abposr"), chars(DIGITS, 10, 12), chars(DIGITS, 10, 12), chars(ALNUM, 24)), ([c, a, b, s]) => [
    secret("slack-token", [["xox", c].join(""), a, b, s].join("-")),
  ]),
  gen.map(gen.tuple(chars(UPPER + DIGITS, 8), chars(UPPER + DIGITS, 8, 10), chars(ALNUM, 24)), ([a, b, s]) => [
    plain("https://hooks.slack.com/services/"),
    secret("slack-webhook", `T${a}/B${b}/${s}`),
  ]),
  gen.map(gen.tuple(gen.pick(["AKIA", "ASIA", "AROA", "AIDA"]), chars(UPPER + DIGITS, 16)), ([p, s]) => [secret("aws-access-key", [p, s].join(""))]),
  gen.map(chars(B64URL, 35), (s) => [secret("google-api-key", ["AIza", s].join(""))]),
  gen.map(gen.tuple(gen.pick(["sk", "rk"]), gen.pick(["live", "test"]), chars(ALNUM, 16, 32)), (xs) => [secret("stripe-key", xs.join("_"))]),
  gen.map(chars(ALNUM, 36), (s) => [secret("npm-token", ["npm", s].join("_"))]),
  gen.map(gen.tuple(gen.pick(["ik", "rk"]), chars(B64URL, 32, 40)), ([k, s]) => [secret("coding-sh-key", ["csh", k, s].join("_"))]),
  gen.map(chars(B64URL, 20, 40), (s) => [secret("vercel-ai-gateway-key", ["vck", s].join("_"))]),
  gen.map(gen.tuple(chars(`${ALNUM}_`, 20, 60), chars(`${ALNUM}_`, 20, 60), chars(`${ALNUM}_`, 20, 60)), ([a, b, c]) => [
    secret("jwt", [`eyJ${a}`, `eyJ${b}`, c].join(".")),
  ]),
];

const PEM_KINDS = ["PRIVATE KEY", "RSA PRIVATE KEY", "EC PRIVATE KEY", "OPENSSH PRIVATE KEY", "ENCRYPTED PRIVATE KEY"];

/** A private key: 2 to 6 lines of base64 after its BEGIN line, then its END line unless `open`. */
const privateKey = (open: boolean): Gen<Part[]> =>
  gen.map(
    gen.tuple(gen.pick(PEM_KINDS), gen.pick(["\n", "\r\n"]), gen.array(chars(BASE64, 64), { minLength: 2, maxLength: 6, avgLength: 3 })),
    ([kind, nl, lines]) => {
      const parts = [plain(`-----BEGIN ${kind}-----`)];
      for (const line of lines) parts.push(plain(nl), secret("private-key", line));
      if (!open) parts.push(plain(nl), plain(`-----END ${kind}-----`));
      return parts;
    },
  );

const BEARER: Gen<Part[]> = gen.map(
  gen.tuple(gen.pick(["Authorization: Bearer ", "bearer "]), gen.char(DIGITS), chars(`${ALNUM}._~+/-`, 19, 47)),
  ([before, d, s]) => [plain(before), secret("bearer", d + s)],
);

const BASIC: Gen<Part[]> = gen.map(gen.tuple(chars(BASE64, 12, 40), gen.pick(["", "=", "=="])), ([s, pad]) => [
  plain("Authorization: Basic "),
  secret("basic-auth", s + pad),
]);

const URL_PASSWORD: Gen<Part[]> = gen.map(
  gen.tuple(
    gen.pick(["postgres", "mysql", "https", "redis", "amqp", "mongodb+srv"]),
    gen.pick(["admin", "app", "deploy", "svc"]),
    gen.char(DIGITS),
    chars(`${ALNUM}._~`, 11, 23),
    gen.pick(["db.internal", "cache", "10.0.0.5", "localhost"]),
    gen.pick(["", ":5432", ":6379"]),
    gen.pick(["/app", "/main", "/0", "/queue"]),
  ),
  ([scheme, user, d, pw, host, port, path]) => [plain(`${scheme}://${user}:`), secret("password", d + pw), plain(`@${host}${port}${path}`)],
);

const URL_SECRET: Gen<Part[]> = gen.map(
  gen.tuple(gen.pick(["token", "api_key", "apikey", "access_token", "client_secret", "password", "x-api-key"]), chars(`${ALNUM}._~-`, 12, 32), gen.pick(["", "&page=2", "#top"])),
  ([name, v, tail]) => [plain(`https://api.example.com/v1/items?${name}=`), secret("url-secret", v), plain(tail)],
);

/** A secret its name marks: [the rule meant to find it, text before it, text after it]. */
const NAMED: [string, string, string][] = [
  ["secret-assignment", "export DB_PASSWORD=", ""],
  ["secret-assignment", "OPENAI_API_KEY=", ""],
  ["secret-assignment", "GITHUB_TOKEN='", "'"],
  ["secret-assignment", 'AWS_SECRET_ACCESS_KEY="', '"'],
  ["secret-field", '"api_key": "', '"'],
  ["secret-field", '"client_secret": "', '"'],
  ["secret-field", 'access_token: "', '"'],
  ["secret-field", "'password': '", "'"],
  ["secret-field", "password: '", "'"],
  ["prose-secret", "the password is ", ""],
  ["prose-secret", "my api key is ", ""],
  ["prose-secret", "PAT here ya go: ", ""],
  ["prose-secret", "passphrase = ", ""],
  ["prose-secret", "token: ", ""],
  ["prose-secret", "secret: ", ""],
  ["prose-secret", "the passcode is ", ""],
];

/** A secret that a prefix or a name before it marks; `quotes` admits the forms that hold a double quote. */
function context(quotes: boolean): Gen<Part[]> {
  const named = NAMED.filter(([, before, after]) => quotes || !`${before}${after}`.includes('"'));
  const byName = gen.map(gen.tuple(gen.pick(named), mixed(12, 24)), ([[kind, before, after], v]) => [plain(before), secret(kind, v), plain(after)]);
  return gen.frequency<Part[]>([1, BEARER], [1, BASIC], [1, URL_PASSWORD], [1, URL_SECRET], [5, byName]);
}

const UUID: Gen<string> = gen.map(
  gen.tuple(chars(HEX, 8), chars(HEX, 4), chars(HEX, 3), gen.char("89ab"), chars(HEX, 3), chars(HEX, 12)),
  ([a, b, c, v, d, e]) => `${a}-${b}-4${c}-${v}${d}-${e}`,
);
/** Hashes and ids that look like secrets: a commit, a sha256, an uppercase hash, a UUID. */
const LOOKALIKE: Gen<string> = gen.oneOf(chars(HEX, 40), chars(HEX, 64), chars(HEX.toUpperCase(), 40), UUID);

/** Code and prose that name a secret, or start like one, and hold none. Each sits on a line of its own. */
const DECOYS = [
  "commit 3f786850e387550fdab836ed7e6dc881de23001b",
  "sha256 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "const task-scheduler-for-the-whole-world = 1",
  "risk-assessment-for-the-quarterly-plan",
  "/work/demo/sk-tools/README.md",
  "const apiKey = process.env.OPENAI_API_KEY;",
  "const token = getToken(user);",
  "MAX_TOKENS=100000000",
  "export API_KEY=$OPENAI_API_KEY",
  "the bearer of responsibilities was here",
  '<div className="sk-container">loading</div>',
  "https://github.com/user/repo/blob/main/src/index.ts?plain=1",
  "password: string; // field type",
  "def tokenize(text: str) -> list[str]:",
  "AKIA is a prefix but AKIASHORT is not a key",
  "eyJ alone is not a token",
  "uuid 123e4567-e89b-12d3-a456-426614174000",
  "npm install @anthropic-ai/sdk",
  "SECRET_LENGTH=32",
  "the token is required here",
  "pat the dog: good boy",
  "password: process.env.DB_PASSWORD",
  "max tokens: 4096",
];

interface TextMode {
  seps: readonly string[];
  /** What follows a secret a prefix or name marks. */
  after: Gen<Part[]>;
  /** Named secrets that hold a double quote. */
  quotes: boolean;
  /** The decoys. */
  decoys: boolean;
  /** A private key with no END line, as the last piece. */
  open: boolean;
}

const SPACE: Gen<Part[]> = gen.map(gen.pick([" ", "\n", "\t", "\r\n"]), (s) => [plain(s)]);
const SPACE_WORD: Gen<Part[]> = gen.map(gen.pick(FILLERS), (w) => [plain(` ${w}`)]);

/** Text on its own, and the strings of a value ingest redacts. */
const TEXT_MODE: TextMode = { seps: SEPS, after: SPACE, quotes: true, decoys: true, open: true };
/** The strings of a hook payload. */
const PAYLOAD_MODE: TextMode = { seps: SEPS, after: SPACE_WORD, quotes: true, decoys: false, open: false };
/** The strings inside a JSON document. */
const DOC_MODE: TextMode = { seps: DOC_SEPS, after: SPACE_WORD, quotes: false, decoys: false, open: false };

/** A filler word, then up to five pieces, each after a separator. */
function text(m: TextMode): Gen<Part[]> {
  const choices: [number, Gen<Part[]>][] = [
    [3, gen.map(gen.pick(FILLERS), (w) => [plain(w)])],
    [5, gen.oneOf(...VENDOR)],
    [1, privateKey(false)],
    [5, gen.map(gen.tuple(context(m.quotes), m.after), ([c, a]) => [...c, ...a])],
    [2, gen.map(LOOKALIKE, (s) => [survives(s)])],
  ];
  if (m.decoys) choices.push([2, gen.map(gen.pick(DECOYS), (s) => [plain("\n"), survives(s), plain("\n")])]);
  const piece = gen.frequency(...choices);
  const last: Gen<Part[]> = m.open
    ? gen.frequency<Part[]>([5, gen.constant([])], [1, gen.map(gen.tuple(gen.pick(m.seps), privateKey(true)), ([s, k]) => [plain(s), ...k])])
    : gen.constant([]);
  return gen.map(gen.tuple(gen.pick(FILLERS), gen.array(gen.tuple(gen.pick(m.seps), piece), { maxLength: 5, avgLength: 2 }), last), ([first, rest, end]) => {
    const parts = [plain(first)];
    for (const [sep, p] of rest) parts.push(plain(sep), ...p);
    parts.push(...end);
    return parts;
  });
}

/** A command line with a secret flag, built around its value. */
const ARGV: readonly ((v: string) => string[])[] = [
  (v) => ["curl", "--api-key", v],
  (v) => ["tool", `--db-password=${v}`],
  (v) => ["x", "-token", v],
  (v) => ["run", "--openai-api-key", v],
  (v) => ["app", "--client-secret", v],
];
/** Where a command line's value goes, when a check builds it with none. */
const HOLE = "\u0001";

const SAFE_KEYS = ["name", "cmd", "output", "args", "items", "meta", "path", "status", "text", "result", "input", "data", "title", "lines"];
const SECRET_KEYS = ["password", "api_key", "apiKey", "accessToken", "db.password", "http.request.header.authorization", "x-api-key", "Authorization", "client_secret"];

/** What a case builds: the value it stands for comes from build(). */
type Node =
  | { t: "text"; parts: Part[] }
  | { t: "atom"; v: number | boolean | null }
  /** The string under a secret-named key. */
  | { t: "keyed"; v: string }
  | { t: "argv"; form: number; v: string }
  | { t: "list"; items: Node[] }
  | { t: "object"; entries: [string, Node][] }
  /** A string that holds the JSON of `node`, indented or not, with a line end or not. */
  | { t: "doc"; node: Node; indent: number; newline: boolean };

const textNode = (m: TextMode): Gen<Node> => gen.map(text(m), (parts): Node => ({ t: "text", parts }));
const ATOM: Gen<Node> = gen.map(gen.oneOf<number | boolean | null>(gen.nat(10_000), gen.bool, gen.constant(null)), (v): Node => ({ t: "atom", v }));
/** Words of q to z and digits (no secret rule reads them), an empty string, or a marker. */
const KEYED: Gen<Node> = gen.map(
  gen.frequency<string>(
    [6, gen.map(gen.array(chars("qrstuvwxyz0123456789", 1, 6), { minLength: 1, maxLength: 4, avgLength: 2 }), (ws) => ws.join(" "))],
    [1, gen.constant("")],
    [1, gen.constant(marker("secret-field"))],
  ),
  (v): Node => ({ t: "keyed", v }),
);
const ARGV_NODE: Gen<Node> = gen.map(gen.tuple(gen.int(0, ARGV.length - 1), mixed(12, 24)), ([form, v]): Node => ({ t: "argv", form, v }));

/** An object with `min` to `max` entries: safe keys with values from `inner`, secret-named keys with KEYED. */
function objectOf(inner: Gen<Node>, min: number, max: number): Gen<Node> {
  const entry = gen.frequency<[string, Node]>([3, gen.tuple(gen.pick(SAFE_KEYS), inner)], [1, gen.tuple(gen.pick(SECRET_KEYS), KEYED)]);
  return gen.map(gen.array(entry, { minLength: min, maxLength: max, avgLength: min + 2 }), (es): Node => {
    const seen = new Set<string>();
    const entries: [string, Node][] = [];
    for (const [k, n] of es) {
      if (seen.has(k)) continue;
      seen.add(k);
      entries.push([k, n]);
    }
    return { t: "object", entries };
  });
}

/** `leaf`, or lists, objects and command lines nested up to `depth` deep. */
function nested(depth: number, leaf: Gen<Node>): Gen<Node> {
  if (depth <= 0) return leaf;
  const inner = nested(depth - 1, leaf);
  return gen.frequency<Node>(
    [5, leaf],
    [1, ARGV_NODE],
    [1, gen.map(gen.array(inner, { maxLength: 3, avgLength: 2 }), (items): Node => ({ t: "list", items }))],
    [2, objectOf(inner, 0, 4)],
  );
}

const DOC_LEAF = gen.frequency<Node>([5, textNode(DOC_MODE)], [1, ATOM]);
const DOC: Gen<Node> = gen.map(
  gen.tuple(
    gen.oneOf<Node>(objectOf(nested(1, DOC_LEAF), 1, 4), gen.map(gen.array(nested(1, DOC_LEAF), { minLength: 1, maxLength: 3 }), (items): Node => ({ t: "list", items }))),
    gen.pick([0, 2]),
    gen.weighted(0.3),
  ),
  ([node, indent, newline]): Node => ({ t: "doc", node, indent, newline }),
);

/** Text, as one string. */
const TEXT = textNode(TEXT_MODE);
/** A value ingest redacts (Redactor.value): objects and arrays up to 3 deep of text, numbers and command lines. */
const VALUE = objectOf(nested(2, gen.frequency<Node>([5, textNode(TEXT_MODE)], [1, ATOM])), 1, 5);
/** A hook payload: values up to 2 deep, with strings that hold a JSON document. */
const PAYLOAD = objectOf(nested(1, gen.frequency<Node>([4, textNode(PAYLOAD_MODE)], [1, ATOM], [3, DOC])), 2, 6);
/** A blob: a payload, or a string that holds a JSON document. */
const BLOB = gen.oneOf(PAYLOAD, DOC);

function build(n: Node): unknown {
  switch (n.t) {
    case "text":
      return joined(n.parts);
    case "atom":
    case "keyed":
      return n.v;
    case "argv":
      return must(ARGV[n.form])(n.v);
    case "list":
      return n.items.map(build);
    case "object": {
      const out: Record<string, unknown> = {};
      for (const [k, x] of n.entries) Object.defineProperty(out, k, { value: build(x), enumerable: true, writable: true, configurable: true });
      return out;
    }
    case "doc":
      return JSON.stringify(build(n.node), null, n.indent) + (n.newline ? "\n" : "");
  }
}

/** The parts a value is made of: its text, keys, command lines and the secrets in them. */
function partsOf(n: Node, into: Part[] = []): Part[] {
  switch (n.t) {
    case "text":
      into.push(...n.parts);
      break;
    case "keyed":
      into.push(n.v === "" || MARKER.test(n.v) ? plain(n.v) : secret("secret-field", n.v));
      break;
    case "argv":
      for (const w of must(ARGV[n.form])(HOLE)) into.push(plain(w.replace(HOLE, "")));
      into.push(secret("secret-flag", n.v));
      break;
    case "list":
      for (const x of n.items) partsOf(x, into);
      break;
    case "object":
      for (const [k, x] of n.entries) {
        into.push(plain(k));
        partsOf(x, into);
      }
      break;
    case "doc":
      partsOf(n.node, into);
      break;
    case "atom":
      break;
  }
  return into;
}

/** The JSON document a string holds, as redactForBlob reads one: an object or an array, once trimmed. */
function parseDoc(s: string): object | undefined {
  const t = s.trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return undefined;
  try {
    const v: unknown = JSON.parse(t);
    return typeof v === "object" && v !== null ? v : undefined;
  } catch {
    return undefined;
  }
}

/** Every string in `v`, and every string in a JSON document one of them holds. */
function stringsIn(v: unknown, into: string[] = []): string[] {
  if (typeof v === "string") {
    into.push(v);
    const doc = parseDoc(v);
    if (doc !== undefined) stringsIn(doc, into);
  } else if (Array.isArray(v)) {
    for (const x of v) stringsIn(x, into);
  } else if (v !== null && typeof v === "object") {
    for (const x of Object.values(v)) stringsIn(x, into);
  }
  return into;
}

/** Types, keys in order and lengths; a string that holds a JSON document stands for the document's shape. */
function shape(v: unknown): unknown {
  if (typeof v === "string") {
    const doc = parseDoc(v);
    return doc === undefined ? "string" : { doc: shape(doc) };
  }
  if (Array.isArray(v)) return { array: v.map(shape) };
  if (v !== null && typeof v === "object") return { object: Object.entries(v).map(([k, x]) => [k, shape(x)]) };
  return v === null ? "null" : typeof v;
}

/** Fails when WINDOW characters in a row of a secret are in an output string and in no other part. */
function noLeak(parts: readonly Part[], outs: readonly string[]): void {
  const seen = new Set<string>();
  for (const o of outs) for (let i = 0; i + WINDOW <= o.length; i++) seen.add(o.slice(i, i + WINDOW));
  let kept: string | undefined;
  for (const p of parts) {
    if (!isSecret(p)) continue;
    for (let i = 0; i + WINDOW <= p.text.length; i++) {
      const w = p.text.slice(i, i + WINDOW);
      if (!seen.has(w)) continue;
      kept ??= parts.filter((q) => !isSecret(q)).map((q) => q.text).join("\u0000");
      if (kept.includes(w)) continue;
      assert.fail(`${JSON.stringify(w)} of the ${p.kind} secret is left in the output: ${JSON.stringify(outs.find((o) => o.includes(w)))}`);
    }
  }
}

function survivors(parts: readonly Part[], outs: readonly string[]): void {
  for (const p of parts) if (p.role === "survives") assert.ok(outs.some((o) => o.includes(p.text)), `the output no longer holds ${JSON.stringify(p.text)}`);
}

/**
 * Checks `out` against the value `n` builds: the same keys in order, types and lengths, and a marker under
 * each secret-named key and for each secret flag's value. With `exact`, each string is what the string rules
 * give for it and a flag's value is the secret-flag marker. Inside a JSON document a string is only a string,
 * and a flag's value is any marker.
 */
function expectLike(r: Redactor, n: Node, out: unknown, exact: boolean, at: string): void {
  switch (n.t) {
    case "text":
      assert.equal(typeof out, "string", `${at} is not a string`);
      if (exact) assert.equal(out, r.string(joined(n.parts)), `${at} is not what the string rules give`);
      return;
    case "atom":
      assert.equal(out, n.v, `${at} changed`);
      return;
    case "keyed":
      assert.equal(out, n.v === "" || MARKER.test(n.v) ? n.v : marker("secret-field"), `${at}, under a secret-named key, does not hold its marker`);
      return;
    case "argv": {
      const want = must(ARGV[n.form])(HOLE);
      assert.ok(Array.isArray(out) && out.length === want.length, `${at} is not a command line of ${want.length}`);
      for (const [i, w] of want.entries()) {
        const o: unknown = out[i];
        const cut = w.indexOf(HOLE);
        if (cut < 0) assert.equal(o, w, `${at}[${i}] changed`);
        else if (exact) assert.equal(o, w.slice(0, cut) + marker("secret-flag"), `${at}[${i}] does not hold the secret-flag marker`);
        else assert.ok(typeof o === "string" && o.startsWith(w.slice(0, cut)) && MARKER.test(o.slice(cut)), `${at}[${i}] does not hold a marker: ${JSON.stringify(o)}`);
      }
      return;
    }
    case "list":
      assert.ok(Array.isArray(out) && out.length === n.items.length, `${at} is not a list of ${n.items.length}`);
      for (const [i, x] of n.items.entries()) expectLike(r, x, out[i], exact, `${at}[${i}]`);
      return;
    case "object": {
      assert.ok(out !== null && typeof out === "object" && !Array.isArray(out), `${at} is not an object`);
      const got = new Map(Object.entries(out));
      assert.deepEqual([...got.keys()], n.entries.map(([k]) => k), `${at} changed its keys`);
      for (const [k, x] of n.entries) expectLike(r, x, got.get(k), exact, `${at}.${k}`);
      return;
    }
    case "doc": {
      const doc = typeof out === "string" ? parseDoc(out) : undefined;
      assert.ok(doc !== undefined, `${at} no longer holds a JSON document: ${JSON.stringify(out)}`);
      expectLike(r, n.node, doc, false, `${at}{}`);
      return;
    }
  }
}

/** Redactor.string on text. */
function checkText(r: Redactor, n: Node): void {
  const parts = partsOf(n);
  const input = joined(parts);
  const out = r.string(input);
  noLeak(parts, [out]);
  assert.equal(r.string(out), out, "redacting the output again changed it");
  survivors(parts, [out]);
  if (!parts.some(isSecret)) assert.equal(out, input, "text with no secret changed");
}

/** Redactor.value, as ingest redacts an event's payload. */
function checkValue(r: Redactor, n: Node): void {
  const input = build(n);
  const before = structuredClone(input);
  const out = r.value(input);
  assert.deepEqual(input, before, "redaction changed its input");
  const parts = partsOf(n);
  const outs = stringsIn(out);
  noLeak(parts, outs);
  expectLike(r, n, out, true, "value");
  survivors(parts, outs);
  assert.deepEqual(r.value(out), out, "redacting the output again changed it");
  if (!parts.some(isSecret)) assert.deepEqual(out, input, "a value with no secret changed");
}

/** redactPayload, as the hook redacts a payload before it reaches the spool. */
function checkPayload(r: Redactor, n: Node): void {
  const input = build(n);
  const before = structuredClone(input);
  const out = redactPayload(r, input, redactionTally());
  assert.deepEqual(input, before, "redaction changed its input");
  const parts = partsOf(n);
  const outs = stringsIn(out);
  noLeak(parts, outs);
  assert.deepEqual(shape(out), shape(input), "the payload's shape changed");
  expectLike(r, n, out, true, "payload");
  survivors(parts, outs);
  assert.deepEqual(r.value(out), out, "ingest's pass changed the hook's output");
  assert.deepEqual(redactPayload(r, out, redactionTally()), out, "the hook's pass changed its own output");
  if (!parts.some(isSecret)) assert.deepEqual(out, input, "a payload with no secret changed");
}

/** redactBlobValue, as a blob's text is written. */
function checkBlob(r: Redactor, n: Node): void {
  const input = build(n);
  const text = redactBlobValue(r, input, redactionTally());
  const back = parseDoc(text);
  assert.ok(back !== undefined, `the blob's text does not parse: ${JSON.stringify(text.slice(0, 200))}`);
  const from = typeof input === "string" ? parseDoc(input) : input;
  assert.deepEqual(shape(back), shape(from), "the blob's shape changed");
  const parts = partsOf(n);
  noLeak(parts, [text, ...stringsIn(back)]);
  expectLike(r, n.t === "doc" ? n.node : n, back, false, "blob");
  survivors(parts, [text]);
  assert.equal(r.string(text), text, "redacting the blob's text again changed it");
  assert.equal(redactBlobValue(r, typeof input === "string" ? text : back, redactionTally()), text, "the blob's text redacted again as a blob changed");
  if (!parts.some(isSecret)) assert.equal(text, typeof input === "string" ? input : JSON.stringify(input), "a blob with no secret changed");
}

/** What a property's cases held. */
class Seen {
  cases = 0;
  secrets = 0;
  survivors = 0;
  kinds = new Set<string>();

  note(n: Node): void {
    this.cases++;
    for (const p of partsOf(n)) {
      if (p.role === "survives") this.survivors++;
      if (!isSecret(p)) continue;
      this.secrets++;
      if (p.kind) this.kinds.add(p.kind);
    }
  }

  toString(): string {
    return `${this.cases} cases: ${this.secrets} secrets in ${this.kinds.size} formats, ${this.survivors} hashes, ids and decoys`;
  }
}

async function property(t: { diagnostic(s: string): void }, g: Gen<Node>, check: (r: Redactor, n: Node) => void, label: string): Promise<void> {
  const r = createRedactor();
  const seen = new Seen();
  await forAll(
    g,
    (n) => {
      seen.note(n);
      check(r, n);
    },
    { runs: RUNS, label },
  );
  t.diagnostic(String(seen));
}

test("the cases cover every secret rule, and their secret-named keys and flags are ones the walk redacts", () => {
  for (const k of SECRET_KEYS) assert.ok(isSecretAttrKey(k), `${k} is not a secret-named key`);
  for (const k of SAFE_KEYS) assert.ok(!isSecretAttrKey(k), `${k} is a secret-named key`);
  const r = createRedactor();
  for (const form of ARGV) assert.deepEqual(r.value(form("Ab3dEf6hIj9k")), form(marker("secret-flag")));
  const kinds = new Set<string>();
  for (const n of sample(TEXT, 300, 1)) for (const p of partsOf(n)) if (p.kind) kinds.add(p.kind);
  assert.deepEqual([...kinds].sort(), [...new Set(r.rules.map((x) => x.kind))].sort());
});

test("text: no secret is left, the rest is kept, and a second pass changes nothing", async (t) => {
  await property(t, TEXT, checkText, "text");
});

test("a value ingest redacts keeps its shape, and secret-named keys and flags hold a marker", async (t) => {
  await property(t, VALUE, checkValue, "value");
});

test("a hook payload keeps its JSON documents whole, and ingest's pass over it changes nothing", async (t) => {
  await property(t, PAYLOAD, checkPayload, "payload");
});

test("a blob's text parses to the shape it came from, and no secret is left in it", async (t) => {
  await property(t, BLOB, checkBlob, "blob");
});

test("each check fails on a redactor with a secret rule taken out or a pattern that breaks it", async (t) => {
  const without = (kind: string): Redactor => {
    const r = createRedactor();
    const rules = r.rules as RedactRule[];
    const at = rules.findIndex((x) => x.kind === kind);
    assert.ok(at >= 0, `no ${kind} rule`);
    rules.splice(at, 1);
    return r;
  };
  const mutants: [string, Redactor, Gen<Node>, (r: Redactor, n: Node) => void, RegExp][] = [
    ["text, no github-token rule", without("github-token"), TEXT, checkText, /the github-token secret is left/],
    ["value, no secret-assignment rule", without("secret-assignment"), VALUE, checkValue, /the secret-assignment secret is left/],
    ["payload, no private-key rule", without("private-key"), PAYLOAD, checkPayload, /the private-key secret is left/],
    ["blob, no bearer rule", without("bearer"), BLOB, checkBlob, /the bearer secret is left/],
    ["text, a pattern for ]", createRedactor({ patterns: ["\\]"] }), TEXT, checkText, /again changed it/],
    ['blob, a pattern for "', createRedactor({ patterns: ['"'] }), BLOB, checkBlob, /does not parse/],
    ["text, a pattern for 40 hex digits", createRedactor({ patterns: ["[0-9a-f]{40}"] }), TEXT, checkText, /no longer holds/],
  ];
  for (const [label, r, g, check, why] of mutants) {
    const f = await failure(g, (n) => check(r, n), { env: {}, runs: 300, label });
    assert.match(f.cause instanceof Error ? f.cause.message : String(f.cause), why, label);
    t.diagnostic(`${label}: failed on case ${f.caseIndex + 1}`);
  }
});

/** The PropertyFailure forAll throws; fails when it throws none. */
async function failure(g: Gen<Node>, prop: (n: Node) => void, opts: ForAllOptions): Promise<PropertyFailure> {
  try {
    await forAll(g, prop, opts);
  } catch (e) {
    if (e instanceof PropertyFailure) return e;
    throw e;
  }
  assert.fail(`${opts.label ?? "the property"} passed`);
}

function must<T>(v: T | undefined): T {
  assert.ok(v !== undefined);
  return v;
}
