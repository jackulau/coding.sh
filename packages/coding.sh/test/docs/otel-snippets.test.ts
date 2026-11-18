// OpenTelemetry JS 3.0 (2026-10-20) deprecated @opentelemetry/sdk-trace-node and sdk-trace-base, and
// its BatchSpanProcessor takes `{ exporter }`. An unpinned install of the 2.x packages next to the 3.x
// exporter fails with ERESOLVE, and `new BatchSpanProcessor(exporter)` against 3.x throws on flush.
// This reads every fenced block in docs/ and fails on either shape, except in a code block whose
// nearest preceding install pins the 1.x or 2.x SDK (the Temporal block, the Agent Runs hosts).
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const repo = join(pkg, "..", "..");
const DOCS = join(repo, "docs");

interface Block {
  lang: string;
  body: string;
  line: number;
}

function blocks(md: string): Block[] {
  const out: Block[] = [];
  const lines = md.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const open = /^\s*(```+)\s*([\w-]*)/.exec(lines[i]!);
    if (!open) continue;
    const fence = open[1]!;
    const start = i;
    const body: string[] = [];
    for (i++; i < lines.length && !lines[i]!.trimStart().startsWith(fence); i++) body.push(lines[i]!);
    out.push({ lang: open[2]!.toLowerCase(), body: body.join("\n"), line: start + 1 });
  }
  return out;
}

const INSTALL = /\b(?:npm\s+(?:install|i|add)|pnpm\s+(?:add|install|i)|yarn\s+add|bun\s+add)\b/;
const OLD_SDK = /@opentelemetry\/sdk-trace-(?:node|base)(@[^\s"'`]*)?/g;
const PINNED_OLD_SDK = /@opentelemetry\/sdk-trace-(?:node|base)@\^?~?[12](?:[.\s"'`]|$)/;
// `new BatchSpanProcessor(` followed by anything but an options object.
const POSITIONAL = /new\s+BatchSpanProcessor\(\s*(?!\{|\))/;

export function otelSnippetProblems(md: string): string[] {
  const problems: string[] = [];
  let lastInstall: string | null = null;
  for (const b of blocks(md)) {
    if (INSTALL.test(b.body)) {
      for (const cmd of b.body.split("\n").filter((l) => INSTALL.test(l))) {
        for (const m of cmd.matchAll(OLD_SDK)) {
          if (!m[1]) problems.push(`line ${b.line}: unpinned ${m[0]} install (OpenTelemetry JS 3.x deprecates it; pin @2 or use @opentelemetry/sdk-trace)`);
        }
      }
      lastInstall = b.body;
      continue;
    }
    if (POSITIONAL.test(b.body) && !(lastInstall && PINNED_OLD_SDK.test(lastInstall))) {
      problems.push(`line ${b.line}: positional new BatchSpanProcessor(exporter) without a pinned 1.x/2.x install before it (3.x takes { exporter })`);
    }
  }
  return problems;
}

function mdFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    // Research notes quote the broken snippets on purpose.
    if (e.isDirectory()) { if (e.name !== "research") out.push(...mdFiles(p)); }
    else if (e.name.endsWith(".md")) out.push(p);
  }
  return out;
}

const OLD_DURABLE = [
  "```sh",
  "npm install @opentelemetry/api @opentelemetry/sdk-trace-node @opentelemetry/resources @opentelemetry/exporter-trace-otlp-http",
  "```",
  "",
  "```js",
  'import { BatchSpanProcessor, NodeTracerProvider } from "@opentelemetry/sdk-trace-node";',
  "const provider = new NodeTracerProvider({",
  '  spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter({ url: "http://127.0.0.1:4318/v1/traces" }))],',
  "});",
  "```",
].join("\n");

const OLD_TEE = [
  "```ts",
  'import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";',
  "export const tracing = agentRuns({",
  '  spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter({ url: "http://127.0.0.1:4318/v1/traces" }))],',
  "});",
  "```",
].join("\n");

const TEMPORAL = [
  "```sh",
  "npm install @temporalio/interceptors-opentelemetry @opentelemetry/api@1.9.0 @opentelemetry/sdk-trace-node@1 @opentelemetry/resources@1 @opentelemetry/exporter-trace-otlp-http@0.57",
  "```",
  "",
  "```js",
  'const spanProcessor = new BatchSpanProcessor(new OTLPTraceExporter({ url: "http://127.0.0.1:4318/v1/traces" }));',
  "```",
].join("\n");

const NEW_FORM = [
  "```sh",
  "npm install @opentelemetry/api @opentelemetry/sdk-trace @opentelemetry/exporter-trace-otlp-http",
  "```",
  "",
  "```js",
  'spanProcessors: [new BatchSpanProcessor({ exporter: new OTLPTraceExporter({ url: "http://127.0.0.1:4318/v1/traces" }) })],',
  "```",
].join("\n");

describe("OpenTelemetry JS snippets in docs", () => {
  it("flags the 2.x-shaped snippets the docs had before OTel JS 3.0", () => {
    const durable = otelSnippetProblems(OLD_DURABLE);
    assert.ok(durable.some((p) => p.includes("unpinned @opentelemetry/sdk-trace-node")), durable.join("\n"));
    assert.ok(durable.some((p) => p.includes("positional")), durable.join("\n"));
    assert.ok(otelSnippetProblems(OLD_TEE).some((p) => p.includes("positional")));
  });

  it("passes the 3.x form and a positional processor after a pinned 1.x/2.x install", () => {
    assert.deepEqual(otelSnippetProblems(NEW_FORM), []);
    assert.deepEqual(otelSnippetProblems(TEMPORAL), []);
    const pinned2 = "```sh\nnpm install @opentelemetry/sdk-trace-base@2 @opentelemetry/exporter-trace-otlp-http@0.223\n```\n\n" + OLD_TEE;
    assert.deepEqual(otelSnippetProblems(pinned2), []);
  });

  it("finds no unpinned 2.x install or unpinned positional BatchSpanProcessor in docs/", () => {
    const files = mdFiles(DOCS);
    assert.ok(files.length > 10, "docs/ has markdown files");
    const problems = files.flatMap((f) =>
      otelSnippetProblems(readFileSync(f, "utf8")).map((p) => `${relative(repo, f).replaceAll("\\", "/")} ${p}`),
    );
    assert.deepEqual(problems, []);
  });

  it("the durable-workflow how-to registers a 3.x TracerProvider and keeps the pinned Temporal block", () => {
    const doc = readFileSync(join(DOCS, "how-to", "trace-durable-workflow.md"), "utf8");
    assert.match(doc, /import \{ BatchSpanProcessor, TracerProvider \} from "@opentelemetry\/sdk-trace";/);
    assert.match(doc, /trace\.setGlobalTracerProvider\(provider\)/);
    assert.match(doc, /new AsyncLocalStorageContextManager\(\)\.enable\(\)/);
    assert.match(doc, /new BatchSpanProcessor\(\{ exporter: new OTLPTraceExporter/);
    assert.match(doc, /@opentelemetry\/sdk-trace-node@2/, "names the 2.x pin");
    assert.match(doc, /@opentelemetry\/api@1\.9/, "names the api pin");
    assert.match(doc, /@opentelemetry\/sdk-trace-node@1 /, "Temporal block still pins 1.x");
  });
});
