// docHref() maps a repo doc to its site page, or to GitHub when it has none.
// The changelog (src/lib/changelog.ts) links docs through it; that file has a
// ?raw import node cannot load, so the mapper is tested here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { docHref } from "../src/components/docs/markdown.ts";

const GITHUB_DOCS = "https://github.com/jackulau/coding.sh/blob/main/docs/";

test("a doc with a site page goes to that page", () => {
  assert.equal(docHref("concepts.md"), "/docs/concepts");
  assert.equal(docHref("reference/cli.md"), "/docs/cli");
  assert.equal(docHref("how-to/capture-with-proxy.md"), "/docs/how-to/capture-with-proxy");
});

test("a doc merged into another page goes to that page, without its fragment", () => {
  assert.equal(docHref("how-to/expensive-sessions.md"), "/docs/cost");
  assert.equal(docHref("guides/evals.md#verifier-output"), "/docs/evals");
});

test("the fragment is kept", () => {
  assert.equal(docHref("troubleshooting.md#sessions-dont-show-up"), "/docs/troubleshooting#sessions-dont-show-up");
  assert.equal(docHref("reference/config.md#capture"), "/docs/config#capture");
});

test("a heading on a later page of a split doc goes to that page", () => {
  const api = readFileSync(new URL("../../../docs/reference/api.md", import.meta.url), "utf8");
  assert.match(api, /^## Read API$/m);
  assert.equal(docHref("reference/api.md#read-api"), "/docs/api/read#read-api");
  assert.equal(docHref("reference/api.md"), "/docs/api");
});

test("a command heading in the CLI reference goes to that command's page", () => {
  assert.equal(docHref("reference/cli.md#codingsh-status"), "/docs/cli/status");
  assert.equal(docHref("reference/cli.md#codingsh-diff-calls"), "/docs/cli/diff-calls");
  assert.equal(docHref("reference/cli.md#codingsh-eval-run"), "/docs/cli/eval#cmd-eval-run");
  assert.equal(docHref("reference/cli.md#global-options"), "/docs/cli#global");
  // The site's CLI pages come from --help and have no such section.
  assert.equal(docHref("reference/cli.md#output-and-exit-codes"), `${GITHUB_DOCS}reference/cli.md#output-and-exit-codes`);
});

test("a doc with no site page goes to GitHub, never to a site URL", () => {
  for (const doc of ["design/architecture.md#efficiency", "RELEASE.md", "perf.md#hook"]) {
    assert.ok(existsSync(new URL(`../../../docs/${doc.split("#")[0]}`, import.meta.url)), doc);
    assert.equal(docHref(doc), `${GITHUB_DOCS}${doc}`);
  }
});

test("every doc a site page renders maps to a page that renders it", () => {
  const pages = new URL("../src/pages/docs/", import.meta.url);
  // Doc -> the routes whose page renders it (a split doc has several).
  const routes = new Map();
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = new URL(e.name + (e.isDirectory() ? "/" : ""), dir);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".astro"))
        for (const m of readFileSync(p, "utf8").matchAll(/<MdDoc\s[^>]*file="([^"]+)"/g)) {
          const route = `/docs/${p.href.slice(pages.href.length).replace(/(\/?index)?\.astro$/, "")}`.replace(/\/$/, "");
          routes.set(m[1], [...(routes.get(m[1]) ?? []), route]);
        }
    }
  };
  walk(pages);
  assert.ok(routes.size > 30);
  for (const [doc, paths] of routes) assert.ok(paths.includes(docHref(doc)), `${doc} -> ${docHref(doc)}, rendered at ${paths.join(", ")}`);
});

test("every site page it returns is a page the site builds", () => {
  const page = (path, suffix) => existsSync(new URL(`../src/pages${path}${suffix}`, import.meta.url));
  for (const doc of ["concepts.md", "guides/privacy.md", "reference/sdk.md", "guides/workflows.md", "compare/README.md", "use-cases/pi.md"]) {
    const path = docHref(doc);
    assert.ok(path.startsWith("/docs/"), `${doc} -> ${path}`);
    assert.ok(page(path, ".astro") || page(path, "/index.astro"), `${doc} -> ${path}`);
  }
});
