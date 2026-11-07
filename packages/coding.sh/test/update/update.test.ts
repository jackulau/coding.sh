import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import {
  cacheFile,
  checkForUpdate,
  getUpdateStatus,
  notice,
  noticeText,
  readCache,
  scheduleUpdateCheck,
  updateChecksDisabled,
  type Spawner,
  type UpdateCache,
} from "../../src/update/index.ts";
import { clock, DAY, fakeFetch, GH, HOUR, NPM, release, tmpEnv, ttyStream } from "./helpers.ts";

function seed(env: NodeJS.ProcessEnv, cache: UpdateCache): void {
  const f = cacheFile(env);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify(cache));
}

function fakeSpawn(): { spawn: Spawner; runs: { command: string; args: string[]; detached: boolean }[] } {
  const runs: { command: string; args: string[]; detached: boolean }[] = [];
  return { runs, spawn: (command, args, o) => (runs.push({ command, args, detached: o.detached }), { unref() {} }) };
}

const out = { json: false };

describe("checkForUpdate", () => {
  test("fetches the latest GitHub release and caches it in <root>/update.json", async () => {
    const env = tmpEnv();
    const c = clock();
    const f = fakeFetch({ [GH]: release("v0.2.0") });
    const cache = await checkForUpdate(env, { fetch: f.fetch, now: c.now, current: "0.1.0" });
    assert.equal(f.calls.length, 1);
    assert.equal(cache.latest, "0.2.0");
    assert.equal(cache.current, "0.1.0");
    assert.equal(cache.checkedAt, c.now());
    assert.equal(cache.url, "https://github.com/jackulau/coding.sh/releases/tag/v0.2.0");
    assert.equal(cache.install, "https://github.com/jackulau/coding.sh/releases/download/v0.2.0/coding.sh-0.2.0.tgz");
    assert.match(cache.notes ?? "", /What's new/);
    assert.equal(cacheFile(env), join(env.CODING_SH_HOME!, "update.json"));
    assert.deepEqual(JSON.parse(readFileSync(cacheFile(env), "utf8")), cache);
  });

  test("checks at most once per 24 h, then refreshes", async () => {
    const env = tmpEnv();
    const c = clock();
    const f = fakeFetch({ [GH]: release("v0.2.0") });
    await checkForUpdate(env, { fetch: f.fetch, now: c.now, current: "0.1.0" });
    c.advance(23 * HOUR);
    const again = await checkForUpdate(env, { fetch: f.fetch, now: c.now, current: "0.1.0" });
    assert.equal(f.calls.length, 1, "served from cache inside the window");
    assert.equal(again.latest, "0.2.0");
    c.advance(1 * HOUR);
    await checkForUpdate(env, { fetch: f.fetch, now: c.now, current: "0.1.0" });
    assert.equal(f.calls.length, 2, "refreshed after 24 h");
  });

  test("a failed check is throttled too and keeps the previous result", async () => {
    const env = tmpEnv();
    const c = clock();
    seed(env, { checkedAt: c.now() - 2 * DAY, latest: "0.2.0", url: "https://example.test/r" });
    const f = fakeFetch({ [GH]: new TypeError("fetch failed"), [NPM]: new TypeError("fetch failed") });
    const cache = await checkForUpdate(env, { fetch: f.fetch, now: c.now, current: "0.1.0" });
    assert.equal(f.calls.length, 2, "GitHub, then the npm fallback");
    assert.equal(cache.latest, "0.2.0");
    assert.match(cache.error ?? "", /GitHub: fetch failed; npm: fetch failed/);
    assert.equal(cache.attemptedAt, c.now());
    c.advance(12 * HOUR);
    await checkForUpdate(env, { fetch: f.fetch, now: c.now, current: "0.1.0" });
    assert.equal(f.calls.length, 2, "no retry storm while offline");
  });

  test("404 from both GitHub and npm means no release is published yet, not a network failure", async () => {
    const env = tmpEnv();
    const f = fakeFetch({});
    const cache = await checkForUpdate(env, { fetch: f.fetch, now: clock().now, current: "0.1.0" });
    assert.equal(f.calls.length, 2);
    assert.equal(cache.errorKind, "no_release");
    assert.equal(cache.latest, undefined);
    assert.match(cache.error ?? "", /GitHub: .*HTTP 404; npm: .*HTTP 404/);
    assert.equal(readCache(env).errorKind, "no_release", "persisted, so the CLI can tell it apart from a network failure");

    // Only a 404 from both sources counts: a 404 plus a network error is still a failed check.
    const env2 = tmpEnv();
    const half = fakeFetch({ [NPM]: new TypeError("fetch failed") });
    const c2 = await checkForUpdate(env2, { fetch: half.fetch, now: clock().now, current: "0.1.0" });
    assert.equal(c2.errorKind, "network");
    assert.match(c2.error ?? "", /GitHub: .*HTTP 404; npm: fetch failed/);

    // A release appearing later clears the flag.
    const c = clock();
    c.advance(2 * DAY);
    const later = await checkForUpdate(env, { fetch: fakeFetch({ [GH]: release("v0.2.0") }).fetch, now: c.now, current: "0.1.0" });
    assert.equal(later.latest, "0.2.0");
    assert.equal(later.errorKind, undefined);
    assert.equal(later.error, undefined);
  });

  test("falls back to npm only for a manifest that points back at the repo", async () => {
    const env = tmpEnv();
    const ours = fakeFetch({ [NPM]: { version: "0.3.0", repository: { url: "git+https://github.com/jackulau/coding.sh.git" } } });
    const a = await checkForUpdate(env, { fetch: ours.fetch, now: clock().now, current: "0.1.0" });
    assert.equal(a.latest, "0.3.0");
    assert.equal(a.source, "npm");
    assert.equal(a.install, "coding.sh@0.3.0");
    assert.equal(a.error, undefined);

    const env2 = tmpEnv();
    const squat = fakeFetch({ [NPM]: { version: "9.9.9", repository: { url: "https://github.com/someone/else" } } });
    const b = await checkForUpdate(env2, { fetch: squat.fetch, now: clock().now, current: "0.1.0" });
    assert.equal(b.latest, undefined);
    assert.match(b.error ?? "", /does not come from jackulau\/coding\.sh/);
  });

  test("ignores non-version tags, drafts and prereleases; never throws", async () => {
    for (const r of [release("nightly"), release("v0.2.0", { prerelease: true }), release("v0.2.0", { draft: true })]) {
      const env = tmpEnv();
      const f = fakeFetch({ [GH]: r });
      const cache = await checkForUpdate(env, { fetch: f.fetch, now: clock().now, current: "0.1.0" });
      assert.equal(cache.latest, undefined);
      assert.ok(cache.error);
    }
    const env = tmpEnv();
    const boom = (() => {
      throw new Error("sync explode");
    }) as unknown as typeof fetch;
    const cache = await checkForUpdate(env, { fetch: boom, now: clock().now, current: "0.1.0" });
    assert.match(cache.error ?? "", /sync explode/);
  });

  test("times out a hung request after timeoutMs", async () => {
    const env = tmpEnv();
    const hang = ((_u: string, init?: RequestInit) =>
      new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)))) as unknown as typeof fetch;
    const t0 = Date.now();
    // AbortSignal.timeout timers are unref'd; a real fetch keeps the loop alive with its socket, the fake does not.
    const keepAlive = setInterval(() => {}, 1000);
    const cache = await checkForUpdate(env, { fetch: hang, now: clock().now, current: "0.1.0", timeoutMs: 50 }).finally(() => clearInterval(keepAlive));
    assert.ok(Date.now() - t0 < 1000);
    assert.match(cache.error ?? "", /GitHub: .*npm: /);
  });

  test("opt-outs skip the network; force overrides them", async () => {
    for (const extra of [{ CI: "true" }, { NO_UPDATE_NOTIFIER: "1" }, { CODING_SH_NO_UPDATE_CHECK: "1" }]) {
      const env = tmpEnv(extra);
      const f = fakeFetch({ [GH]: release("v0.2.0") });
      await checkForUpdate(env, { fetch: f.fetch, now: clock().now, current: "0.1.0" });
      assert.equal(f.calls.length, 0, JSON.stringify(extra));
      await checkForUpdate(env, { fetch: f.fetch, now: clock().now, current: "0.1.0", force: true });
      assert.equal(f.calls.length, 1);
    }
  });
});

