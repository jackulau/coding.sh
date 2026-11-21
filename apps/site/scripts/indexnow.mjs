// Tell IndexNow (Bing, Yandex, Seznam, Naver and others) about every URL in the
// live sitemap. Run after a deploy:
//
//   node scripts/indexnow.mjs            # submit
//   node scripts/indexnow.mjs --dry-run  # list what would be submitted
//
// The key is the one public/<32 hex>.txt file, served at https://coding.sh/<key>.txt,
// which is how IndexNow checks we own the host. Reading the sitemap from the
// live site (not dist/) means only URLs that are actually deployed get sent.
//
// A request whose lookup or connection fails, that times out, or that gets a 429
// or 5xx is tried again, so a short DNS outage on the runner does not lose the
// ping. The deploy job runs this step with continue-on-error: it never fails a deploy.
import { readdirSync } from "node:fs";
import { pathToFileURL } from "node:url";

const ENDPOINT = "https://api.indexnow.org/indexnow";

/** Why a request that threw got no response, in the words the deploy's smoke test uses. */
export function why(err) {
  const code = err?.cause?.code ?? err?.code;
  if (code === "EAI_AGAIN" || code === "ENOTFOUND") return "lookup failed";
  if (err?.name === "TimeoutError" || code === "UND_ERR_CONNECT_TIMEOUT" || code === "ETIMEDOUT") return "timed out";
  if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "UND_ERR_SOCKET") return "connection failed";
  // fetch throws "fetch failed" and puts the reason in cause, such as "bad port".
  return err?.cause?.message ?? err?.message ?? String(err);
}

/**
 * fetch(url, init), tried again when the request throws (a failed lookup or connection, a timeout)
 * or gets a 429 or 5xx, `tries` times in all. Returns the last response, or throws when no try got one.
 */
export async function request(url, init = {}, { fetch: send = fetch, tries = 6, waitMs = 10_000, timeoutMs = 15_000, log = console.log } = {}) {
  let res;
  let err;
  for (let attempt = 1; attempt <= tries; attempt++) {
    if (attempt > 1) await new Promise((r) => setTimeout(r, waitMs));
    res = undefined;
    err = undefined;
    try {
      res = await send(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      if (res.status !== 429 && res.status < 500) return res;
    } catch (e) {
      err = e;
    }
    if (attempt === tries) break;
    if (res?.body) await res.body.cancel().catch(() => {});
    log(`indexnow: ${url} ${res ? `HTTP ${res.status}` : why(err)} on try ${attempt}, retrying`);
  }
  if (res) return res;
  throw new Error(`${url}: ${why(err)} after ${tries} tries`);
}

async function get(url) {
  const res = await request(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

const locs = (xml) => [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);

/** Submits the sitemap's URLs; returns the exit code. */
async function main() {
  const SITE = process.env.SITE_URL ?? "https://coding.sh";
  const HOST = new URL(SITE).host;
  const dryRun = process.argv.includes("--dry-run");

  const keyFiles = readdirSync(new URL("../public/", import.meta.url)).filter((f) => /^[0-9a-f]{32}\.txt$/.test(f));
  if (keyFiles.length !== 1) {
    console.error(`indexnow: expected one public/<key>.txt, found ${keyFiles.length}`);
    return 1;
  }
  const key = keyFiles[0].slice(0, -4);

  // The index lists child sitemaps; a plain urlset lists pages.
  const index = await get(`${SITE}/sitemap-index.xml`);
  const children = index.includes("<sitemapindex") ? locs(index) : [];
  const urls = children.length ? (await Promise.all(children.map((u) => get(u)))).flatMap(locs) : locs(index);
  const urlList = [...new Set(urls)].filter((u) => new URL(u).host === HOST);

  if (!urlList.length) {
    console.error("indexnow: the sitemap has no URLs");
    return 1;
  }

  if (dryRun) {
    console.log(`indexnow: would submit ${urlList.length} URLs for ${HOST}`);
    for (const u of urlList) console.log(`  ${u}`);
    return 0;
  }

  // The key file must be live before IndexNow fetches it.
  const served = (await get(`${SITE}/${key}.txt`)).trim();
  if (served !== key) {
    console.error(`indexnow: ${SITE}/${key}.txt does not serve the key`);
    return 1;
  }

  // One request takes up to 10,000 URLs.
  const res = await request(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ host: HOST, key, keyLocation: `${SITE}/${key}.txt`, urlList }),
  });
  const body = (await res.text()).trim();
  // 200: accepted. 202: accepted, key check still pending.
  if (res.status !== 200 && res.status !== 202) {
    console.error(`indexnow: HTTP ${res.status}${body ? ` ${body}` : ""}`);
    return 1;
  }
  console.log(`indexnow: submitted ${urlList.length} URLs for ${HOST} (HTTP ${res.status})`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    process.exitCode = await main();
  } catch (e) {
    console.error(`indexnow: ${e.message}`);
    process.exitCode = 1;
  }
}
