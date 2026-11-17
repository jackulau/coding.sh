// The nav's GitHub star count (src/lib/stars.mjs, scripts/stars.mjs, Nav.astro).
// The build reads SITE_GITHUB_STARS and makes no request, so a build without it,
// or with something that is not a count, shows the nav as it was.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseStars, formatStars } from "../src/lib/stars.mjs";
import { fetchStars } from "../scripts/stars.mjs";
import { LOCALES } from "../src/i18n/locales.mjs";
import { distOpts, needDist } from "./_dist.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");

test("parseStars takes a whole number above zero and nothing else", () => {
  assert.equal(parseStars("117"), 117);
  assert.equal(parseStars(" 48200\n"), 48200);
  assert.equal(parseStars(117), 117);
  for (const bad of [undefined, null, "", " ", "0", "007", "-3", "1.5", "1e3", "117 stars", "NaN", "1234567890", {}, []]) {
    assert.equal(parseStars(bad), undefined, `${JSON.stringify(bad)} is not a count`);
  }
});

test("formatStars shortens from a thousand up and never rounds up", () => {
  const cases = [
    [1, "1"],
    [117, "117"],
    [999, "999"],
    [1000, "1k"],
    [1049, "1k"],
    [1234, "1.2k"],
    [1999, "1.9k"],
    [48200, "48.2k"],
    [99999, "99.9k"],
    [100000, "100k"],
    [123456, "123k"],
    [999999, "999k"],
    [1000000, "1M"],
    [1234567, "1.2M"],
  ];
  for (const [n, want] of cases) assert.equal(formatStars(n), want, String(n));
});

const reply = (status, body) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test("fetchStars asks GitHub for the repo and returns its count", async () => {
  const calls = [];
  const get = async (url, init) => {
    calls.push({ url, init });
    return reply(200, { stargazers_count: 117 })();
  };
  assert.equal(await fetchStars("someone/some.repo", { token: "t0", fetch: get }), 117);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.github.com/repos/someone/some.repo");
  assert.equal(calls[0].init.headers.Authorization, "Bearer t0");

  calls.length = 0;
  await fetchStars("someone/some.repo", { fetch: get });
  assert.ok(!("Authorization" in calls[0].init.headers), "no token, no Authorization header");
});

test("fetchStars gives nothing, and does not throw, when GitHub does not give a count", async () => {
  const boom = async () => {
    throw new Error("offline");
  };
  const notJson = async () => ({
    ok: true,
    status: 200,
    json: async () => {
      throw new SyntaxError("not JSON");
    },
  });
  const quick = { waitMs: 0 };
  assert.equal(await fetchStars("someone/repo", { fetch: boom, ...quick }), undefined);
  assert.equal(await fetchStars("someone/repo", { fetch: notJson, ...quick }), undefined);
  assert.equal(await fetchStars("someone/repo", { fetch: reply(503, {}), ...quick }), undefined);
  assert.equal(await fetchStars("someone/repo", { fetch: reply(403, { message: "forbidden" }) }), undefined);
  assert.equal(await fetchStars("someone/repo", { fetch: reply(200, {}) }), undefined);
  assert.equal(await fetchStars("someone/repo", { fetch: reply(200, { stargazers_count: 0 }) }), undefined);
  assert.equal(await fetchStars("someone/repo", { fetch: reply(200, { stargazers_count: "many" }) }), undefined);
});

test("fetchStars tries again after a failed connection, a 429 or a 5xx, three times in all", async () => {
  const flaky = (failures) => {
    let n = 0;
    const get = async () => {
      n++;
      const f = failures[n - 1];
      if (f === "throw") throw new Error("connect failed");
      if (f) return reply(f, {})();
      return reply(200, { stargazers_count: 117 })();
    };
    return { get, calls: () => n };
  };
  for (const failures of [["throw"], ["throw", 502], [429, "throw"]]) {
    const { get, calls } = flaky(failures);
    assert.equal(await fetchStars("someone/repo", { fetch: get, waitMs: 0 }), 117, `after ${failures.join(", ")}`);
    assert.equal(calls(), failures.length + 1);
  }
  const { get, calls } = flaky(["throw", 500, 503, "throw"]);
  assert.equal(await fetchStars("someone/repo", { fetch: get, waitMs: 0 }), undefined);
  assert.equal(calls(), 3, "it stops after three tries");

  const denied = flaky([404]);
  assert.equal(await fetchStars("someone/repo", { fetch: denied.get, waitMs: 0 }), undefined);
  assert.equal(denied.calls(), 1, "a 404 is not tried again");
});

test("fetchStars makes no request for something that is not owner/name", async () => {
  let asked = 0;
  const get = async () => {
    asked++;
    return reply(200, { stargazers_count: 5 })();
  };
  for (const bad of [undefined, "", "repo", "a/b/c", "a/b?x=1", "../../user", "a b/c"]) assert.equal(await fetchStars(bad, { fetch: get }), undefined);
  assert.equal(asked, 0);
});

/** The star counts in a built page: the short figure shown and the label a screen reader gets. */
function counts(html) {
  return [...html.matchAll(/<span class="nav__stars[^"]*"[^>]*data-stars[^>]*>([\s\S]*?<span class="sr-only"[^>]*>[^<]*<\/span>)\s*<\/span>/g)].map((m) => ({
    shown: m[1].match(/<span aria-hidden="true"[^>]*>([^<]*)<\/span>/)?.[1],
    label: m[1].match(/<span class="sr-only"[^>]*>([^<]*)<\/span>/)?.[1],
  }));
}

// What this build was given. A build made without the variable shows no count,
// so the test asks for one only when the variable is set here too (the deploy
// job sets it for the build and for this check).
const given = parseStars(process.env.SITE_GITHUB_STARS);
const PAGES = [...LOCALES.map((l) => join(l.code === "en" ? "" : l.code, "index.html")), join("docs", "index.html"), join("changelog", "index.html")];

test("a built page shows the star count in the bar and in the menu, or in neither", distOpts(DIST), () => {
  needDist(DIST);
  for (const page of PAGES) {
    const html = readFileSync(join(DIST, page), "utf8");
    const found = counts(html);
    assert.equal(html.split("data-stars").length - 1, found.length, `${page}: every count has a figure and a label`);
    assert.ok(found.length === 0 || found.length === 2, `${page}: ${found.length} star counts; the bar and the menu each show one, or neither does`);
    for (const { shown, label } of found) {
      const n = parseStars(label.match(/\d+/)?.[0]);
      assert.ok(n, `${page}: the label "${label}" holds the whole number`);
      assert.equal(shown, formatStars(n), `${page}: the figure is the short form of the number in the label`);
      if (given) assert.equal(n, given, `${page}: the count is SITE_GITHUB_STARS`);
    }
    if (given) assert.equal(found.length, 2, `${page}: SITE_GITHUB_STARS=${given}, so the bar and the menu show it`);
    assert.equal(new Set(found.map((f) => f.label)).size <= 1, true, `${page}: both counts carry the same label`);
  }
});

test("a translated front page labels the count in its own language", distOpts(DIST), () => {
  needDist(DIST);
  const english = counts(readFileSync(join(DIST, "index.html"), "utf8"));
  if (!english.length) return; // this build has no count
  for (const l of LOCALES.filter((l) => l.code !== "en")) {
    const [first] = counts(readFileSync(join(DIST, l.code, "index.html"), "utf8"));
    assert.ok(first, `/${l.code} shows the count`);
    assert.notEqual(first.label, english[0].label, `/${l.code} still says "${english[0].label}"`);
  }
});
