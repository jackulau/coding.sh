// The env rule (core/redact.ts envRules: capture.redact "env"), checked on generated environments.
// Each variable has a name of one of three sorts: secret-looking (KEY, TOKEN, SECRET, PASSW, PWD,
// CREDENTIAL, AUTH, COOKIE or SESSION in it, with a prefix or a suffix), a place (PWD, OLDPWD,
// SESSION_MANAGER, or a secret word before _PATH, _DIR, _FILE or _SOCK), or plain (HOME, LANG, ...),
// each letter in either case. Its value is random text of 1 to 32 characters, most often 6 to 10 and
// with regex metacharacters, or a path in a folder the test makes: the folder, a file in it, or a
// name in it that does not exist. The text holds the values and filler words, joined by ", ", "; ",
// " | ", " and " or a line end.
//
// The property: a value becomes [redacted:env] when a secret-looking name holds it, it has 8
// characters or more, and it is not a file or folder that exists; the rest comes out as it went in.
// The last test shows the property fails on a redactor built from no variables, from every value
// under a secret name, without the values of 8 characters, or with a rule for the folder.
// CODING_SH_PROP_RUNS=n runs n cases per test (default 100); CODING_SH_PROP_SEED=s replays one. The last
// test reads neither.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createRedactor, marker, type Redactor, type RedactRule } from "../../src/core/redact.ts";
import { assume, forAll, gen, PropertyFailure, type ForAllOptions, type Gen } from "../_prop.ts";

const RUNS = 100;
const MARK = marker("env");

const dir = mkdtempSync(join(tmpdir(), "redact-env-"));
const file = join(dir, "notes.txt");
writeFileSync(file, "");
after(() => rmSync(dir, { recursive: true, force: true }));

type Sort = "secret" | "place" | "plain";

interface Variable {
  name: string;
  value: string;
  sort: Sort;
  /** The value names a file or folder that exists. */
  exists: boolean;
}

interface EnvCase {
  /** The variables in the environment: the first of each name. */
  vars: Variable[];
  /** The text, piece by piece: values, filler words and the separators between them. */
  pieces: string[];
}

/** `s` with each letter in upper or lower case. */
const anyCase = (s: string): Gen<string> =>
  gen.map(gen.array(gen.bool, { minLength: s.length, maxLength: s.length }), (up) => [...s].map((c, i) => (up[i] ? c.toUpperCase() : c.toLowerCase())).join(""));

const SECRET_WORDS = ["KEY", "API_KEY", "TOKEN", "SECRET", "PASSWORD", "PASSWD", "PWD", "CREDENTIALS", "AUTH", "COOKIE", "SESSION"];
const joined = (parts: readonly Gen<string>[]): Gen<string> => gen.map(gen.tuple(...parts), (p) => p.join(""));

/** A secret-looking name. PWD alone is the working directory, a place. */
const SECRET_NAME: Gen<string> = gen.chain(
  gen.filter(joined([gen.pick(["", "GITHUB_", "DB_", "APP_", "X"]), gen.pick(SECRET_WORDS), gen.pick(["", "_V2", "_PROD", "S", "_ID", "_VALUE"])]), (n) => n !== "PWD"),
  anyCase,
);

/** A name that holds a place: the working directory, the X session manager's socket, a path, a folder, a file or a socket. */
const PLACE_NAME: Gen<string> = gen.chain(
  gen.oneOf(gen.pick(["PWD", "OLDPWD", "SESSION_MANAGER"]), joined([gen.pick(["", "SSH_", "APP_"]), gen.pick(SECRET_WORDS), gen.pick(["_PATH", "_DIR", "_FILE", "_SOCK"])])),
  anyCase,
);

const PLAIN_NAME: Gen<string> = gen.chain(gen.pick(["HOME", "LANG", "EDITOR", "TERM", "USER", "SHELL", "NODE_ENV", "TZ", "HOSTNAME", "GOPATH", "DISPLAY", "PAGER"]), anyCase);

/** Value characters: no space, comma, semicolon, colon or slash, so random text never reads as a path or holds a separator. */
const VALUE_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz._-+*?^$=@#%&!~()[]{}|\\";
const TEXT_VALUE: Gen<string> = gen.chain(gen.frequency([4, gen.int(6, 10)], [1, gen.int(1, 32)]), (n) => gen.string({ alphabet: VALUE_CHARS, minLength: n, maxLength: n }));
const PATHS: readonly (readonly [path: string, exists: boolean])[] = [
  [dir, true],
  [file, true],
  [join(dir, "missing"), false],
];
const VALUE: Gen<readonly [string, boolean]> = gen.frequency<readonly [string, boolean]>([6, gen.map(TEXT_VALUE, (v) => [v, false] as const)], [1, gen.pick(PATHS)]);

const NAMES: Readonly<Record<Sort, Gen<string>>> = { secret: SECRET_NAME, place: PLACE_NAME, plain: PLAIN_NAME };
const VARIABLE: Gen<Variable> = gen.chain(gen.frequency<Sort>([3, gen.constant("secret")], [1, gen.constant("place")], [1, gen.constant("plain")]), (sort) =>
  gen.map(gen.tuple(NAMES[sort], VALUE), ([name, [value, exists]]) => ({ name, value, sort, exists })),
);

