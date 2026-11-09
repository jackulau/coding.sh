// `coding.sh eval trigger <skill> --draft`: write a triggers.toml (see
// trigger.ts) from the skill's SKILL.md, its sibling skills and the user's own
// captured sessions.
//
//   mined positives   the first prompt of each root session that loaded the skill
//   mined negatives   the first prompt of each root session that loaded a sibling
//                     skill and not this one, with expect_skill = that sibling
//   drafted           one model call fills each side to n: implicit positives that
//                     avoid the skill's name, near misses that share its words, and
//                     prompts a sibling owns
//
// Mined prompts are redacted (core/redact.ts) and cut to 500 characters. The
// model's reply is cached by content hash, so an unchanged rerun makes no call.
// Microsoft waza `suggest` drafts from SKILL.md only; real prompts that loaded
// the skill (or its neighbour) are the hard cases a model doesn't think of.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { sha256Hex } from "../core/ids.ts";
import { createRedactor, type Redactor } from "../core/redact.ts";
import { isRealPrompt } from "../core/sessions.ts";
import { SKILL_TAG_PREFIX } from "../core/skills-use.ts";
import type { IndexStore } from "../core/types.ts";
import type { JudgeCache } from "../judge/cache.ts";
import { extractJson } from "../judge/extract.ts";
import type { ChatProvider } from "../judge/providers.ts";
import { DraftError } from "./draft.ts";
import { sameSkill, skillFrontmatter, type SkillSource } from "./trigger.ts";

export const DRAFT_N = 8;
export const MINE_SINCE_MS = 90 * 86_400_000;
export const MINE_LIMIT = 20;
export const MINED_MAX_CHARS = 500;
const BODY_MAX = 4096;

export interface SkillCard {
  name: string;
  description: string;
  /** The first 4 KB of SKILL.md after the frontmatter. */
  body: string;
}

/** Name, description and the start of the body of a skill directory. */
export async function skillCard(skill: Pick<SkillSource, "dir" | "name" | "description">): Promise<SkillCard> {
  const text = await readFile(join(skill.dir, "SKILL.md"), "utf8").catch(() => "");
  const body = skillFrontmatter(text) ? text.replace(/^﻿?---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, "") : text;
  return { name: skill.name, description: skill.description, body: body.trim().slice(0, BODY_MAX) };
}

export interface DraftPrompt {
  prompt: string;
  /** `trace:<session id>` or `draft`. */
  source: string;
  /** Why the prompt belongs on its side. */
  note?: string;
  /** should_not: the sibling skill this prompt belongs to. */
  expectSkill?: string;
}

export interface MinedPrompts {
  should: DraftPrompt[];
  shouldNot: DraftPrompt[];
  /** Root sessions looked at. */
  sessions: number;
}

const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

