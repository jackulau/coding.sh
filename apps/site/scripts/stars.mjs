// Print the repository's GitHub star count, for the deploy job to pass to the
// build as SITE_GITHUB_STARS (see src/lib/stars.mjs):
//
//   node scripts/stars.mjs                 # the repo in GITHUB_REPOSITORY
//   node scripts/stars.mjs owner/name      # another repo
//
// GITHUB_TOKEN is used when set. A request that does not get through is tried
// three times. After that it prints nothing and exits 0: a deploy never fails
// on GitHub's API, the nav just shows no count.
import { pathToFileURL } from "node:url";
import { parseStars } from "../src/lib/stars.mjs";

/**
 * The star count of owner/name, or undefined when GitHub does not give one.
 * A request that fails to connect, times out or gets a 429 or 5xx is tried again, `tries` times in all.
 */
export async function fetchStars(repo, { token, fetch: get = fetch, timeoutMs = 5000, tries = 3, waitMs = 500 } = {}) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(String(repo ?? ""))) return undefined;
  const headers = { Accept: "application/vnd.github+json", "User-Agent": "site-build" };
  if (token) headers.Authorization = `Bearer ${token}`;
  for (let attempt = 1; attempt <= tries; attempt++) {
    if (attempt > 1) await new Promise((r) => setTimeout(r, waitMs));
    try {
      const res = await get(`https://api.github.com/repos/${repo}`, { headers, signal: AbortSignal.timeout(timeoutMs) });
      if (res.status === 429 || res.status >= 500) continue;
      if (!res.ok) return undefined;
      return parseStars((await res.json())?.stargazers_count);
    } catch {
      // not reached, or cut off: try again
    }
  }
  return undefined;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const stars = await fetchStars(process.argv[2] ?? process.env.GITHUB_REPOSITORY, { token: process.env.GITHUB_TOKEN });
  if (stars) console.log(stars);
}