describe("updateChecksDisabled", () => {
  test("CI, NO_UPDATE_NOTIFIER, CODING_SH_NO_UPDATE_CHECK and [update] check = false", () => {
    assert.equal(updateChecksDisabled(tmpEnv()), undefined);
    assert.equal(updateChecksDisabled(tmpEnv({ CI: "1" })), "ci");
    assert.equal(updateChecksDisabled(tmpEnv({ GITHUB_ACTIONS: "true" })), "ci");
    assert.equal(updateChecksDisabled(tmpEnv({ CI: "false" })), undefined);
    assert.equal(updateChecksDisabled(tmpEnv({ CI: "0" })), undefined);
    assert.equal(updateChecksDisabled(tmpEnv({ NO_UPDATE_NOTIFIER: "" })), "NO_UPDATE_NOTIFIER");
    assert.equal(updateChecksDisabled(tmpEnv({ CODING_SH_NO_UPDATE_CHECK: "1" })), "CODING_SH_NO_UPDATE_CHECK");
    assert.equal(updateChecksDisabled(tmpEnv({ CODING_SH_NO_UPDATE_CHECK: "0" })), undefined);

    const env = tmpEnv();
    mkdirSync(env.CODING_SH_HOME!, { recursive: true });
    const cfg = join(env.CODING_SH_HOME!, "config.toml");
    writeFileSync(cfg, "[capture]\nmode = \"full\"\n\n[update]\ncheck = false\n");
    assert.equal(updateChecksDisabled(env), "config");
    writeFileSync(cfg, "[update]\ncheck = true\n");
    assert.equal(updateChecksDisabled(env), undefined);
    writeFileSync(cfg, "this is [not toml");
    assert.equal(updateChecksDisabled(env), undefined, "a broken config never breaks commands");
  });
});

