#!/usr/bin/env node
// Build the two harness bundles of the A/B: plain Claude Code ("base") and Claude Code with one
// plugin ("plugin").
//
//   node examples/plugin-ab/build-arms.mjs <plugin-dir> <out-dir> [model]
//
// A harness bundle has no plugin slot yet, so the plugin becomes user-level files in the run's
// throwaway CLAUDE_CONFIG_DIR, the way Claude Code would load it:
//   - the whole plugin directory is copied to ~/.claude/ab-plugin/;
//   - its hooks (plugin.json "hooks", or hooks/hooks.json) go into settings.json with
//     ${CLAUDE_PLUGIN_ROOT} pointing at that copy;
//   - its skills/, agents/ and commands/ are copied to ~/.claude/skills, agents and commands.
// MCP servers (.mcp.json) and other plugin parts are not mapped; the script says so.
// Both arms get the same base settings, so the plugin is the only difference.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";

const [pluginArg, outArg, model = "claude-opus-5-5"] = process.argv.slice(2);
if (!pluginArg || !outArg) {
  console.error("usage: build-arms.mjs <plugin-dir> <out-dir> [model]");
  process.exit(2);
}
const plugin = resolve(pluginArg);
const out = resolve(outArg);
const manifestPath = join(plugin, ".claude-plugin", "plugin.json");
if (!existsSync(manifestPath)) {
  console.error(`${plugin} has no .claude-plugin/plugin.json`);
  process.exit(2);
}
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const ROOT = '"$CLAUDE_CONFIG_DIR/ab-plugin"';
const SKIP = new Set([".git", "node_modules", ".DS_Store", "__pycache__"]);

function walk(dir) {
  const files = [];
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name) || name.endsWith(".pyc")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) files.push(...walk(p));
    else files.push(p);
  }
  return files;
}

// Hooks: an inline object or a path in plugin.json, else hooks/hooks.json.
function loadHooks() {
  const h = manifest.hooks;
  if (h && typeof h === "object") return h.hooks ?? h;
  const file = typeof h === "string" ? join(plugin, h) : join(plugin, "hooks", "hooks.json");
  if (!existsSync(file)) return {};
  const doc = JSON.parse(readFileSync(file, "utf8"));
  return doc.hooks ?? doc;
}

// Bundle files are written without their mode bits, so a hook that runs a script directly is
// run through its interpreter instead.
const RUNNER = { ".sh": "sh", ".bash": "bash", ".js": "node", ".mjs": "node", ".cjs": "node", ".py": "python3" };
function mapCommand(cmd) {
  let c = cmd.replaceAll("${CLAUDE_PLUGIN_ROOT}", "$CLAUDE_PLUGIN_ROOT");
  const direct = c.match(/^"?\$CLAUDE_PLUGIN_ROOT(\/[^\s"]+)"?/);
  if (direct) {
    const ext = direct[1].slice(direct[1].lastIndexOf("."));
    if (RUNNER[ext]) c = `${RUNNER[ext]} ${c}`;
  }
  return `export CLAUDE_PLUGIN_ROOT=${ROOT}; ${c}`;
}

function mapHooks(hooks) {
  const outHooks = {};
  for (const [event, groups] of Object.entries(hooks)) {
    outHooks[event] = groups.map((g) => ({
      ...g,
      hooks: (g.hooks ?? []).map((x) => (x.type === "command" ? { ...x, command: mapCommand(x.command) } : x)),
    }));
  }
  return outHooks;
}

const baseSettings = { effortLevel: "high", statusLine: { type: "command", command: "true" } };

function writeArm(name, settings, files) {
  const d = join(out, name);
  rmSync(d, { recursive: true, force: true });
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "settings.json"), JSON.stringify(settings, null, 2) + "\n");
  const map = { "~/.claude/settings.json": "settings.json" };
  for (const [target, src] of Object.entries(files)) {
    const rel = join("files", target.replace("~/.claude/", ""));
    mkdirSync(join(d, rel, ".."), { recursive: true });
    cpSync(src, join(d, rel));
    map[target] = rel;
  }
  const q = (s) => JSON.stringify(s);
  const lines = [`name = ${q(name)}`, 'agent = "claude-code"', `model = ${q(model)}`, "include = []", "", "[files]"];
  for (const k of Object.keys(map).sort()) lines.push(`${q(k)} = ${q(map[k])}`);
  writeFileSync(join(d, "harness.toml"), lines.join("\n") + "\n");
  console.log(`${name}: ${Object.keys(map).length} files`);
}

writeArm("base", baseSettings, {});

const hooks = mapHooks(loadHooks());
const files = {};
for (const p of walk(plugin)) files[`~/.claude/ab-plugin/${relative(plugin, p)}`] = p;
for (const sub of ["skills", "agents", "commands"]) {
  const root = join(plugin, sub);
  if (!existsSync(root)) continue;
  for (const p of walk(root)) files[`~/.claude/${sub}/${relative(root, p)}`] = p;
}
const settings = Object.keys(hooks).length ? { ...baseSettings, hooks } : baseSettings;
writeArm("plugin", settings, files);

const events = Object.keys(hooks);
console.log(`plugin ${manifest.name ?? basename(plugin)}: hooks on ${events.length ? events.join(", ") : "nothing"}`);
const unmapped = [".mcp.json", ".lsp.json", "settings.json"].filter((f) => existsSync(join(plugin, f)));
if (manifest.mcpServers) unmapped.push("mcpServers in plugin.json");
for (const part of unmapped) console.log(`note: ${part} is not mapped; the plugin arm runs without it`);
