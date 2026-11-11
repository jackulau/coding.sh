// The marker a failed background ingest leaves (core/ingest-health.ts): the hook
// starts that ingest detached and unseen, so on 2026-11-09 ingest was stopped for
// four hours by a store the installed coding.sh could not open, and nothing said so.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { clearIngestStopped, ingestStoppedJson, markIngestStopped, readIngestStopped, spoolSize } from "../../src/core/ingest-health.ts";

const root = mkdtempSync(join(tmpdir(), "csh-ingest-health-"));
after(() => rmSync(root, { recursive: true, force: true }));
let seq = 0;
const marker = (): string => join(root, `h${seq++}`, "ingest-stopped.json");

describe("the ingest-stopped marker", () => {
  it("a store that can't be opened counts at the first failure, and keeps the time of the first one", () => {
    const file = marker();
    assert.equal(readIngestStopped(file), undefined);
    markIngestStopped(file, { reason: "store_newer", why: "a newer coding.sh migrated the store", next: "coding.sh update", version: "0.1.6" }, 1000);
    markIngestStopped(file, { reason: "store_newer", why: "a newer coding.sh migrated the store", next: "coding.sh update", version: "0.1.6" }, 5000);
    const m = readIngestStopped(file)!;
    assert.deepEqual([m.since, m.at, m.failures, m.reason, m.next], [1000, 5000, 2, "store_newer", "coding.sh update"]);
    assert.deepEqual(ingestStoppedJson(m), { since: "1970-01-01T00:00:01.000Z", lastFailedAt: "1970-01-01T00:00:05.000Z", reason: "store_newer", message: "a newer coding.sh migrated the store", next: "coding.sh update" });
  });

  it("any other failure counts only when the next background ingest fails too", () => {
    const file = marker();
    markIngestStopped(file, { reason: "error", why: "database is locked", version: "0.1.6" }, 1000);
    assert.equal(readIngestStopped(file), undefined, "one failed ingest is not a stopped ingest");
    markIngestStopped(file, { reason: "error", why: "database is locked", version: "0.1.6" }, 2000);
    assert.equal(readIngestStopped(file)?.since, 1000);
  });

  it("an ingest that works removes it; clearing and reading never throw", () => {
    const file = marker();
    markIngestStopped(file, { reason: "store_owned", why: "the store needs a migration", version: "0.1.6" });
    assert.ok(readIngestStopped(file));
    clearIngestStopped(file);
    assert.equal(existsSync(file), false);
    clearIngestStopped(file);
    writeFileSync(file, "not json");
    assert.equal(readIngestStopped(file), undefined);
  });
});

describe("spoolSize", () => {
  it("counts the capture files of every agent and nothing else", () => {
    const spool = join(root, "spool");
    assert.deepEqual(spoolSize(spool), { files: 0, bytes: 0 });
    mkdirSync(join(spool, "claude-code"), { recursive: true });
    mkdirSync(join(spool, "codex"), { recursive: true });
    writeFileSync(join(spool, "claude-code", "a.jsonl"), "{}\n");
    writeFileSync(join(spool, "codex", "b.jsonl"), "{}\n{}\n");
    writeFileSync(join(spool, "codex", "b.raw"), "side file");
    writeFileSync(join(spool, ".ingest.lock"), "");
    assert.deepEqual(spoolSize(spool), { files: 2, bytes: 9 });
  });
});