describe("notice", () => {
  test("prints one dim line from the cache, at most once per day per version", () => {
    const env = tmpEnv();
    const c = clock();
    seed(env, { checkedAt: c.now(), attemptedAt: c.now(), latest: "0.2.0" });
    const err = ttyStream();
    const sp = fakeSpawn();
    const styled = { json: false, style: (s: string) => `<faint>${s}</faint>` };
    assert.equal(notice(env, styled, { stderr: err, now: c.now, current: "0.1.0", spawn: sp.spawn }), true);
    assert.equal(err.text, `<faint>Update available 0.1.0 → 0.2.0 · run: coding.sh update</faint>\n`);
    assert.equal(noticeText("0.1.0", "0.2.0"), "Update available 0.1.0 → 0.2.0 · run: coding.sh update");
    assert.deepEqual(readCache(env).notified, { version: "0.2.0", at: c.now() });

    c.advance(23 * HOUR);
    assert.equal(notice(env, out, { stderr: err, now: c.now, current: "0.1.0", spawn: sp.spawn }), false, "same version, same day");
    c.advance(1 * HOUR);
    assert.equal(notice(env, out, { stderr: err, now: c.now, current: "0.1.0", spawn: sp.spawn }), true, "a day later");

    // A newer version is news right away.
    seed(env, { ...readCache(env), latest: "0.3.0" });
    assert.equal(notice(env, out, { stderr: err, now: c.now, current: "0.1.0", spawn: sp.spawn }), true);
    assert.match(err.text, /0\.1\.0 → 0\.3\.0/);
  });

  test("silent when up to date, not a TTY, --json, CI, opted out, or after `update`", () => {
    const cases: [string, NodeJS.ProcessEnv, { json: boolean }, boolean, string | undefined, string][] = [
      ["up to date", {}, out, true, undefined, "0.2.0"],
      ["newer than latest", {}, out, true, undefined, "0.3.0-rc.1"],
      ["not a TTY", {}, out, false, undefined, "0.1.0"],
      ["--json", {}, { json: true }, true, undefined, "0.1.0"],
      ["CI", { CI: "true" }, out, true, undefined, "0.1.0"],
      ["NO_UPDATE_NOTIFIER", { NO_UPDATE_NOTIFIER: "1" }, out, true, undefined, "0.1.0"],
      ["CODING_SH_NO_UPDATE_CHECK", { CODING_SH_NO_UPDATE_CHECK: "1" }, out, true, undefined, "0.1.0"],
      ["update command", {}, out, true, "update", "0.1.0"],
    ];
    for (const [name, extra, o, tty, command, current] of cases) {
      const env = tmpEnv(extra);
      const c = clock();
      seed(env, { checkedAt: c.now(), attemptedAt: c.now(), latest: "0.2.0" });
      const err = ttyStream(tty);
      assert.equal(notice(env, o, { stderr: err, now: c.now, current, command, spawn: fakeSpawn().spawn }), false, name);
      assert.equal(err.text, "", name);
    }
    const env = tmpEnv();
    mkdirSync(env.CODING_SH_HOME!, { recursive: true });
    writeFileSync(join(env.CODING_SH_HOME!, "config.toml"), "[update]\ncheck = false\n");
    seed(env, { checkedAt: clock().now(), latest: "0.2.0" });
    const err = ttyStream();
    assert.equal(notice(env, out, { stderr: err, now: clock().now, current: "0.1.0", spawn: fakeSpawn().spawn }), false, "config opt-out");
  });

  test("never waits on the network: a stale cache spawns one detached refresh", () => {
    const env = tmpEnv();
    const c = clock();
    const sp = fakeSpawn();
    const err = ttyStream();
    assert.equal(notice(env, out, { stderr: err, now: c.now, current: "0.1.0", spawn: sp.spawn }), false, "nothing cached yet");
    assert.equal(sp.runs.length, 1);
    assert.equal(sp.runs[0]!.command, process.execPath);
    assert.equal(sp.runs[0]!.detached, true);
    assert.equal(sp.runs[0]!.args[0], "-e");
    const args = JSON.parse(sp.runs[0]!.args[2]!) as { file: string; current: string; timeoutMs: number; githubApi: string };
    assert.equal(args.file, cacheFile(env));
    assert.equal(args.current, "0.1.0");
    assert.equal(args.timeoutMs, 1500);
    assert.equal(args.githubApi, "https://api.github.com");
    assert.equal(readCache(env).attemptedAt, c.now(), "attempt recorded before spawning");

    notice(env, out, { stderr: err, now: c.now, current: "0.1.0", spawn: sp.spawn });
    c.advance(23 * HOUR);
    notice(env, out, { stderr: err, now: c.now, current: "0.1.0", spawn: sp.spawn });
    assert.equal(sp.runs.length, 1, "no second child inside 24 h");
    c.advance(1 * HOUR);
    notice(env, out, { stderr: err, now: c.now, current: "0.1.0", spawn: sp.spawn });
    assert.equal(sp.runs.length, 2);
  });

  test("scheduleUpdateCheck does nothing when opted out and survives a spawn failure", () => {
    const sp = fakeSpawn();
    assert.equal(scheduleUpdateCheck(tmpEnv({ CI: "1" }), { spawn: sp.spawn, now: clock().now }), false);
    assert.equal(sp.runs.length, 0);
    const failing: Spawner = () => {
      throw new Error("EAGAIN");
    };
    assert.equal(scheduleUpdateCheck(tmpEnv(), { spawn: failing, now: clock().now }), false);
  });

  test("a corrupt cache file is treated as empty", () => {
    const env = tmpEnv();
    mkdirSync(env.CODING_SH_HOME!, { recursive: true });
    writeFileSync(cacheFile(env), "{not json");
    assert.deepEqual(readCache(env), {});
    const err = ttyStream();
    assert.equal(notice(env, out, { stderr: err, now: clock().now, current: "0.1.0", spawn: fakeSpawn().spawn }), false);
  });
});

