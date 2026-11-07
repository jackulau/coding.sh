// Tell IndexNow (Bing, Yandex, Seznam, Naver and others) about every URL in the
// live sitemap. Run after a deploy:
//
//   node scripts/indexnow.mjs            # submit
//   node scripts/indexnow.mjs --dry-run  # list what would be submitted
//
// The key is the one public/<32 hex>.txt file, served at https://coding.sh/<key>.txt,
// which is how IndexNow checks we own the host. Reading the sitemap from the
// live site (not dist/) means only URLs that are actually deployed get sent.
import { readdirSync } from "node:fs";

const SITE = process.env.SITE_URL ?? "https://coding.sh";
const HOST = new URL(SITE).host;
const ENDPOINT = "https://api.indexnow.org/indexnow";
const dryRun = process.argv.includes("--dry-run");

const keyFiles = readdirSync(new URL("../public/", import.meta.url)).filter((f) => /^[0-9a-f]{32}\.txt$/.test(f));
if (keyFiles.length !== 1) {
  console.error(`indexnow: expected one public/<key>.txt, found ${keyFiles.length}`);
  process.exit(1);
}
const key = keyFiles[0].slice(0, -4);

async function get(url) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

const locs = (xml) => [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);

// The index lists child sitemaps; a plain urlset lists pages.
const index = await get(`${SITE}/sitemap-index.xml`);
const children = index.includes("<sitemapindex") ? locs(index) : [];
const urls = children.length ? (await Promise.all(children.map(get))).flatMap(locs) : locs(index);
const urlList = [...new Set(urls)].filter((u) => new URL(u).host === HOST);

if (!urlList.length) {
  console.error("indexnow: the sitemap has no URLs");
  process.exit(1);
}

if (dryRun) {
  console.log(`indexnow: would submit ${urlList.length} URLs for ${HOST}`);
  for (const u of urlList) console.log(`  ${u}`);
  process.exit(0);
}

// The key file must be live before IndexNow fetches it.
const served = (await get(`${SITE}/${key}.txt`)).trim();
if (served !== key) {
  console.error(`indexnow: ${SITE}/${key}.txt does not serve the key`);
  process.exit(1);
}

// One request takes up to 10,000 URLs.
const res = await fetch(ENDPOINT, {
  method: "POST",
  headers: { "Content-Type": "application/json; charset=utf-8" },
  body: JSON.stringify({ host: HOST, key, keyLocation: `${SITE}/${key}.txt`, urlList }),
});
const body = (await res.text()).trim();
// 200: accepted. 202: accepted, key check still pending.
if (res.status !== 200 && res.status !== 202) {
  console.error(`indexnow: HTTP ${res.status}${body ? ` ${body}` : ""}`);
  process.exit(1);
}
console.log(`indexnow: submitted ${urlList.length} URLs for ${HOST} (HTTP ${res.status})`);
