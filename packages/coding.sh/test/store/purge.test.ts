// coding.sh purge --literal: a secret in a payload, a tool command, a title, a label,
// a blob, a saved fold and the spool ends with no copy anywhere on disk; the index
// stays intact, search still works and every blob still matches its hash.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, test } from "node:test";
import { parseLiterals } from "../../src/cli/commands/purge.ts";
import { FsBlobStore } from "../../src/store/fs-blobs.ts";
import { closeBlobs, fsBlobs } from "./_blobs.ts";
import { PURGE_MARKER, purgeLiterals, Scrubber } from "../../src/store/purge.ts";
import { SqliteIndexStore } from "../../src/store/sqlite.ts";
import { FIXTURES, tmpEnv, type TmpEnv } from "../adapters/_helpers.ts";
import { cli, event, ok, seed, session } from "../query/_seed.ts";

// Neither matches a redaction rule: the case purge exists for is a value the redactor missed.
const SECRET = "hunter2-correct-horse-battery-staple";
const QUOTED = 'pa"ss\\word-7781'; // JSON-escaped in stored text: pa\"ss\\\\word-7781

/** Every regular file under `dir`. */
function files(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...files(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

const forms = (s: string): string[] => [s, JSON.stringify(s).slice(1, -1)];
const holds = (buf: Buffer, s: string): boolean => forms(s).some((f) => buf.includes(Buffer.from(f)));

async function seedStore(env: TmpEnv): Promise<{ blobRef: string; cleanRef: string; spoolFile: string; spoolSize: number }> {
  const blobs = fsBlobs(join(env.dataHome, "blobs"));
  const blobRef = await blobs.put(`$ env\nAPI_TOKEN=${SECRET}\nPATH=/usr/bin\n`);
  const cleanRef = await blobs.put("nothing to see here");
  await seed(env.dataHome, {
    sessions: [session("s1", { title: `deploy with ${SECRET}` }), session("s2")],
    events: [
      event("s1", 1, { payload: { text: `my token is ${SECRET} keep it safe` } }),
      event("s1", 2, { kind: "tool.start", payload: { tool: "Bash", input: { command: `curl -H 'Authorization: ${SECRET}' https://x` } } }),
      event("s1", 3, { kind: "tool.end", payload: { tool: "Bash", ok: true, outputRef: blobRef }, blobs: [blobRef] } as never),
      event("s1", 4, { payload: { text: `the password is ${QUOTED}` } }),
      event("s2", 1, { payload: { text: "hello unrelated" } }),
      event("s2", 2, { kind: "tool.end", payload: { tool: "Read", ok: true, outputRef: cleanRef }, blobs: [cleanRef] } as never),
    ],
    labels: [{ id: "l1", sessionId: "s1", criterion: "safe", value: "fail", note: `leaked ${SECRET}`, by: "me", ts: 1 } as never],
  });
  const store = await SqliteIndexStore.open(join(env.dataHome, "index.db"));
  await store.close();
  const db = new DatabaseSync(join(env.dataHome, "index.db"));
  db.prepare("INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, 1)").run("fold:s1", "opaque fold bytes");
  db.prepare("INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, 1)").run("other:x", JSON.stringify({ seen: SECRET }));
  db.close();
  const spoolDir = join(env.dataHome, "spool", "claude-code");
  mkdirSync(spoolDir, { recursive: true });
  const spoolFile = join(spoolDir, "2026-11-01.jsonl");
  writeFileSync(spoolFile, JSON.stringify({ prompt: `use ${SECRET}`, q: QUOTED }) + "\n" + JSON.stringify({ prompt: "fine" }) + "\n");
  return { blobRef, cleanRef, spoolFile, spoolSize: statSync(spoolFile).size };
}

describe("coding.sh purge --literal", () => {
  let env: TmpEnv;
  let seeded: Awaited<ReturnType<typeof seedStore>>;
  let secrets = "";

  before(async () => {
    env = tmpEnv();
    seeded = await seedStore(env);
    secrets = join(env.root, "leaked.txt");
    writeFileSync(secrets, `${SECRET}\r\n\n${QUOTED}\n`);
  });
  after(async () => {
    await closeBlobs();
    env.restore();
  });

  test("--dry-run counts every copy and changes nothing", () => {
    const before = readFileSync(join(env.dataHome, "index.db"));
    const r = ok(["purge", "--literal", secrets, "--dry-run", "--json"]);
    const j = JSON.parse(r.stdout);
    assert.equal(j.outcome, "planned");
    assert.equal(j.values, 2);
    assert.equal(j.events, 3);
    assert.equal(j.sessions, 1);
    assert.equal(j.otherRows, 2); // the label and the other:x kv row
    assert.equal(j.blobs, 1);
    assert.equal(j.files, 1);
    assert.equal(j.foldsDropped, 1);
    assert.ok(!r.stdout.includes(SECRET) && !r.stderr.includes(SECRET));
    assert.ok(holds(readFileSync(join(env.dataHome, "index.db")), SECRET) || holds(before, SECRET));
    assert.ok(holds(readFileSync(seeded.spoolFile), SECRET));
  });

  test("the purge leaves no copy in the index, its WAL, the blobs or the spool", async () => {
    const r = ok(["purge", "--literal", secrets]);
    assert.match(r.stderr, /Integrity\s+index and search ok/);
    assert.ok(!r.stdout.includes(SECRET) && !r.stderr.includes(SECRET));
    assert.match(r.stderr, /Rotate the secret/);

    for (const f of files(env.dataHome).filter((f) => !f.includes(`${join("", "blobs")}`))) {
      const buf = readFileSync(f);
      assert.ok(!holds(buf, SECRET), `${f} still holds the secret`);
      assert.ok(!holds(buf, QUOTED), `${f} still holds the quoted secret`);
    }
    const blobs = fsBlobs(join(env.dataHome, "blobs"));
    let n = 0;
    for await (const ref of blobs.list()) {
      const data = Buffer.from((await blobs.get(ref))!);
      assert.equal(createHash("sha256").update(data).digest("hex"), ref, "blob matches its hash");
      assert.ok(!holds(data, SECRET));
      n++;
    }
    assert.equal(n, 2);
    assert.equal(await blobs.get(seeded.blobRef), undefined, "the old blob is gone");
    assert.ok(await blobs.get(seeded.cleanRef), "an untouched blob stays");
  });

  test("rows read back scrubbed, refs follow the rewritten blob, the spool keeps its length", async () => {
    const db = new DatabaseSync(join(env.dataHome, "index.db"), { readOnly: true });
    try {
      assert.equal((db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check, "ok");
      const title = (db.prepare("SELECT title FROM sessions WHERE id = 's1'").get() as { title: string }).title;
      assert.equal(title, `deploy with ${PURGE_MARKER}`);
      const msg = JSON.parse((db.prepare("SELECT payload FROM events WHERE id = 's1-e1'").get() as { payload: string }).payload);
      assert.equal(msg.text, `my token is ${PURGE_MARKER} keep it safe`);
      const quoted = JSON.parse((db.prepare("SELECT payload FROM events WHERE id = 's1-e4'").get() as { payload: string }).payload);
      assert.equal(quoted.text, `the password is ${PURGE_MARKER}`);
      const end = db.prepare("SELECT payload, blobs FROM events WHERE id = 's1-e3'").get() as { payload: string; blobs: string };
      const ref = JSON.parse(end.payload).outputRef as string;
      assert.notEqual(ref, seeded.blobRef);
      assert.deepEqual(JSON.parse(end.blobs), [ref]);
      const text = await fsBlobs(join(env.dataHome, "blobs")).getText(ref);
      assert.equal(text, `$ env\nAPI_TOKEN=${PURGE_MARKER}\nPATH=/usr/bin\n`);
      assert.equal(db.prepare("SELECT 1 FROM kv WHERE key = 'fold:s1'").get(), undefined, "the saved fold is dropped");
      assert.equal((db.prepare("SELECT note FROM labels WHERE id = 'l1'").get() as { note: string }).note, `leaked ${PURGE_MARKER}`);
    } finally {
      db.close();
    }
    const spool = readFileSync(seeded.spoolFile, "utf8");
    assert.equal(Buffer.byteLength(spool), seeded.spoolSize);
    const [first, second] = spool.trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(first.prompt, `use ${"*".repeat(SECRET.length)}`);
    assert.equal(second.prompt, "fine");
  });

  test("search still works, and finds nothing for the purged value", () => {
    const hits = (q: string) => JSON.parse(ok(["search", q, "--json"]).stdout) as unknown[] | { results?: unknown[]; hits?: unknown[] };
    const count = (v: ReturnType<typeof hits>) => (Array.isArray(v) ? v.length : (v.results ?? v.hits ?? []).length);
    assert.equal(count(hits("hunter2")), 0);
    assert.ok(count(hits("unrelated")) >= 1);
    assert.ok(count(hits("keep it safe")) >= 1, "the scrubbed message is still indexed");
  });

  test("a second purge finds nothing", () => {
    const j = JSON.parse(ok(["purge", "--literal", secrets, "--dry-run", "--json"]).stdout);
    assert.deepEqual([j.events, j.sessions, j.otherRows, j.blobs, j.files], [0, 0, 0, 0, 0]);
  });
});

describe("purge input and store checks", () => {
  let env: TmpEnv;
  before(async () => {
    env = tmpEnv();
    await seed(env.dataHome, { sessions: [session("s1")] });
  });
  after(async () => {
    await closeBlobs();
    env.restore();
  });

  test("reads stdin with --literal -", () => {
    const j = JSON.parse(ok(["purge", "--literal", "-", "--dry-run", "--json"], {}, `${SECRET}\n`).stdout);
    assert.equal(j.values, 1);
    assert.equal(j.events, 0);
  });

  test("never echoes a value typed on the command line", () => {
    // A secret pasted as an argument, as a flag value, as an unknown option or into --literal by mistake.
    const tries = [["purge", SECRET], ["purge", "--dry-run", SECRET], ["purge", `--${SECRET}`], ["purge", `--dry-run=${SECRET}`], ["purge", "--literal", SECRET], ["purge", "--literal", `./${SECRET}`]];
    for (const args of tries) {
      for (const json of [false, true]) {
        const r = cli(json ? [...args, "--json"] : args);
        assert.equal(r.status, 2, args.join(" "));
        assert.ok(!r.stderr.includes(SECRET) && !r.stdout.includes(SECRET), `${args.join(" ")} echoed the value: ${r.stderr}`);
        assert.ok(!r.stderr.includes(SECRET.slice(0, 12)), args.join(" "));
      }
    }
    assert.match(cli(["purge", SECRET]).stderr, /Unexpected argument \(value not shown\)/);
    assert.match(cli(["purge", "--literal", SECRET]).stderr, /no such file/);
    // Other commands still name the stray argument, which is what a typo needs.
    assert.match(cli(["status", "extra-arg"]).stderr, /"extra-arg"/);
  });

  test("refuses values on the command line, short values and a missing file", () => {
    assert.equal(cli(["purge", SECRET]).status, 2);
    assert.equal(cli(["purge"]).status, 2);
    const short = cli(["purge", "--literal", "-"], {}, "abc123\n");
    assert.equal(short.status, 2);
    assert.match(short.stderr, /shorter than 8/);
    assert.equal(cli(["purge", "--literal", join(env.root, "nope.txt")]).status, 2);
    assert.equal(cli(["purge", "--literal", "-"], {}, "\n\n").status, 2);
  });

  test("a non-SQLite store gets a clear error without its credentials", () => {
    const r = cli(["purge", "--literal", "-"], { CODING_SH_STORE_URL: "postgres://admin:s3cretpw@db.example/csh" }, `${SECRET}\n`);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /rewrites the SQLite index/);
    assert.ok(!r.stderr.includes("s3cretpw"));
  });
});

describe("Scrubber", () => {
  test("replaces raw and JSON-escaped forms, longest value first", () => {
    const s = new Scrubber(["abcdefgh", "abcdefgh-longer"]);
    assert.equal(s.text("x abcdefgh-longer y abcdefgh"), `x ${PURGE_MARKER} y ${PURGE_MARKER}`);
    assert.deepEqual(s.value({ k: ["abcdefgh"], abcdefgh: 1 }), { k: [PURGE_MARKER], [PURGE_MARKER]: 1 });
    const q = new Scrubber([QUOTED]);
    assert.equal(q.json(JSON.stringify({ a: `x${QUOTED}` })), JSON.stringify({ a: `x${PURGE_MARKER}` }));
    assert.ok(q.hit(JSON.stringify(QUOTED)));
  });

  test("masks the same number of bytes, skipping an escaped look-alike", () => {
    const s = new Scrubber(["nabcdefgh"]);
    const line = Buffer.from(JSON.stringify({ a: "\nabcdefgh", b: "nabcdefgh" }));
    const ranges = s.maskRanges(line);
    assert.equal(ranges.length, 1, "the \\n-prefixed text is a newline plus abcdefgh, not the value");
    assert.equal(line.toString("latin1").slice(ranges[0]!.start, ranges[0]!.start + ranges[0]!.length), "nabcdefgh");
  });

  test("blob bytes are rewritten only when they hold a value", () => {
    const s = new Scrubber([SECRET]);
    assert.equal(s.bytes(Buffer.from("clean")), undefined);
    assert.equal(Buffer.from(s.bytes(Buffer.from(`a ${SECRET} é`))!).toString("utf8"), `a ${PURGE_MARKER} é`);
  });

  test("parseLiterals keeps inner spaces, drops blank lines and CR", () => {
    assert.deepEqual(parseLiterals("a b c d e\r\n\n  \nxyz12345\na b c d e\n"), ["a b c d e", "xyz12345"]);
  });

  test("purgeLiterals refuses a short value", async () => {
    await assert.rejects(purgeLiterals({ dbPath: ":memory:", blobs: new FsBlobStore(join(process.cwd(), "no-such-dir")), literals: ["short"] }), /shorter than 8/);
  });
});

describe("coding.sh purge --rule and eval run dirs", () => {
  // Two tokens of one shape, a short value the rule also matches, and an eval run dir holding them.
  const TOKEN_A = "zz-live-Q7d9KfL2mN4pR8sT";
  const TOKEN_B = "zz-live-W3xY6zA1bC5dE9fG";
  const RULE = "zz-live-[A-Za-z0-9]{16}|k-[0-9]{3}";
  let env: TmpEnv;
  let runFile = "";
  let gitFile = "";

  before(async () => {
    env = tmpEnv();
    const blobs = fsBlobs(join(env.dataHome, "blobs"));
    const blobRef = await blobs.put(`export TOKEN=${TOKEN_B}\n`);
    await seed(env.dataHome, {
      sessions: [session("s1", { title: `rotate ${TOKEN_A}` }), session("s2")],
      events: [
        event("s1", 1, { payload: { text: `token ${TOKEN_A} and a short k-123 one` } }),
        event("s1", 2, { kind: "tool.end", payload: { tool: "Bash", ok: true, outputRef: blobRef }, blobs: [blobRef] } as never),
        event("s2", 1, { payload: { text: "nothing here" } }),
      ],
    });
    // An eval run kept on disk: the agent's transcript under its HOME, and a git object in its work tree.
    const projects = join(env.dataHome, "runs", "run_01", "home", ".claude", "projects", "work");
    mkdirSync(projects, { recursive: true });
    runFile = join(projects, "t.jsonl");
    writeFileSync(runFile, JSON.stringify({ type: "user", text: `use ${TOKEN_B} and ${SECRET}` }) + "\n");
    const objects = join(env.dataHome, "runs", "run_01", "work", ".git", "objects");
    mkdirSync(objects, { recursive: true });
    gitFile = join(objects, "ab");
    writeFileSync(gitFile, `raw ${TOKEN_A}`);
  });
  after(async () => {
    await closeBlobs();
    env.restore();
  });

  test("--literal also masks eval run files, same length, and leaves .git alone", () => {
    const secrets = join(env.root, "one.txt");
    writeFileSync(secrets, `${SECRET}\n`);
    const size = statSync(runFile).size;
    const j = JSON.parse(ok(["purge", "--literal", secrets, "--json"]).stdout);
    assert.equal(j.files, 1);
    assert.equal(statSync(runFile).size, size);
    assert.ok(!readFileSync(runFile, "utf8").includes(SECRET));
    assert.ok(readFileSync(runFile, "utf8").includes(TOKEN_B), "only the given value goes");
  });

  test("--rule --dry-run counts the distinct matches and never prints them", () => {
    const r = ok(["purge", "--rule", RULE, "--dry-run", "--json"]);
    const j = JSON.parse(r.stdout);
    assert.equal(j.outcome, "planned");
    assert.equal(j.ruleMatches, 2);
    assert.equal(j.shortMatches, 1, "k-123 is under 8 characters and left alone");
    assert.equal(j.events, 1);
    assert.equal(j.sessions, 1);
    assert.equal(j.blobs, 1);
    assert.equal(j.files, 1);
    for (const t of [TOKEN_A, TOKEN_B]) assert.ok(!r.stdout.includes(t) && !r.stderr.includes(t));
    const text = ok(["purge", "--rule", RULE, "--dry-run"]);
    assert.match(text.stderr, /Rules\s+matched 2 distinct values/);
    assert.ok(!text.stderr.includes(TOKEN_A) && !text.stderr.includes(TOKEN_B));
  });

  test("--rule removes every match from rows, blobs and run files", () => {
    ok(["purge", "--rule", RULE]);
    for (const f of files(env.dataHome).filter((f) => f !== gitFile)) {
      const buf = readFileSync(f);
      assert.ok(!holds(buf, TOKEN_A) && !holds(buf, TOKEN_B), `${f} still holds a token`);
    }
    assert.ok(readFileSync(gitFile, "utf8").includes(TOKEN_A), "a .git object is not rewritten");
    const db = new DatabaseSync(join(env.dataHome, "index.db"), { readOnly: true });
    try {
      const msg = JSON.parse((db.prepare("SELECT payload FROM events WHERE id = 's1-e1'").get() as { payload: string }).payload);
      assert.equal(msg.text, `token ${PURGE_MARKER} and a short k-123 one`);
    } finally {
      db.close();
    }
    const again = JSON.parse(ok(["purge", "--rule", RULE, "--dry-run", "--json"]).stdout);
    assert.equal(again.ruleMatches, 0);
    assert.equal(again.values, 0);
  });

  test("a bad or empty-matching rule is refused without echoing it", () => {
    const bad = cli(["purge", "--rule", `(${TOKEN_A}`]);
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /not a valid regular expression/);
    assert.ok(!bad.stderr.includes(TOKEN_A));
    const empty = cli(["purge", "--rule", `(${TOKEN_A})?`]);
    assert.equal(empty.status, 2);
    assert.match(empty.stderr, /matches empty text/);
    assert.ok(!empty.stderr.includes(TOKEN_A));
    assert.match(cli(["purge", "--rule", "zz-[a-z]{8}", "--rule", "-("]).stderr, /--rule 2 is not a valid/);
  });

  test("a rule matching over 10,000 distinct values is refused", () => {
    const db = new DatabaseSync(join(env.dataHome, "index.db"));
    const put = db.prepare("INSERT INTO kv (key, value, updated_at) VALUES (?, ?, 1)");
    db.exec("BEGIN");
    for (let i = 0; i < 10_001; i++) put.run(`many:${i}`, JSON.stringify({ v: `word-${String(i).padStart(6, "0")}` }));
    db.exec("COMMIT");
    db.close();
    const r = cli(["purge", "--rule", "word-[0-9]{6}", "--dry-run", "--json"]);
    assert.equal(r.status, 1);
    assert.equal(JSON.parse(r.stderr.trim().split("\n").pop()!).reason, "too_broad");
  });
});

// Every real store holds events with no text (session starts, model calls), which
// the external-content search index never indexes. FTS5's own check against the
// content table counts them as missing, so purge reported every store damaged.
describe("coding.sh purge on a store ingested from a real capture", () => {
  let env: TmpEnv;
  let literal = "";

  before(() => {
    env = tmpEnv();
    const spool = join(env.dataHome, "spool", "claude-code");
    mkdirSync(spool, { recursive: true });
    const lines = readFileSync(join(FIXTURES, "claude-code", "hooks.spool.jsonl"), "utf8").split("${FIXTURES}").join(JSON.stringify(FIXTURES).slice(1, -1));
    writeFileSync(join(spool, "2026-11-01.jsonl"), lines);
    ok(["ingest"]);
    literal = join(env.root, "leaked.txt");
    writeFileSync(literal, "coerces inputs\n");
  });
  after(() => env.restore());

  const kinds = (q: string): string[] => JSON.parse(ok(["search", q, "--json"]).stdout).hits.map((h: { kind: string }) => h.kind);

  test("reports the index intact, and search finds the rewritten text", () => {
    const db = new DatabaseSync(join(env.dataHome, "index.db"), { readOnly: true });
    const n = db.prepare("SELECT count(*) AS events, count(text) AS indexed FROM events").get() as { events: number; indexed: number };
    db.close();
    assert.ok(n.indexed > 0 && n.indexed < n.events, "the capture has events without text");
    assert.deepEqual(kinds("coerces"), ["assistant.message"]);

    const r = cli(["purge", "--literal", literal]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /Integrity\s+index and search ok/);
    assert.equal(JSON.parse(ok(["purge", "--literal", literal, "--json"]).stdout).integrity, true);
    assert.deepEqual(kinds("coerces"), []);
    assert.deepEqual(kinds("purged"), ["assistant.message"]);
    assert.deepEqual(kinds("vitest"), ["tool.start"]);
  });

  test("still fails when an event with text is missing from the index", () => {
    const db = new DatabaseSync(join(env.dataHome, "index.db"));
    db.exec("INSERT INTO events_fts(events_fts, rowid, text) SELECT 'delete', rowid, text FROM events WHERE kind = 'user.message' AND text IS NOT NULL LIMIT 1");
    db.close();
    const r = cli(["purge", "--literal", literal]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Integrity\s+check failed/);
  });
});

describe("coding.sh purge with another process reading the blob pack or the index", () => {
  const INDEX_ONLY = "index-only-value-4471-correct-horse";
  let env: TmpEnv;
  let secrets = "";
  let pack = "";
  let index = "";
  before(async () => {
    env = tmpEnv();
    const blobs = fsBlobs(join(env.dataHome, "blobs"));
    const ref = await blobs.put(`$ cat .env\nAPI_TOKEN=${SECRET}\n`);
    await blobs.close();
    await seed(env.dataHome, {
      sessions: [session("s1")],
      events: [
        event("s1", 1, { kind: "tool.end", payload: { tool: "Bash", ok: true, outputRef: ref }, blobs: [ref] } as never),
        event("s1", 2, { payload: { text: `note ${INDEX_ONLY}` } }),
      ],
    });
    pack = join(env.dataHome, "blobs", "pack.db");
    index = join(env.dataHome, "index.db");
    secrets = join(env.root, "leaked.txt");
    writeFileSync(secrets, `${SECRET}\n`);
  });
  after(async () => {
    await closeBlobs();
    env.restore();
  });

  /** Another process (a sqlite3 shell, a backup) holding a read on `file` until it is killed. */
  async function holdRead(file: string, table: string): Promise<ChildProcess> {
    const src = `import { DatabaseSync } from "node:sqlite"; const db = new DatabaseSync(process.argv[1]); db.exec("BEGIN"); db.prepare("SELECT count(*) FROM ${table}").get(); console.log("holding"); setInterval(() => {}, 1000);`;
    const child = spawn(process.execPath, ["--no-warnings", "--input-type=module", "-e", src, file], { stdio: ["ignore", "pipe", "inherit"] });
    await new Promise<void>((res, rej) => {
      child.stdout!.on("data", (d: Buffer) => d.toString().includes("holding") && res());
      child.once("exit", (code) => rej(new Error(`the reader exited ${code}`)));
    });
    return child;
  }
  /** The value is in `name` or its WAL. */
  const fileHolds = (dir: string, name: string, value: string) =>
    readdirSync(dir)
      .filter((f) => f.startsWith(name))
      .some((f) => holds(readFileSync(join(dir, f)), value));
  const packHolds = () => fileHolds(join(env.dataHome, "blobs"), "pack.db", SECRET);
  const stop = async (reader: ChildProcess) => {
    reader.kill();
    await new Promise((res) => reader.once("exit", res));
  };

  test("says the old bytes stay in the index while a reader holds it; a purge after it closes removes them", async () => {
    const run = async () => {
      const blobs = new FsBlobStore(join(env.dataHome, "blobs"));
      try {
        return await purgeLiterals({ dbPath: index, blobs, literals: [INDEX_ONLY], waitMs: 200 });
      } finally {
        await blobs.close();
      }
    };
    const reader = await holdRead(index, "events");
    let r;
    try {
      r = await run();
    } finally {
      await stop(reader);
    }
    assert.deepEqual(r.oldBytesKept, ["index"]);
    assert.ok(fileHolds(env.dataHome, "index.db", INDEX_ONLY), "SQLite kept the old pages while the reader held them");

    assert.equal((await run()).oldBytesKept, undefined);
    assert.ok(!fileHolds(env.dataHome, "index.db", INDEX_ONLY), "no copy left in index.db or its WAL");
  });

  test("says the old bytes stay in the pack and exits 1; a purge after the reader closes removes them", async () => {
    const reader = await holdRead(pack, "blobs");
    let r;
    try {
      r = cli(["purge", "--literal", secrets]);
    } finally {
      await stop(reader);
    }
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /Old bytes\s+still in blobs\/pack\.db: another process is reading it/);
    assert.doesNotMatch(r.stderr, /Rotate the secret/);
    assert.ok(packHolds(), "SQLite kept the old pages while the reader held them");

    const again = JSON.parse(ok(["purge", "--literal", secrets, "--json"]).stdout);
    assert.equal(again.oldBytesKept, undefined);
    assert.ok(!packHolds(), "no copy left in pack.db or its WAL");
  });
});