describe("getUpdateStatus", () => {
  test("reports current vs latest and refreshes a stale cache", async () => {
    const env = tmpEnv();
    const f = fakeFetch({ [GH]: release("v0.2.0") });
    const s = await getUpdateStatus(env, { fetch: f.fetch, now: clock().now, current: "0.1.0" });
    assert.deepEqual(
      { ...s, notes: s.notes ? "…" : null },
      {
        current: "0.1.0",
        latest: "0.2.0",
        updateAvailable: true,
        url: "https://github.com/jackulau/coding.sh/releases/tag/v0.2.0",
        notes: "…",
        install: "https://github.com/jackulau/coding.sh/releases/download/v0.2.0/coding.sh-0.2.0.tgz",
        checkedAt: clock().now(),
        disabled: null,
        error: null,
        command: "coding.sh update",
      },
    );
    const cached = await getUpdateStatus(env, { fetch: f.fetch, now: clock().now, current: "0.2.0", refresh: "never" });
    assert.equal(cached.updateAvailable, false);
    assert.equal(f.calls.length, 1);
  });

  test("names the opt-out and does no network", async () => {
    const env = tmpEnv({ CODING_SH_NO_UPDATE_CHECK: "1" });
    const f = fakeFetch({ [GH]: release("v0.2.0") });
    const s = await getUpdateStatus(env, { fetch: f.fetch, now: clock().now, current: "0.1.0" });
    assert.equal(s.disabled, "CODING_SH_NO_UPDATE_CHECK");
    assert.equal(s.latest, null);
    assert.equal(f.calls.length, 0);
  });
});
