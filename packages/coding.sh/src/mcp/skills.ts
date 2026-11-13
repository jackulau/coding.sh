// Agent Skills served over MCP (SEP-2640, extension io.modelcontextprotocol/skills):
// the folders under packages/coding.sh/skills, one resource per file at
// skill://<name>/<path>. skills/list and skills/get return each skill's verbatim
// frontmatter and a manifest of its files with SHA-256 digests and sizes; a host
// checks every file it reads against that manifest, so the digests are computed
// from the exact bytes resources/read returns.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ResourceDef, SkillEntry, SkillProvider } from "./protocol.ts";

export const SKILL_SCHEME = "skill://";
const DIRECTORY_MIME = "inode/directory";

/** Per-skill limits every conforming host accepts (SEP-2640 "Limits"), and the SKILL.md size Claude Code reads. */
export const SKILL_LIMITS = { files: 512, bytes: 16 * 1024 * 1024, skillMdBytes: 1024 * 1024, uriBytes: 2048 } as const;

/**
 * Every skill file, by its path under skills/. The bundle inlines each one (esbuild `.md: text`);
 * from source the import fails and the file is read from disk. test/mcp/skills.test.ts checks
 * that this list is the folder's contents.
 */
const SOURCES: Record<string, () => Promise<{ default: string }>> = {
  "build-agent-evals/SKILL.md": () => import("../../skills/build-agent-evals/SKILL.md"),
  "improve-agent-setup/SKILL.md": () => import("../../skills/improve-agent-setup/SKILL.md"),
  "review-agent-session/SKILL.md": () => import("../../skills/review-agent-session/SKILL.md"),
  "review-agent-session/references/flags.md": () => import("../../skills/review-agent-session/references/flags.md"),
  "trim-agent-setup/SKILL.md": () => import("../../skills/trim-agent-setup/SKILL.md"),
};

export const SKILL_SOURCES: readonly string[] = Object.keys(SOURCES);

async function sourceText(rel: string): Promise<string> {
  let text: string;
  try {
    text = (await SOURCES[rel]!()).default;
  } catch {
    text = readFileSync(new URL(`../../skills/${rel}`, import.meta.url), "utf8");
  }
  // One byte sequence on every platform, whatever the checkout's line endings.
  return text.replace(/\r\n/g, "\n");
}

// ------------------------------------------------------------ frontmatter

/** Agent Skills naming rules: lowercase letters, digits and single hyphens, at most 64 characters. Ours start with a letter. */
const NAME_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
/** Words YAML reads as a boolean or null, not as text. */
const YAML_WORDS = new Set(["true", "false", "yes", "no", "on", "off", "null", "y", "n"]);

/**
 * A frontmatter value as the string YAML reads it as, or undefined when a YAML parser could read
 * anything else. Two forms are taken: a JSON string in double quotes (YAML's double-quoted scalar
 * reads JSON's escapes the same way), and a plain scalar that starts with a letter and holds no
 * `: `, ` #`, tab or trailing colon.
 */