function cut(s: string, max = MINED_MAX_CHARS): string {
  const t = s.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Prompts from captured sessions: the first real user prompt of each root session
 * (newest first) that loaded `skill` (a positive) or a sibling but not `skill`
 * (a negative that expects the sibling). Skill use comes from the sessions'
 * `skill:<name>` tags, so only matching sessions' events are read.
 */
export async function mineTriggerPrompts(
  index: IndexStore,
  o: { skill: string; siblings: readonly string[]; since?: number; limit?: number; now?: number; redactor?: Redactor },
): Promise<MinedPrompts> {
  const now = o.now ?? Date.now();
  const since = now - (o.since ?? MINE_SINCE_MS);
  const limit = o.limit ?? MINE_LIMIT;
  const red = o.redactor ?? createRedactor();
  const sessions = (await index.listSessions({ parentSessionId: null, runId: null, since })).filter((s) => !s.parent && !s.runId && s.startedAt >= since).sort((a, b) => b.startedAt - a.startedAt || a.id.localeCompare(b.id));
  const out: MinedPrompts = { should: [], shouldNot: [], sessions: sessions.length };
  const seen = new Set<string>();
  for (const s of sessions) {
    if (out.should.length >= limit && out.shouldNot.length >= limit) break;
    const used = s.flags.filter((f) => f.startsWith(SKILL_TAG_PREFIX)).map((f) => f.slice(SKILL_TAG_PREFIX.length));
    if (!used.length) continue;
    const positive = used.some((u) => sameSkill(u, o.skill));
    const sibling = positive ? undefined : o.siblings.find((n) => used.some((u) => sameSkill(u, n)));
    if (!positive && !sibling) continue;
    if (positive ? out.should.length >= limit : out.shouldNot.length >= limit) continue;
    const first = (await index.listEvents(s.id, { kinds: ["user.message"] })).find(isRealPrompt);
    if (!first) continue;
    const prompt = cut(red.string(String(first.payload.text)));
    const key = norm(prompt);
    if (!prompt || seen.has(key)) continue;
    seen.add(key);
    const source = `trace:${s.id}`;
    if (positive) out.should.push({ prompt, source, note: `loaded ${o.skill} in a captured session` });
    else out.shouldNot.push({ prompt, source, note: `loaded ${sibling} in a captured session`, expectSkill: sibling! });
  }
  return out;
}

const SYSTEM = `You write routing tests for an agent skill: prompts where a coding agent should load the skill, and prompts where it should not.
Rules:
- Write prompts the way a real user types them to a coding agent, one request each, under 200 characters.
- "should": requests the skill clearly covers. Most should never name the skill or quote its description: describe the task, not the tool.
- "should_not": near misses that share vocabulary or topic with the skill but need something else, requests another listed skill owns (set "expect_skill" to its name), and a few unrelated requests.
- Never repeat a prompt, including the ones already collected.
- "why": one short sentence on why the prompt belongs on its side.
Reply with JSON only: {"should": [{"prompt": "...", "why": "..."}], "should_not": [{"prompt": "...", "why": "...", "expect_skill": "other-skill"}]}`;

const ITEM = { type: "object", properties: { prompt: { type: "string" }, why: { type: "string" }, expect_skill: { type: "string" } }, required: ["prompt", "why"] };
const SCHEMA: Record<string, unknown> = { type: "object", properties: { should: { type: "array", items: ITEM }, should_not: { type: "array", items: ITEM } }, required: ["should", "should_not"] };

/** Bump when the prompt or parsing changes, so cached replies are not reused. */
export const TRIGGER_DRAFT_VERSION = "trigger-draft@1";

export interface DraftTriggerOpts {
  n?: number;
  provider: ChatProvider;
  cache?: JudgeCache;
  signal?: AbortSignal;
}

export interface DraftedTriggerSpec {
  skill: string;
  should: DraftPrompt[];
  shouldNot: DraftPrompt[];
  /** Model calls made (0 when the cache answered, or mined prompts filled both sides). */
  calls: number;
  warnings: string[];
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

function items(v: unknown): { prompt: string; why?: string; expectSkill?: string }[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((x) => {
    if (typeof x === "string") return str(x) ? [{ prompt: x.trim() }] : [];
    if (!isObj(x) || !str(x.prompt)) return [];
    const why = str(x.why) ?? str(x.note);
    const expectSkill = str(x.expect_skill);
    return [{ prompt: str(x.prompt)!, ...(why ? { why } : {}), ...(expectSkill ? { expectSkill } : {}) }];
  });
}

/** True when the prompt names the skill (its name, or the name with - and _ as spaces). */
export function namesSkill(prompt: string, skill: string): boolean {
  const p = norm(prompt);
  const forms = new Set([norm(skill), norm(skill.replace(/[-_]+/g, " "))].filter((f) => f.length >= 2));
  return [...forms].some((f) => new RegExp(`(^|[^a-z0-9])${f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`).test(p));
}

/**
 * Fill each side to `n` (default 8): mined prompts first (they are never dropped
 * below n), then one model call for the rest. A reply with no usable JSON is
 * asked again once, then DraftError.
 */
export async function draftTriggerSpec(card: SkillCard, siblings: readonly Pick<SkillSource, "name" | "description">[], mined: Pick<MinedPrompts, "should" | "shouldNot">, o: DraftTriggerOpts): Promise<DraftedTriggerSpec> {
  const n = o.n ?? DRAFT_N;
  const seen = new Set<string>();
  const take = (xs: readonly DraftPrompt[]) => xs.filter((p) => !seen.has(norm(p.prompt)) && (seen.add(norm(p.prompt)), true));
  const should = take(mined.should).slice(0, Math.max(n, mined.should.length));
  const shouldNot = take(mined.shouldNot).slice(0, Math.max(n, mined.shouldNot.length));
  const needShould = Math.max(0, n - should.length);
  const needNot = Math.max(0, n - shouldNot.length);
  const warnings: string[] = [];
  let calls = 0;
  if (needShould || needNot) {
    const sib = siblings.slice(0, 20).map((s) => `- ${s.name}: ${s.description.replace(/\s+/g, " ").trim()}`).join("\n");
    const have = [...should.map((p) => `should: ${p.prompt}`), ...shouldNot.map((p) => `should_not: ${p.prompt}`)].join("\n");
    const user = [
      `Skill "${card.name}":\n${card.description.trim()}`,
      card.body ? `Start of its SKILL.md:\n${card.body}` : "",
      sib ? `Other skills the agent has (their prompts belong in should_not, with expect_skill):\n${sib}` : "",
      have ? `Prompts already collected from real sessions (do not repeat them):\n${have}` : "",
      `Write ${needShould} should and ${needNot} should_not prompts.`,
    ]
      .filter(Boolean)
      .join("\n\n");
    const key = sha256Hex(JSON.stringify([TRIGGER_DRAFT_VERSION, o.provider.name, o.provider.model, o.provider.params, SYSTEM, user]));
    const version = `${TRIGGER_DRAFT_VERSION}:${o.provider.name}:${o.provider.model}`;
    const accept = (v: unknown) => isObj(v) && Array.isArray(v.should) && Array.isArray(v.should_not);
    let found: Record<string, unknown> | undefined;
    const cached = await o.cache?.get(version, key);
    if (cached) {
      const v = extractJson(cached.raw, { accept });
      if (isObj(v)) found = v;
    }
    let lastText = "";
    for (let attempt = 0; !found && attempt < 2; attempt++) {
      calls++;
      const r = await o.provider.complete({ system: SYSTEM, user: attempt ? `${user}\n\nYour last reply had no JSON object with "should" and "should_not" arrays. Reply with that JSON only.` : user, jsonSchema: SCHEMA, ...(o.signal ? { signal: o.signal } : {}) });
      lastText = r.text;
      const v = extractJson(r.text, { accept });
      if (isObj(v)) {
        found = v;
        await o.cache?.set(version, key, { score: 1, pass: true, confidence: 1, model: r.model, raw: r.text, ts: Date.now() });
      }
    }
    if (!found) throw new DraftError(`${o.provider.name} ${o.provider.model}: no JSON draft in 2 replies (last: ${JSON.stringify(lastText.slice(0, 120))})`);
    const names = new Set(siblings.map((s) => s.name));
    let unknown = 0;
    for (const d of take(items(found.should).map((x) => ({ prompt: x.prompt, source: "draft", ...(x.why ? { note: x.why } : {}) })))) if (should.length < n) should.push(d);
    const drafts = items(found.should_not).map((x) => {
      const ok = x.expectSkill && names.has(x.expectSkill) && !sameSkill(x.expectSkill, card.name);
      if (x.expectSkill && !ok) unknown++;
      return { prompt: x.prompt, source: "draft", ...(x.why ? { note: x.why } : {}), ...(ok ? { expectSkill: x.expectSkill! } : {}) };
    });
    for (const d of take(drafts)) if (shouldNot.length < n) shouldNot.push(d);
    if (unknown) warnings.push(`dropped expect_skill from ${unknown} drafted prompt(s): not a sibling skill`);
  }
  if (!should.length || !shouldNot.length) throw new DraftError(`the draft needs both should and should_not prompts (got ${should.length} and ${shouldNot.length})`);
  const named = should.filter((p) => namesSkill(p.prompt, card.name)).length;
  if (named * 2 >= should.length) warnings.push(`${named} of ${should.length} should prompts name the skill: too easy, activation will look perfect. Rewrite them to describe the task instead`);
  if (should.length < n || shouldNot.length < n) warnings.push(`only ${should.length} should and ${shouldNot.length} should_not prompts (asked for ${n})`);
  return { skill: card.name, should, shouldNot, calls, warnings };
}

const q = (s: string) => JSON.stringify(s);

/** triggers.toml text for a drafted spec; parseTriggerSpec reads it back. */
export function renderTriggerToml(d: Pick<DraftedTriggerSpec, "skill" | "should" | "shouldNot">, o: { version: string; date: string }): string {
  const lines = [`# drafted by coding.sh ${o.version} ${o.date}: review before trusting`, `# source = "trace:<session>" came from a captured session; "draft" was written by a model.`, `skill = ${q(d.skill)}`, ""];
  const table = (side: "should" | "should_not", p: DraftPrompt) => {
    lines.push(`[[${side}]]`, `prompt = ${q(p.prompt)}`, `source = ${q(p.source)}`);
    if (p.note) lines.push(`note = ${q(p.note)}`);
    if (p.expectSkill) lines.push(`expect_skill = ${q(p.expectSkill)}`);
    lines.push("");
  };
  for (const p of d.should) table("should", p);
  for (const p of d.shouldNot) table("should_not", p);
  return lines.join("\n");
}
