// The Agent Skills the MCP server serves (SEP-2640, io.modelcontextprotocol/skills). A host loads
// a skill only when its listing entry, its files and its frontmatter agree, so these tests act as
// that host against the server from source and against the bundle that ships.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { bundle } from "../../scripts/bundle.mjs";
import { McpServer, SKILLS_EXTENSION, type SkillEntry } from "../../src/mcp/protocol.ts";
import { buildSkillProvider, buildSkills, loadSkills, parseFrontmatter, SKILL_LIMITS, SKILL_SOURCES } from "../../src/mcp/skills.ts";
import { buildTools } from "../../src/mcp/tools.ts";
import { PKG, RawClient, cleanup, makeWorld, seed, type Rpc, type World } from "./helpers.ts";

const META = "io.modelcontextprotocol/";
const modernMeta = { [`${META}protocolVersion`]: "2026-07-28", [`${META}clientCapabilities`]: {}, [`${META}clientInfo`]: { name: "t", version: "0" } };
const SKILLS_DIR = join(PKG, "skills");
const NAMES = ["build-agent-evals", "improve-agent-setup", "review-agent-session", "trim-agent-setup"];
/** The Agent Skills naming rules, as the SEP-2640 conformance suite checks them. */
const NAME_RE = /^(?!.*--)[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/;

type Resource = { uri: string; name: string; description?: string; mimeType?: string };

/** Every property name a JSON Schema declares, at any depth. */
function propsOf(schema: unknown, out = new Set<string>()): Set<string> {
  if (schema && typeof schema === "object") {
    for (const [k, v] of Object.entries(schema)) {
      if (k === "properties" && v && typeof v === "object") for (const p of Object.keys(v)) out.add(p);
      propsOf(v, out);
    }
  }
  return out;
}
/** The verdicts of src/improve/changes.ts. */
const VERDICTS = [.../export type Verdict = ([^;]+);/.exec(readFileSync(join(PKG, "src", "improve", "changes.ts"), "utf8"))![1]!.matchAll(/"([a-z-]+)"/g)].map((m) => m[1]!);
/**
 * Names no tool schema declares: `pending` is added to any result by the server
 * (src/mcp/server.ts), the rest are the memory audit's file flags and plain words in backticks.
 */
const UNSCHEMAED = ["pending", "never-read", "write-only", "loaded-not-read"];
type Send = (method: string, params?: Record<string, unknown>) => Promise<Rpc>;

function filesUnder(dir: string, prefix = ""): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? filesUnder(join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`]))
    .sort();
}

const ok = async (send: Send, method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> => {
  const r = await send(method, params);
  assert.equal(r.error, undefined, `${method}: ${r.error?.message}`);
  return r.result!;
};

/**
 * What a host does before it loads a skill: validates each skills/list entry, reads every file it
 * lists and checks size and digest, and compares the SKILL.md's frontmatter with the entry's.
 * Returns the entries.
 */
async function loadAsHost(send: Send): Promise<SkillEntry[]> {
  const listed = (await ok(send, "skills/list")).skills as SkillEntry[];
  assert.deepEqual(listed.map((s) => s.frontmatter.name), NAMES);
  for (const entry of listed) {
    assert.ok(entry.uri.endsWith("/SKILL.md"), entry.uri);
    const root = entry.uri.slice(0, -"/SKILL.md".length);
    const name = String(entry.frontmatter.name);
    assert.equal(root, `skill://${name}`, "the last path segment is the skill's name");
    assert.match(name, NAME_RE);
    assert.ok(typeof entry.frontmatter.description === "string" && entry.frontmatter.description.length > 0);
    // Nothing a host ignores or gates for a skill that arrives over MCP.
    assert.equal("allowed-tools" in entry.frontmatter, false);
    assert.ok(Array.isArray(entry.resources), "a file list, not \"dynamic\": some hosts decline dynamic skills");
    assert.ok(entry.resources.length <= SKILL_LIMITS.files);
    assert.ok(entry.resources.reduce((n, r) => n + r.size, 0) <= SKILL_LIMITS.bytes);
    const uris = entry.resources.map((r) => r.uri);
    assert.equal(new Set(uris).size, uris.length, "each file once");
    assert.ok(uris.includes(entry.uri), "the file list holds SKILL.md");
    for (const r of entry.resources) {
      assert.ok(r.uri.startsWith(`${root}/`), `${r.uri} is inside the skill`);
      assert.ok(Buffer.byteLength(r.uri) <= SKILL_LIMITS.uriBytes && !r.uri.includes("$"));
      assert.match(r.digest, /^sha256:[0-9a-f]{64}$/);
      const contents = (await ok(send, "resources/read", { uri: r.uri })).contents as { uri: string; mimeType: string; text: string }[];
      assert.equal(contents.length, 1, "exactly the one file");
      assert.equal(contents[0]!.uri, r.uri);
      const bytes = Buffer.from(contents[0]!.text, "utf8");
      assert.equal(bytes.length, r.size, `${r.uri}: size`);
      assert.equal(`sha256:${createHash("sha256").update(bytes).digest("hex")}`, r.digest, `${r.uri}: digest`);
      assert.equal(contents[0]!.text.includes("\r"), false, "LF on every platform");
      if (r.uri === entry.uri) {
        assert.equal(contents[0]!.mimeType, "text/markdown");
        assert.ok(r.size <= SKILL_LIMITS.skillMdBytes);
        const parsed = parseFrontmatter(contents[0]!.text);
        assert.deepEqual("frontmatter" in parsed ? parsed.frontmatter : parsed, entry.frontmatter, "the entry's frontmatter is the file's");
      }
    }
    assert.deepEqual((await ok(send, "skills/get", { uri: entry.uri })).skill, entry, "skills/get returns the listed entry");
  }
  return listed;
}

