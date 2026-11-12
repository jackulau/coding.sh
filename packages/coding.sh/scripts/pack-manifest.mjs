// The package's prepack and postpack scripts. The "source" export conditions point into
// src/, which the tarball does not hold, so `npm pack` and `npm publish` ship a package.json
// without them and the working copy gets its own back afterwards.
//
//   node scripts/pack-manifest.mjs --prepack    back up package.json, then drop the source conditions
//   node scripts/pack-manifest.mjs --postpack   put the backup back
//
// The backup sits next to package.json, outside dist/, so `npm run build` (which deletes dist/)
// can't lose it. A pack that was interrupted before postpack leaves the backup; the next
// prepack refuses to start and the next build puts it back (restoreManifest).
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const BACKUP = ".package.json.prepack";

export function withoutSource(pkg) {
  const out = structuredClone(pkg);
  for (const c of Object.values(out.exports ?? {})) if (c && typeof c === "object") delete c.source;
  return out;
}

/** prepack: keep a copy of package.json, then write it without the source conditions. */
export function prepack(root = defaultRoot) {
  const manifest = join(root, "package.json");
  const backup = join(root, BACKUP);
  const text = readFileSync(manifest, "utf8");
  try {
    // wx: a second pack running at the same time, or one that never ran postpack, fails here
    // instead of saving the stripped file as the backup.
    writeFileSync(backup, text, { flag: "wx" });
  } catch (e) {
    if (e?.code !== "EEXIST") throw e;
    throw new Error(`${backup} already exists: another pack is running, or an earlier one stopped before postpack. Put package.json back with: node scripts/pack-manifest.mjs --postpack`);
  }
  const tmp = `${manifest}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(withoutSource(JSON.parse(text)), null, 2)}\n`);
  renameSync(tmp, manifest);
}

/** postpack: put the backup back. Fails when there is none, so a lost backup is never silent. */
export function postpack(root = defaultRoot) {
  const backup = join(root, BACKUP);
  if (!existsSync(backup)) {
    throw new Error(`${backup} is missing, so package.json was not put back. Check that its exports still have their "source" conditions (git diff package.json).`);
  }
  renameSync(backup, join(root, "package.json"));
}

/** For the build: put back a backup an interrupted pack left. Returns true when it did. */
export function restoreManifest(root = defaultRoot) {
  if (!existsSync(join(root, BACKUP))) return false;
  postpack(root);
  return true;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.includes("--prepack")) prepack();
    else if (process.argv.includes("--postpack")) postpack();
    else throw new Error("usage: node scripts/pack-manifest.mjs --prepack | --postpack");
  } catch (e) {
    console.error(`pack-manifest: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
}
