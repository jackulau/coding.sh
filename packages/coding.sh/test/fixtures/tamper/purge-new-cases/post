// coding.sh purge --literal: a secret in a payload, a tool command, a title, a label,
// a blob, a saved fold and the spool ends with no copy anywhere on disk; the index
// stays intact, search still works and every blob still matches its hash.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, test } from "node:test";
import { parseLiterals } from "../../src/cli/commands/purge.ts";
import { FsBlobStore } from "../../src/store/fs-blobs.ts";
import { PURGE_MARKER, purgeLiterals, Scrubber } from "../../src/store/purge.ts";
import { SqliteIndexStore } from "../../src/store/sqlite.ts";
import { tmpEnv, type TmpEnv } from "../adapters/_helpers.ts";
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
  const blobs = new FsBlobStore(join(env.dataHome, "blobs"));
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
  after(() => env.restore());

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
    const blobs = new FsBlobStore(join(env.dataHome, "blobs"));
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
      const text = await new FsBlobStore(join(env.dataHome, "blobs")).getText(ref);
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
  after(() => env.restore());

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