// ------------------------------------------------------------ the skill folders

describe("the shipped skills", () => {
  it("registers every file under skills/, so the bundle holds what the folder holds", () => {
    assert.deepEqual([...SKILL_SOURCES].sort(), filesUnder(SKILLS_DIR));
  });

  it("loads all of them with nothing a host would refuse", async () => {
    const { skills, problems } = await loadSkills();
    assert.deepEqual(problems, []);
    assert.deepEqual(skills.map((s) => s.name), NAMES);
    for (const s of skills) assert.equal(s.files[0]!.path, "SKILL.md");
  });

  it("says in each description what the skill does and when to use it", async () => {
    for (const s of (await loadSkills()).skills) {
      const d = String(s.entry.frontmatter.description);
      assert.match(d, /\. Use when /, `${s.name}: what it does, then "Use when"`);
      assert.ok(d.length <= 1024, `${s.name}: ${d.length} characters`);
      // The listing is in the model's context on every turn.
      assert.ok(s.files[0]!.size < 8000, `${s.name}: SKILL.md is ${s.files[0]!.size} bytes`);
    }
  });

  it("names only tools, arguments and result fields the server has", async () => {
    const tools = new Map(buildTools().map((t) => [t.name, propsOf([t.inputSchema, t.outputSchema])]));
    // Results whose schema is open: the fields are the keys the file that builds them writes.
    const keysIn = (file: string) => [...readFileSync(join(PKG, "src", "mcp", file), "utf8").matchAll(/\b([A-Za-z]+):/g)].map((m) => m[1]!);
    const open: Record<string, string[]> = { improve: keysIn("improve.ts"), session_get: keysIn("data.ts"), harness_audit: keysIn("audit.ts") };
    for (const s of (await loadSkills()).skills) {
      const ticks = [...s.files[0]!.text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]!);
      const named = ticks.filter((t) => tools.has(t));
      assert.ok(named.length > 0, `${s.name} names no tool`);
      // snake_case in backticks is a tool name.
      for (const t of ticks) if (/^[a-z]+(_[a-z]+)+$/.test(t)) assert.ok(tools.has(t), `${s.name}: no tool named ${t}`);
      const fields = new Set([...named.flatMap((t) => [...tools.get(t)!, ...(open[t] ?? [])]), ...VERDICTS, ...UNSCHEMAED]);
      for (const t of ticks) {
        // `key`, `key.sub` and `key: value` in backticks are arguments or result fields of a tool the skill names.
        const m = /^([A-Za-z]+(?:\.[A-Za-z]+)*)(?:: .+)?$/.exec(t);
        if (!m || tools.has(t)) continue;
        for (const part of m[1]!.split(".")) assert.ok(fields.has(part), `${s.name}: no tool it names takes or returns \`${part}\` (in \`${t}\`)`);
      }
    }
  });

  it("names every required argument where it says to call a tool with arguments", async () => {
    const required = new Map(buildTools().map((t) => [t.name, (t.inputSchema.required ?? []) as string[]]));
    let checked = 0;
    for (const s of (await loadSkills()).skills) {
      // One list item or paragraph at a time.
      for (const item of s.files[0]!.text.split(/\n(?=\s*(?:\d+\.|-) )|\n\n/)) {
        for (const m of item.matchAll(/`([a-z_]+)` with /g)) {
          if (!required.has(m[1]!)) continue;
          checked++;
          const given = new Set([...item.matchAll(/`([A-Za-z]+)(?:: [^`]+)?`/g)].map((x) => x[1]!));
          const missing = required.get(m[1]!)!.filter((a) => !given.has(a));
          assert.deepEqual(missing, [], `${s.name}: the call to ${m[1]} leaves out ${missing.join(", ")}: ${item.trim().slice(0, 80)}`);
        }
      }
    }
    assert.ok(checked >= 8, `only ${checked} calls were checked`);
  });

  it("explains every verdict harness_changes can return", async () => {
    const md = (await loadSkills()).skills.find((s) => s.name === "improve-agent-setup")!.files[0]!.text;
    assert.deepEqual([...md.matchAll(/^\| `([a-z-]+)` \|/gm)].map((m) => m[1]!).sort(), [...VERDICTS].sort());
  });

  it("resolves every relative file a SKILL.md points at", async () => {
    for (const s of (await loadSkills()).skills) {
      const paths = new Set(s.files.map((f) => f.path));
      for (const m of s.files[0]!.text.matchAll(/`((?:references|scripts|assets)\/[^`\s]+)`/g)) assert.ok(paths.has(m[1]!), `${s.name}: ${m[1]} is not in the skill`);
    }
  });

  it("is listed, every skill, on the MCP docs page", () => {
    const page = readFileSync(join(PKG, "..", "..", "apps", "site", "src", "pages", "docs", "mcp.astro"), "utf8");
    const listed = [...page.matchAll(/^  \["([a-z-]+)", "/gm)].map((m) => m[1]!).filter((n) => n.includes("-"));
    assert.deepEqual(listed.sort(), NAMES);
  });

  it("lists only flags and derails the reference documents", async () => {
    const reference = readFileSync(join(PKG, "..", "..", "docs", "reference", "query.md"), "utf8");
    const flags = readFileSync(join(SKILLS_DIR, "review-agent-session", "references", "flags.md"), "utf8");
    const rows = [...flags.matchAll(/^\| `([a-z-]+)` \|/gm)].map((m) => m[1]!);
    assert.ok(rows.length >= 16);
    for (const f of rows) assert.ok(reference.includes(`\`${f}\``), `${f} is not in docs/reference/query.md`);
  });
});

// ------------------------------------------------------------ frontmatter and limits

describe("skill frontmatter", () => {
  const md = (front: string) => `---\n${front}\n---\n\n# Body\n`;

  it("reads a quoted string and a plain one as YAML does", () => {
    assert.deepEqual(parseFrontmatter(md('name: pdf-forms\ndescription: "Fills forms: \\"all\\" of them. Use when asked."\nlicense: MIT')), {
      frontmatter: { name: "pdf-forms", description: 'Fills forms: "all" of them. Use when asked.', license: "MIT" },
    });
  });

  it("refuses a value a YAML parser could read another way", () => {
    for (const front of [
      "name: pdf\ndescription: Use when: the user asks", // a second colon starts a mapping
      "name: pdf\ndescription: Fills forms # fast", // a comment
      "name: pdf\ndescription: true", // a boolean
      "name: pdf\ndescription: 2024", // a number
      "name: pdf\ndescription: >\n  folded text", // a block scalar
      "name: pdf\ndescription: 'single quoted'",
      "name: pdf\ndescription: [a, b]",
      "name: pdf\ndescription: ok\nmetadata:\n  version: 1", // a nested mapping
      "name: pdf\nname: pdf\ndescription: ok",
      'name: pdf\ndescription: "unterminated',
    ]) {
      assert.ok("problem" in parseFrontmatter(md(front)), front);
    }
    assert.ok("problem" in parseFrontmatter("# No frontmatter\n"));
    assert.ok("problem" in parseFrontmatter("---\nname: pdf\n"));
  });

  it("leaves out a skill a host would refuse, and says why", () => {
    const good = '---\nname: NAME\ndescription: "Does a thing. Use when asked."\n---\n';
    const built = (files: Record<string, string>) => buildSkills(new Map(Object.entries(files)));
    assert.deepEqual(built({ "pdf/SKILL.md": good.replace("NAME", "pdf") }).problems, []);
    const refused: [string, Record<string, string>][] = [
      ["not its folder name", { "pdf/SKILL.md": good.replace("NAME", "docx") }],
      ["no SKILL.md", { "pdf/README.md": "hi" }],
      ["not a valid skill name", { "PDF/SKILL.md": good.replace("NAME", "PDF") }],
      ["not a valid skill name", { "pdf--x/SKILL.md": good.replace("NAME", "pdf--x") }],
      ["needs encoding", { "pdf/SKILL.md": good.replace("NAME", "pdf"), "pdf/refs/$ARGUMENTS.md": "x" }],
      ["needs encoding", { "pdf/SKILL.md": good.replace("NAME", "pdf"), "pdf/refs/a b.md": "x" }],
      ["over 1024", { "pdf/SKILL.md": good.replace("NAME", "pdf").replace("Does a thing", "x".repeat(1100)) }],
      ["over 1 MB", { "pdf/SKILL.md": good.replace("NAME", "pdf") + "x".repeat(SKILL_LIMITS.skillMdBytes) }],
    ];
    for (const [why, files] of refused) {
      const r = built({ "ok/SKILL.md": good.replace("NAME", "ok"), ...files });
      assert.deepEqual(r.skills.map((s) => s.name), ["ok"], why);
      assert.equal(r.problems.length, 1, why);
      assert.ok(r.problems[0]!.includes(why), `${r.problems[0]} should say: ${why}`);
    }
    const many = Object.fromEntries(Array.from({ length: SKILL_LIMITS.files }, (_, i) => [`pdf/refs/f${i}.md`, "x"]));
    assert.match(built({ "pdf/SKILL.md": good.replace("NAME", "pdf"), ...many }).problems[0]!, /more than 512 files/);
  });

  it("serves the skills that load and logs the ones that do not", async () => {
    const logged: string[] = [];
    const p = buildSkillProvider((m) => logged.push(m), async () => buildSkills(new Map([["bad/SKILL.md", "no frontmatter"], ["ok/SKILL.md", '---\nname: ok\ndescription: "Does. Use when asked."\n---\n']])));
    assert.deepEqual((await p.list()).map((s) => s.uri), ["skill://ok/SKILL.md"]);
    await p.list();
    assert.equal(logged.length, 1, "once, not on every request");
    assert.match(logged[0]!, /skill bad: SKILL\.md does not start with/);
  });
});

// ------------------------------------------------------------ the protocol

describe("MCP skills extension", () => {
  let w: World;
  let c: RawClient;
  let init: Rpc;
  const legacy: Send = (method, params) => c.request(method, params);
  const modern: Send = (method, params) => c.request(method, { ...params, _meta: modernMeta });

  before(async () => {
    w = makeWorld();
    await seed(w);
    c = new RawClient(w.env, w.repo);
    init = await c.initialize("2025-11-25");
  });
  after(async () => {
    await c.close();
    cleanup();
  });

  it("declares the extension next to resources, in initialize and in server/discover", async () => {
    for (const caps of [init.result!.capabilities, (await ok(modern, "server/discover")).capabilities] as Record<string, unknown>[]) {
      assert.deepEqual((caps.extensions as Record<string, unknown>)[SKILLS_EXTENSION], { directoryRead: true });
      assert.ok(caps.resources, "the extension requires the resources capability");
    }
  });

  it("serves every skill so that a host can verify and load it", async () => {
    const entries = await loadAsHost(legacy);
    assert.deepEqual(await loadAsHost(modern), entries, "the same entries in both protocol eras");
    assert.deepEqual(entries.find((e) => e.uri === "skill://review-agent-session/SKILL.md")!.resources.map((r) => r.uri), [
      "skill://review-agent-session/SKILL.md",
      "skill://review-agent-session/references/flags.md",
    ]);
  });

  it("marks skill answers as public in 2026-07-28, only the list as cacheable, and session digests as private", async () => {
    // A host refreshes a stale entry with skills/get and checks its digests against the files it
    // reads next, so neither may come from a cache that an upgrade made old.
    for (const [method, params, ttlMs] of [
      ["skills/list", {}, 3_600_000],
      ["skills/get", { uri: "skill://trim-agent-setup/SKILL.md" }, 0],
      ["resources/read", { uri: "skill://trim-agent-setup/SKILL.md" }, 0],
      ["resources/directory/read", { uri: "skill://trim-agent-setup" }, 0],
    ] as const) {
      const r = await ok(modern, method, params);
      assert.equal(r.resultType, "complete", method);
      assert.deepEqual([r.ttlMs, r.cacheScope], [ttlMs, "public"], method);
    }
    const digest = await ok(modern, "resources/read", { uri: "codingsh://latest" });
    assert.deepEqual([digest.ttlMs, digest.cacheScope], [0, "private"]);
    const plain = await ok(legacy, "skills/list");
    assert.equal("ttlMs" in plain || "resultType" in plain, false, "legacy results carry neither");
  });

  it("answers -32602 for a skill, cursor or directory it does not have", async () => {
    const bad: [string, Record<string, unknown>][] = [
      ["skills/get", { uri: "skill://mcp-conformance-nonexistent-skill-9f3a2b/SKILL.md" }],
      ["skills/get", { uri: "skill://trim-agent-setup" }], // the directory, not the SKILL.md
      ["skills/get", { uri: "skill://review-agent-session/references/flags.md" }], // a file of a skill, not a skill
      ["skills/get", {}],
      ["skills/list", { cursor: "abc" }],
      ["resources/directory/read", { uri: "skill://review-agent-session/SKILL.md" }], // a file
      ["resources/directory/read", { uri: "skill://review-agent-session/" }],
      ["resources/directory/read", { uri: "skill://review-agent-session/nope" }],
      ["resources/directory/read", { uri: "skill://review" }], // a prefix of a name is not its directory
      ["resources/directory/read", { uri: "codingsh://latest" }],
      ["resources/directory/read", { uri: "skill://review-agent-session", cursor: "abc" }],
      ["resources/directory/read", {}],
    ];
    for (const [method, params] of bad) {
      for (const send of [legacy, modern]) assert.equal((await send(method, params)).error?.code, -32602, `${method} ${JSON.stringify(params)}`);
    }
    // An unknown file under skill:// is an unknown resource, as any other URI is.
    assert.equal((await legacy("resources/read", { uri: "skill://trim-agent-setup/nope.md" })).error?.code, -32002);
    assert.equal((await modern("resources/read", { uri: "skill://trim-agent-setup/nope.md" })).error?.code, -32602);
  });

  it("lists a skill directory's direct children, with subdirectories as directories", async () => {
    const top = (await ok(legacy, "resources/directory/read", { uri: "skill://review-agent-session" })).resources as Resource[];
    assert.deepEqual(top.map((r) => [r.uri, r.name, r.mimeType]), [
      ["skill://review-agent-session/SKILL.md", "review-agent-session", "text/markdown"],
      ["skill://review-agent-session/references", "references", "inode/directory"],
    ]);
    assert.match(top[0]!.description!, /^Reads a recorded agent session/);
    const refs = (await ok(legacy, "resources/directory/read", { uri: "skill://review-agent-session/references" })).resources as Resource[];
    assert.deepEqual(refs, [{ uri: "skill://review-agent-session/references/flags.md", name: "flags.md", mimeType: "text/markdown" }]);
  });

  it("puts each SKILL.md on the first page of resources/list, after the sessions, with the skill's name and description", async () => {
    const first = (await ok(legacy, "resources/list")).resources as Resource[];
    const mds = first.filter((r) => r.uri.startsWith("skill://"));
    assert.deepEqual(mds.map((r) => [r.uri, r.name, r.mimeType]), NAMES.map((n) => [`skill://${n}/SKILL.md`, n, "text/markdown"]));
    for (const r of mds) assert.match(r.description!, /\. Use when /);
    assert.equal(first[0]!.uri, "codingsh://latest", "sessions stay first");
    assert.deepEqual(first.slice(-mds.length), mds);
  });

  it("writes only protocol frames to stdout and nothing to stderr", () => {
    for (const line of c.lines) assert.equal((JSON.parse(line) as Rpc).jsonrpc, "2.0");
    assert.equal(c.stderr, "");
  });
});

describe("MCP skills in a paged resources/list", () => {
  it("lists the skills on the first page only", async () => {
    const pages: Record<string, { resources: Resource[]; nextCursor?: string }> = {
      first: { resources: [{ uri: "x://1", name: "1" }], nextCursor: "2" },
      "2": { resources: [{ uri: "x://2", name: "2" }] },
    };
    const server = new McpServer<undefined>({
      serverInfo: { name: "t", version: "0" },
      instructions: () => "",
      tools: [],
      resources: { list: async (cursor) => pages[cursor ?? "first"]!, templates: () => [], read: async () => undefined },
      skills: buildSkillProvider(),
      context: () => undefined,
    });
    const list = async (params: Record<string, unknown>) => (await server.handle({ jsonrpc: "2.0", id: 1, method: "resources/list", params }))!.result as { resources: Resource[]; nextCursor?: string };
    const first = await list({});
    assert.deepEqual(first.resources.map((r) => r.uri), ["x://1", ...NAMES.map((n) => `skill://${n}/SKILL.md`)]);
    assert.equal(first.nextCursor, "2");
    assert.deepEqual(await list({ cursor: "" }), first, "an empty cursor is the first page");
    assert.deepEqual(await list({ cursor: "2" }), pages["2"]);
  });
});

describe("MCP skills that fail to load", () => {
  it("serves none, says why once, and leaves the session resources answering", async () => {
    const logged: string[] = [];
    const server = new McpServer<undefined>({
      serverInfo: { name: "t", version: "0" },
      instructions: () => "",
      tools: [],
      resources: { list: async () => ({ resources: [{ uri: "x://1", name: "1" }] }), templates: () => [], read: async (uri) => (uri === "x://1" ? { uri, mimeType: "text/plain", text: "one" } : undefined) },
      skills: buildSkillProvider((m) => logged.push(m), async () => {
        throw new Error("chunk missing");
      }),
      context: () => undefined,
    });
    const req = async (method: string, params: Record<string, unknown> = {}) => (await server.handle({ jsonrpc: "2.0", id: 1, method, params }))!;
    assert.deepEqual((await req("skills/list")).result, { skills: [] });
    assert.deepEqual((await req("resources/list")).result, { resources: [{ uri: "x://1", name: "1" }] });
    assert.deepEqual((await req("resources/read", { uri: "x://1" })).result, { contents: [{ uri: "x://1", mimeType: "text/plain", text: "one" }] });
    assert.deepEqual(logged, ["not served: skills did not load: chunk missing"]);
  });
});

describe("MCP skills extension without resources", () => {
  it("is not declared, and its methods are not found", async () => {
    const server = new McpServer<undefined>({ serverInfo: { name: "t", version: "0" }, instructions: () => "", tools: [], skills: buildSkillProvider(), context: () => undefined });
    const req = (method: string, params: Record<string, unknown> = {}) => server.handle({ jsonrpc: "2.0", id: 1, method, params });
    const caps = (await req("initialize", { protocolVersion: "2025-11-25" }))!.result!.capabilities as Record<string, unknown>;
    assert.equal("extensions" in caps, false);
    for (const m of ["skills/list", "skills/get", "resources/directory/read"]) assert.equal((await req(m, { uri: "skill://trim-agent-setup/SKILL.md" }))!.error?.code, -32601, m);
  });
});

// ------------------------------------------------------------ the bundle that ships

describe("MCP skills in the built CLI", () => {
  let dist = "";
  let w: World;
  let c: RawClient;

  before(async () => {
    dist = realpathSync(mkdtempSync(join(tmpdir(), "csh-skills-dist-")));
    const built = await bundle(dist);
    w = makeWorld();
    c = new RawClient(w.env, w.repo, [built.cli, "mcp"]);
    await c.initialize("2025-11-25");
  });
  after(async () => {
    await c.close();
    cleanup();
    rmSync(dist, { recursive: true, force: true });
  });

  it("serves the same skills from the bundle, with no skills folder next to it", async () => {
    assert.equal(readdirSync(dist).includes("skills"), false);
    const fromBundle = await loadAsHost((method, params) => c.request(method, params));
    const fromSource = (await loadSkills()).skills.map((s) => s.entry);
    assert.deepEqual(fromBundle, fromSource, "the same bytes, so the same digests");
    assert.equal(c.stderr, "");
  });
});