function yamlString(raw: string): string | undefined {
  if (raw.startsWith('"')) {
    try {
      const v: unknown = JSON.parse(raw);
      return typeof v === "string" ? v : undefined;
    } catch {
      return undefined;
    }
  }
  if (!/^[A-Za-z]/.test(raw) || raw !== raw.trim()) return undefined;
  if (/: | #|\t|:$/.test(raw) || YAML_WORDS.has(raw.toLowerCase())) return undefined;
  return raw;
}

/**
 * A SKILL.md's frontmatter as the JSON object a YAML parser gives. The host parses the YAML itself
 * and compares it with this object field by field, so only forms that read the same both ways are
 * accepted: one `key: value` per line with a string value. Anything else is a problem, not a guess.
 */
export function parseFrontmatter(text: string): { frontmatter: Record<string, string> } | { problem: string } {
  const lines = text.split("\n");
  if (lines[0] !== "---") return { problem: "does not start with a --- frontmatter line" };
  const end = lines.indexOf("---", 1);
  if (end < 0) return { problem: "frontmatter has no closing --- line" };
  const frontmatter: Record<string, string> = {};
  for (const line of lines.slice(1, end)) {
    const m = /^([a-z][a-z0-9-]*): (.+)$/.exec(line);
    if (!m) return { problem: `frontmatter line is not "key: value": ${JSON.stringify(line)}` };
    const value = yamlString(m[2]!);
    if (value === undefined) return { problem: `frontmatter value of ${m[1]} is not a quoted string or a plain one: ${JSON.stringify(m[2])}` };
    if (m[1]! in frontmatter) return { problem: `frontmatter repeats ${m[1]}` };
    frontmatter[m[1]!] = value;
  }
  return { frontmatter };
}

// ------------------------------------------------------------ loading

export interface SkillFile {
  uri: string;
  /** Path inside the skill's folder: "SKILL.md", "references/flags.md". */
  path: string;
  mimeType: string;
  text: string;
  digest: string;
  size: number;
}

export interface LoadedSkill {
  name: string;
  /** The skill's directory URI: skill://<name>. */
  root: string;
  entry: SkillEntry;
  files: SkillFile[];
}

const MIME: Record<string, string> = { md: "text/markdown", json: "application/json", txt: "text/plain" };
const mimeOf = (path: string): string => MIME[path.slice(path.lastIndexOf(".") + 1).toLowerCase()] ?? "text/plain";
/** A path whose every segment is plain: it needs no percent-encoding and holds no `$`, which a host reads as a placeholder. */
const PATH_RE = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

function fileOf(name: string, path: string, text: string): SkillFile {
  const bytes = Buffer.from(text, "utf8");
  return { uri: `${SKILL_SCHEME}${name}/${path}`, path, mimeType: mimeOf(path), text, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, size: bytes.length };
}

/** What stops a host from loading this skill, or undefined. */
function problemOf(name: string, files: SkillFile[], fm: Record<string, string> | undefined, fmProblem: string | undefined): string | undefined {
  if (!NAME_RE.test(name) || name.length > 64) return "its folder name is not a valid skill name";
  const md = files.find((f) => f.path === "SKILL.md");
  if (!md) return "it has no SKILL.md";
  if (fmProblem || !fm) return `SKILL.md ${fmProblem}`;
  if (fm.name !== name) return `frontmatter name ${JSON.stringify(fm.name)} is not its folder name`;
  if (!fm.description || fm.description.length > 1024) return "frontmatter description is missing or over 1024 characters";
  if (md.size > SKILL_LIMITS.skillMdBytes) return "SKILL.md is over 1 MB";
  if (files.length > SKILL_LIMITS.files) return `it has more than ${SKILL_LIMITS.files} files`;
  if (files.reduce((n, f) => n + f.size, 0) > SKILL_LIMITS.bytes) return "it is larger than 16 MiB";
  const bad = files.find((f) => !PATH_RE.test(f.path) || f.path.split("/").some((s) => s === "." || s === "..") || Buffer.byteLength(f.uri) > SKILL_LIMITS.uriBytes);
  if (bad) return `file path ${JSON.stringify(bad.path)} needs encoding or is too long`;
  return undefined;
}

/**
 * Skills from `sources` (path under skills/ → text). A skill a host would refuse is left out and
 * named in `problems`.
 */
export function buildSkills(sources: ReadonlyMap<string, string>): { skills: LoadedSkill[]; problems: string[] } {
  const byName = new Map<string, SkillFile[]>();
  for (const [rel, text] of [...sources].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const cut = rel.indexOf("/");
    const name = rel.slice(0, cut);
    const list = byName.get(name) ?? [];
    list.push(fileOf(name, rel.slice(cut + 1), text));
    byName.set(name, list);
  }
  const skills: LoadedSkill[] = [];
  const problems: string[] = [];
  for (const [name, all] of byName) {
    // SKILL.md first, then the rest by path.
    const files = [...all.filter((f) => f.path === "SKILL.md"), ...all.filter((f) => f.path !== "SKILL.md")];
    const parsed = files[0]?.path === "SKILL.md" ? parseFrontmatter(files[0].text) : undefined;
    const fm = parsed && "frontmatter" in parsed ? parsed.frontmatter : undefined;
    const problem = problemOf(name, files, fm, parsed && "problem" in parsed ? parsed.problem : undefined);
    if (problem || !fm) {
      problems.push(`skill ${name}: ${problem}`);
      continue;
    }
    const root = `${SKILL_SCHEME}${name}`;
    skills.push({
      name,
      root,
      files,
      entry: { uri: `${root}/SKILL.md`, frontmatter: fm, resources: files.map((f) => ({ uri: f.uri, digest: f.digest, size: f.size })) },
    });
  }
  return { skills, problems };
}

let loaded: Promise<{ skills: LoadedSkill[]; problems: string[] }> | undefined;

/** The skills this build ships, read once. */
export function loadSkills(): Promise<{ skills: LoadedSkill[]; problems: string[] }> {
  loaded ??= (async () => {
    const sources = new Map<string, string>();
    for (const rel of SKILL_SOURCES) sources.set(rel, await sourceText(rel));
    return buildSkills(sources);
  })();
  return loaded;
}

// ------------------------------------------------------------ provider

/** Direct children of the directory `dir` among `files`: files as they are, deeper paths as one directory each. */
function childrenOf(skill: LoadedSkill, dir: string): ResourceDef[] | undefined {
  const prefix = dir === skill.root ? "" : `${dir.slice(skill.root.length + 1)}/`;
  const out = new Map<string, ResourceDef>();
  for (const f of skill.files) {
    if (!f.path.startsWith(prefix)) continue;
    const rest = f.path.slice(prefix.length);
    const cut = rest.indexOf("/");
    const name = cut < 0 ? rest : rest.slice(0, cut);
    const uri = `${skill.root}/${prefix}${name}`;
    if (!out.has(uri)) out.set(uri, cut < 0 ? resourceOf(skill, f) : { uri, name, mimeType: DIRECTORY_MIME });
  }
  return out.size ? [...out.values()] : undefined;
}

/** Resource metadata of one file: a SKILL.md carries the skill's name and description. */
function resourceOf(skill: LoadedSkill, f: SkillFile): ResourceDef {
  if (f.path !== "SKILL.md") return { uri: f.uri, name: f.path.slice(f.path.lastIndexOf("/") + 1), mimeType: f.mimeType };
  return { uri: f.uri, name: skill.name, description: String(skill.entry.frontmatter.description), mimeType: f.mimeType };
}

/** The skills extension's answers, from `load` (default: the skills this build ships). */
export function buildSkillProvider(log: (m: string) => void = () => {}, load: typeof loadSkills = loadSkills): SkillProvider {
  let warned = false;
  const skills = async (): Promise<LoadedSkill[]> => {
    // resources/list and resources/read ask here first: a load that fails serves no skills, and
    // the sessions still answer.
    const r = await load().catch((e: unknown) => ({ skills: [], problems: [`skills did not load: ${e instanceof Error ? e.message : String(e)}`] }));
    if (r.problems.length && !warned) {
      warned = true;
      for (const p of r.problems) log(`not served: ${p}`);
    }
    return r.skills;
  };
  const owner = (all: LoadedSkill[], uri: string) => all.find((s) => uri === s.root || uri.startsWith(`${s.root}/`));
  return {
    async list() {
      return (await skills()).map((s) => s.entry);
    },
    async get(uri) {
      return (await skills()).find((s) => s.entry.uri === uri)?.entry;
    },
    async resources() {
      return (await skills()).map((s) => resourceOf(s, s.files[0]!));
    },
    async read(uri) {
      const all = await skills();
      const f = owner(all, uri)?.files.find((x) => x.uri === uri);
      return f ? { uri: f.uri, mimeType: f.mimeType, text: f.text } : undefined;
    },
    async directory(uri) {
      const all = await skills();
      const s = owner(all, uri);
      // A file is not a directory; a path under no file is not one either.
      if (!s || s.files.some((f) => f.uri === uri)) return undefined;
      return childrenOf(s, uri);
    },
  };
}