const FILLERS = ["alpha", "build", "cache", "delta", "event", "field", "graph", "hello", "index", "merge", "order", "query", "route", "stage", "table", "vector"];
const SEPS = [", ", "; ", "\n", " | ", " and "];

const CASE: Gen<EnvCase> = gen.map(
  gen.array(gen.tuple(gen.frequency<Variable | string>([3, VARIABLE], [1, gen.pick(FILLERS)]), gen.pick(SEPS)), { minLength: 1, maxLength: 8 }),
  (slots) => {
    const vars: Variable[] = [];
    const pieces: string[] = [];
    for (const [i, [slot, sep]] of slots.entries()) {
      if (i) pieces.push(sep);
      pieces.push(typeof slot === "string" ? slot : slot.value);
      if (typeof slot !== "string" && !vars.some((v) => v.name === slot.name)) vars.push(slot);
    }
    return { vars, pieces };
  },
);

const envOf = (vars: readonly Variable[]): Record<string, string> => Object.fromEntries(vars.map((v) => [v.name, v.value]));

/** The values the rule replaces: under a secret-looking name, 8 characters or more, and not a file or folder that exists. */
const secretValues = (vars: readonly Variable[]): Set<string> => new Set(vars.filter((v) => v.sort === "secret" && v.value.length >= 8 && !v.exists).map((v) => v.value));

/** Fails unless `r` turns each secret value of `c` into the marker and leaves the rest of the text as it is. */
function expectEnv(c: EnvCase, r: Redactor): void {
  const secret = secretValues(c.vars);
  // A secret value inside text that is kept is replaced there too, which this check does not expect.
  assume(c.pieces.every((p) => secret.has(p) || ![...secret].some((s) => p.includes(s))));
  const out = r.string(c.pieces.join(""));
  let at = 0;
  for (const p of c.pieces) {
    const want = secret.has(p) ? MARK : p;
    if (!out.startsWith(want, at)) assert.fail(`${secret.has(p) ? `the value ${JSON.stringify(p)} is not redacted` : `${JSON.stringify(p)} is not kept`}: ${JSON.stringify(out)}`);
    at += want.length;
  }
  assert.equal(at, out.length, `the output is longer than the text with its values redacted: ${JSON.stringify(out)}`);
}

const redactor = (vars: readonly Variable[]): Redactor => createRedactor({ redact: ["env"], env: envOf(vars) });

test("a value under a secret-looking name, of 8 characters or more and not a path that exists, is redacted; the rest comes out as it went in", async (t) => {
  const seen = { redacted: 0, short: 0, place: 0, plain: 0, exists: 0 };
  await forAll(
    CASE,
    (c) => {
      expectEnv(c, redactor(c.vars));
      for (const v of c.vars) {
        if (v.sort !== "secret") seen[v.sort]++;
        else if (v.exists) seen.exists++;
        else if (v.value.length < 8) seen.short++;
        else seen.redacted++;
      }
    },
    { runs: RUNS, label: "env" },
  );
  t.diagnostic(`${seen.redacted} values redacted; kept: ${seen.short} short, ${seen.place} under a place name, ${seen.plain} under a plain name, ${seen.exists} paths that exist`);
});

test("the property fails on a redactor built from no variables, every value under a secret name, without the 8-character values, or with a rule for the folder", async (t) => {
  const folderRule = (vars: readonly Variable[]): Redactor => {
    const r = redactor(vars);
    (r.rules as RedactRule[]).push({ kind: "env", pattern: new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g") });
    return r;
  };
  const mutants: [string, (vars: readonly Variable[]) => Redactor, RegExp][] = [
    ["no variables", () => redactor([]), /is not redacted/],
    ["every value under a secret name", (vars) => redactor(vars.map((v, i) => ({ ...v, name: `SECRET_${i}` }))), /is not kept/],
    ["without the 8-character values", (vars) => redactor(vars.filter((v) => v.value.length !== 8)), /is not redacted/],
    ["a rule for the folder", folderRule, /is not kept/],
  ];
  for (const [label, make, why] of mutants) {
    const f = await failure(CASE, (c) => expectEnv(c, make(c.vars)), { env: {}, runs: 300, label });
    assert.match(f.cause instanceof Error ? f.cause.message : String(f.cause), why, label);
    t.diagnostic(`${label}: failed on case ${f.caseIndex + 1}`);
  }
});

/** The PropertyFailure forAll throws; fails when it throws none. */
async function failure<T>(g: Gen<T>, prop: (v: T) => void, opts: ForAllOptions): Promise<PropertyFailure> {
  try {
    await forAll(g, prop, opts);
  } catch (e) {
    if (e instanceof PropertyFailure) return e;
    throw e;
  }
  assert.fail(`${opts.label ?? "the property"} passed`);
}
