// Commit-reveal seeds (seed = "secret"). With a public source, a date seed
// lets anyone compute tomorrow's sample and prepare for it. Here each date's
// salt is an HMAC of the date under a key only the runner has (an env var,
// e.g. a CI secret), so nothing secret is stored next to the run records:
//
//   salt(D)       = HMAC-SHA256(key, "<name>:<D>")
//   seed(D)       = "<name>:<D>:<salt(D)>"
//   commitment(D) = sha256(salt(D))
//
// Run D reveals salt(D) and publishes commitment(D+1). Anyone can then check
// that run D+1's revealed salt hashes to what was published a day earlier,
// so its sample was fixed before the run and not picked after looking.
import { createHash, createHmac } from "node:crypto";
import type { BenchRun, SeedCommit } from "./types.ts";

export function saltFor(key: string, name: string, date: string): string {
  return createHmac("sha256", key).update(`${name}:${date}`).digest("hex");
}

export function commitmentOf(salt: string): string {
  return createHash("sha256").update(salt).digest("hex");
}

export function secretSeed(name: string, date: string, salt: string): string {
  return `${name}:${date}:${salt}`;
}

export function nextDate(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + 86400e3).toISOString().slice(0, 10);
}

/** The seed and the commit record for one date (and the commitment for the day after). */
export function commitFor(key: string, name: string, date: string): { seed: string; commit: SeedCommit } {
  const salt = saltFor(key, name, date);
  const next = nextDate(date);
  return { seed: secretSeed(name, date, salt), commit: { salt, commitment: commitmentOf(salt), next: { date: next, commitment: commitmentOf(saltFor(key, name, next)) } } };
}

/** The seed as shown before a run: the salt stays hidden. */
export function maskSeed(seed: string, commit?: SeedCommit): string {
  return commit ? seed.replace(commit.salt, `<salt sha256 ${commit.commitment.slice(0, 12)}…>`) : seed;
}

export interface SeedCheck {
  ok: boolean;
  /** Whether a run before this one published the commitment for this date. */
  publishedBy?: { run: string; date: string };
  checks: { name: string; ok: boolean; detail: string }[];
}

/**
 * Verify a run's revealed salt: it hashes to the commitment, it produces the
 * recorded seed, and (when an earlier run published one for this date) it
 * matches what was published in advance. Undefined for runs without a secret seed.
 */
export function verifySeed(run: BenchRun, all: readonly BenchRun[]): SeedCheck | undefined {
  const c = run.seedCommit;
  if (!c) return undefined;
  const checks: SeedCheck["checks"] = [];
  const hashOk = commitmentOf(c.salt) === c.commitment;
  checks.push({ name: "salt", ok: hashOk, detail: hashOk ? `sha256(salt) = ${c.commitment.slice(0, 16)}…` : "sha256 of the revealed salt does not match the commitment" });
  const seedOk = run.seed === secretSeed(run.bench, run.date, c.salt);
  checks.push({ name: "seed", ok: seedOk, detail: seedOk ? "the seed is name:date:salt" : "the recorded seed was not built from this salt" });
  const earlier = all.filter((r) => r.id !== run.id && r.startedAt < run.startedAt && r.seedCommit?.next?.date === run.date).sort((a, b) => a.startedAt - b.startedAt);
  const pub = earlier[0];
  let publishedBy: SeedCheck["publishedBy"];
  if (pub) {
    const same = pub.seedCommit!.next!.commitment === c.commitment;
    publishedBy = { run: pub.id, date: pub.date };
    checks.push({ name: "published", ok: same, detail: same ? `published in advance by run ${pub.id} (${pub.date})` : `run ${pub.id} (${pub.date}) published a different commitment for ${run.date}` });
  } else checks.push({ name: "published", ok: true, detail: "no earlier run published a commitment for this date (first secret-seed run, or history is missing)" });
  return { ok: checks.every((x) => x.ok), ...(publishedBy ? { publishedBy } : {}), checks };
}
