// Keyboard and focus in the viewer, with real key presses in headless Chrome: a focused control keeps
// its own keys (Enter and Space press it, arrows scroll a scrolling pane) while the page's shortcuts
// take the rest, and a re-render never leaves focus on <body>.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { AgentEvent } from "../../src/core/types.ts";
import { startViewer, type Viewer } from "../../src/viewer/server.ts";
import { findChrome, launchBrowser, type Browser, type Page } from "./browser.ts";
import { FakeBlobs, FakeIndex, event, experimentResult, session } from "./fakes.ts";

const chrome = findChrome();
if (!chrome && process.env.GITHUB_ACTIONS) throw new Error("no Chrome found on CI; set CODING_SH_TEST_CHROME");
const T0 = 1_762_400_000_000;
const LONG = "5a1d2c3b-0f4e-4a6b-8c7d-9e0f1a2b3c4d";
const RP = "7f3c1e2a-5b6d-4e8f-9a0b-1c2d3e4f5a6b";
const TURNS = "3b9e4d2a-6c1f-4e7a-8b5d-2f0a9c8e7d61";
const FOLDS = "8e2d6c4b-1a3f-4b5e-9c7d-0f6a2b8c4e19";

describe("viewer keyboard and focus in a browser", { skip: chrome ? false : "no Chrome/Chromium found (set CODING_SH_TEST_CHROME)" }, () => {
  const index = new FakeIndex();
  let v: Viewer;
  let browser: Browser;
  let page: Page | undefined;
  const at = (id: string, n: number, over: Partial<AgentEvent>) => ({ ...event(id, n), ts: T0 + n * 1000, cwd: "/work/demo", ...over });

  before(async () => {
    await index.upsertSession(session(LONG, { startedAt: T0, endedAt: T0 + 60_000, title: "Long output", stats: { events: 4, turns: 1, toolCalls: 1, toolErrors: 0, filesChanged: 0 } }));
    await index.putEvents([
      at(LONG, 1, { kind: "user.message", payload: { text: "list the files" } }),
      at(LONG, 2, { kind: "tool.start", payload: { tool: "Bash", toolUseId: "b1", input: { command: "ls -R" } } }),
      at(LONG, 3, { kind: "tool.end", durationMs: 900, payload: { tool: "Bash", toolUseId: "b1", ok: true, output: Array.from({ length: 600 }, (_, i) => `src/file-${i}.ts`).join("\n") } }),
      at(LONG, 4, { kind: "assistant.message", payload: { text: "Listed." } }),
    ]);
    await index.upsertSession(session(RP, { startedAt: T0 - 60_000, endedAt: T0, title: "Replay me", repo: { root: "/work/demo", head: "a41c9e2b00" }, stats: { events: 8, turns: 1, toolCalls: 3, toolErrors: 1, filesChanged: 1 } }));
    await index.putEvents([
      at(RP, 1, { kind: "user.message", payload: { text: "write a.txt then test" } }),
      at(RP, 2, { kind: "tool.start", payload: { tool: "Write", toolUseId: "w1", input: { file_path: "/work/demo/a.txt", content: "one\ntwo\n" } } }),
      at(RP, 3, { kind: "tool.end", payload: { tool: "Write", toolUseId: "w1", ok: true } }),
      at(RP, 4, { kind: "tool.start", payload: { tool: "Edit", toolUseId: "e1", input: { file_path: "/work/demo/a.txt", old_string: "two", new_string: "TWO" } } }),
      at(RP, 5, { kind: "tool.end", payload: { tool: "Edit", toolUseId: "e1", ok: true } }),
      at(RP, 6, { kind: "tool.start", payload: { tool: "Bash", toolUseId: "b1", input: { command: "npm test" } } }),
      at(RP, 7, { kind: "tool.end", durationMs: 1200, payload: { tool: "Bash", toolUseId: "b1", ok: false, exitCode: 1, output: "1 failing" } }),
      at(RP, 8, { kind: "assistant.message", payload: { text: "The test fails." } }),
    ]);
    // Four user turns of ten replies each: long enough that the step list scrolls and shows its minimap.
    const turnEvents: AgentEvent[] = [];
    let n = 0;
    for (let t = 1; t <= 4; t++) {
      turnEvents.push(at(TURNS, ++n, { kind: "user.message", payload: { text: t === 2 ? "\n  second prompt, first line\nand a second line that stays out of the header" : `prompt number ${t}` } }));
      for (let r = 0; r < 10; r++) turnEvents.push(at(TURNS, ++n, { kind: "assistant.message", payload: { text: `reply ${t}.${r}` } }));
    }
    await index.upsertSession(session(TURNS, { startedAt: T0, endedAt: T0 + n * 1000, title: "Four turns", stats: { events: n, turns: 4, toolCalls: 0, toolErrors: 0, filesChanged: 0 } }));
    await index.putEvents(turnEvents);
    // Five turns: the first reads, edits and runs a command; the third holds a failure; the fourth is a step deep links point into.
    const tool = (n: number, name: string, id: string, input: Record<string, unknown>, end: Record<string, unknown> = { ok: true }) => [
      at(FOLDS, n, { kind: "tool.start", payload: { tool: name, toolUseId: id, input } }),
      at(FOLDS, n + 1, { kind: "tool.end", durationMs: 500, payload: { tool: name, toolUseId: id, ...end } }),
    ];
    const foldEvents: AgentEvent[] = [
      at(FOLDS, 1, { kind: "user.message", payload: { text: "fix the parser" } }),
      ...tool(2, "Read", "r1", { file_path: "/work/demo/a.ts" }),
      ...tool(4, "Read", "r2", { file_path: "/work/demo/b.ts" }),
      ...tool(6, "Edit", "e1", { file_path: "/work/demo/a.ts", old_string: "one", new_string: "two" }),
      { ...at(FOLDS, 23, { kind: "file.change", payload: { path: "/work/demo/a.ts", op: "modify", additions: 1, deletions: 1, tool: "Edit", toolUseId: "e1" } }), ts: T0 + 7500 },
      ...tool(8, "Bash", "b1", { command: "npm test" }),
      at(FOLDS, 10, { kind: "assistant.message", payload: { text: "Fixed." } }),
      at(FOLDS, 11, { kind: "user.message", payload: { text: "find the callers" } }),
      ...tool(12, "Grep", "g1", { pattern: "parse(" }),
      at(FOLDS, 14, { kind: "assistant.message", payload: { text: "Two callers." } }),
      at(FOLDS, 15, { kind: "user.message", payload: { text: "run the build" } }),
      ...tool(16, "Bash", "b2", { command: "npm run build" }, { ok: false, exitCode: 2, output: "error TS2304" }),
      at(FOLDS, 18, { kind: "assistant.message", payload: { text: "The build fails." } }),
      at(FOLDS, 19, { kind: "user.message", payload: { text: "explain it" } }),
      at(FOLDS, 20, { kind: "assistant.message", payload: { text: "a step inside turn four" } }),
      at(FOLDS, 21, { kind: "user.message", payload: { text: "thanks" } }),
      at(FOLDS, 22, { kind: "assistant.message", payload: { text: "Done." } }),
    ];
    await index.upsertSession(session(FOLDS, { startedAt: T0, endedAt: T0 + 22_000, title: "Five turns", stats: { events: 23, turns: 5, toolCalls: 6, toolErrors: 1, filesChanged: 1 } }));
    await index.putEvents(foldEvents);
    const exp = experimentResult("exp-prod-smoke");
    // The failing case's output is long enough to clip, so its open row holds a "Show all" button.
    exp.runs[1]!.output = Array.from({ length: 600 }, (_, i) => `line ${i}`).join("\n");
    v = await startViewer({
      index,
      blobs: new FakeBlobs(),
      port: 0,
      updateStatus: async () => ({ disabled: "test" }) as any,
      experiments: { listExperiments: async () => [exp], getExperiment: async (id) => (id === exp.id ? exp : undefined) },
    });
    browser = await launchBrowser(chrome!);
  });
  after(async () => {
    await page?.close();
    await browser?.close();
    await v?.close();
  });

  async function open(hash: string, height = 900): Promise<Page> {
    await page?.close();
    page = await browser.newPage();
    await page.viewport(1280, height);
    await page.goto(v.url + hash);
    return page;
  }
  const focused = "(() => { const a = document.activeElement; return a === document.body ? 'body' : a.id ? '#' + a.id : a.tagName.toLowerCase() + (a.className ? '.' + String(a.className).split(' ')[0] : ''); })()";
  const focusOn = (p: Page, expr: string) => p.eval(`(() => { const el = ${expr}; el.focus(); return document.activeElement === el; })()`);

  test("Enter and Space on a focused filter chip press the chip; they do not open a session", async () => {
    const p = await open("#/");
    const chip = "document.querySelector('[data-filter=agent] .chip')";
    await p.waitFor(`${chip} && document.querySelector('[role=option]')`, "the list and its filters");
    assert.ok(await focusOn(p, chip));
    await p.press("Enter");
    await p.waitFor(`${chip}.getAttribute('aria-pressed') === 'true'`, "Enter picks the filter");
    assert.doesNotMatch(await p.eval("location.hash"), /^#\/s\//);
    assert.equal(await p.eval(`document.activeElement === ${chip}`), true, "the chip keeps focus");
    await p.press(" ");
    await p.waitFor(`${chip}.getAttribute('aria-pressed') === 'false'`, "Space takes it back out");
    assert.doesNotMatch(await p.eval("location.hash"), /^#\/s\//);
    // The list's own keys still work from a button: j is not a key a button uses.
    await p.press("j");
    assert.equal(await p.eval("document.activeElement.getAttribute('role')"), "listbox");
    assert.deepEqual(p.errors, []);
  });

  test("Enter on the Events tab follows the link, and focus lands on the page, not on <body>", async () => {
    const p = await open("#/");
    const tab = "document.querySelector('.view-tabs a[href^=\"#/events\"]')";
    await p.waitFor(`${tab} && document.querySelector('[role=option]')`, "the tabs");
    assert.ok(await focusOn(p, tab));
    await p.press("Enter");
    await p.waitFor("location.hash.startsWith('#/events')", "the Events tab");
    await p.waitFor("document.querySelector('.view-tabs a[aria-current=page]')?.textContent.startsWith('Events')", "the Events rows");
    assert.equal(await p.eval(focused), "#main");
  });

  test("in the replay, Space on a focused button presses that button instead of Play", async () => {
    const p = await open("#/s/" + RP + "?step=2");
    await p.waitFor("document.querySelector('.rp-bar') && !document.querySelector('.rp-bar').hidden && /^2 \\/ /.test(document.querySelector('.rp-pos').textContent)", "the replay at step 2");
    assert.ok(await focusOn(p, "document.querySelector('.rp-bar [aria-label=\"Next step\"]')"));
    await p.press(" ");
    await p.waitFor("/^3 \\/ /.test(document.querySelector('.rp-pos').textContent)", "Space on Next steps once");
    assert.equal(await p.eval("document.querySelector('.rp-play').textContent"), "Play", "and does not start playing");
    // A rebuilt control keeps focus: the speed buttons are redrawn on every change.
    assert.ok(await focusOn(p, "document.querySelectorAll('.rp-ctl .seg button')[1]"));
    await p.press("Enter");
    await p.waitFor("document.querySelectorAll('.rp-ctl .seg button')[1].getAttribute('aria-pressed') === 'true'", "4x speed");
    assert.equal(await p.eval("document.activeElement === document.querySelectorAll('.rp-ctl .seg button')[1]"), true, "the speed button keeps focus");
    // Away from a button, Space is still Play.
    await p.eval("document.querySelector('#steps').focus()");
    await p.press(" ");
    await p.waitFor("document.querySelector('.rp-play').textContent === 'Pause'", "Space plays");
    assert.deepEqual(p.errors, []);
  });

  test("arrow keys scroll the focused step detail when it overflows; j still moves to the next step", async () => {
    const p = await open("#/s/" + LONG, 600);
    await p.waitFor("document.querySelectorAll('#steps .st').length >= 2", "steps");
    await p.eval("[...document.querySelectorAll('#steps .st')].find((t) => /ls -R/.test(t.textContent)).click()");
    const pane = "document.querySelector('#event-pane')";
    await p.waitFor(`${pane}.scrollHeight > ${pane}.clientHeight + 100`, "a step detail taller than its pane");
    const selected = "document.querySelector('#steps .st[aria-selected=true]').id";
    const step: string = await p.eval(selected);
    assert.ok(await focusOn(p, pane));
    for (let i = 0; i < 4; i++) await p.press("ArrowDown");
    await p.waitFor(`${pane}.scrollTop > 0`, "the pane scrolls");
    assert.equal(await p.eval(selected), step, "the step stays");
    assert.equal(await p.eval(focused), "#event-pane");
    await p.press("j");
    await p.waitFor(`${selected} !== ${JSON.stringify(step)}`, "j moves on");
    assert.deepEqual(p.errors, []);
  });

  test("} and { jump between user turns; each turn has a header row and a minimap mark", async () => {
    let p = await open("#/s/" + TURNS, 500);
    const selected = "document.querySelector('#steps .st[aria-selected=true]')";
    await p.waitFor(`${selected} && /prompt number 1/.test(${selected}.textContent)`, "the session, on its first prompt");
    // The header row: turn number, the prompt's first line only, and the time into the session.
    const turn2 = "[...document.querySelectorAll('#steps .st.turn')].find((r) => /Turn 2/.test(r.textContent))";
    assert.equal(await p.eval(`${turn2}.querySelector('.arg').textContent`), "second prompt, first line");
    assert.equal(await p.eval(`${turn2}.querySelector('.d time').textContent`), "0:12");
    // Two presses from open reach the third turn.
    await p.eval("document.querySelector('#steps').focus()");
    await p.press("}");
    await p.press("}");
    await p.waitFor(`/prompt number 3/.test(${selected}.textContent)`, "} twice lands on turn 3");
    assert.equal(await p.eval("document.activeElement.id"), "steps");
    // The URL names the step, so the link opens on the same turn.
    // Turn 3's prompt is event 23 (each turn is a prompt and ten replies).
    await p.waitFor(`location.hash.endsWith(${JSON.stringify("/" + TURNS + "-e23")})`, "the URL names turn 3's prompt");
    p = await open("#/s/" + TURNS + "/" + TURNS + "-e23", 500);
    await p.waitFor(`${selected} && /prompt number 3/.test(${selected}.textContent)`, "the deep link opens turn 3");
    await p.eval("document.querySelector('#steps').focus()");
    // { from inside a turn goes to that turn's own prompt, then to the one before.
    await p.press("j");
    await p.press("j");
    await p.press("{");
    await p.waitFor(`/prompt number 3/.test(${selected}.textContent)`, "{ back to the turn's start");
    await p.press("{");
    await p.waitFor(`/Turn 2/.test(${selected}.textContent)`, "{ again to turn 2");
    // Past the last turn, } stays put.
    for (let i = 0; i < 3; i++) await p.press("}");
    await p.waitFor(`/prompt number 4/.test(${selected}.textContent)`, "the last turn");
    // The minimap marks each turn start; the help sheet and the hint bar list the keys from KEYMAP.
    assert.equal(await p.eval("document.querySelectorAll('.tl-map:not([hidden]) i.t').length"), 4);
    assert.match(await p.eval("document.querySelector('.hintbar')?.textContent || ''"), /\{\}turns/);
    await p.press("?");
    await p.waitFor("/Next turn/.test(document.body.textContent) && /Previous turn/.test(document.body.textContent)", "the help sheet lists the turn keys");
    assert.deepEqual(p.errors, []);
  });

  test("finished turns fold to one row each; a turn with a failure and the last turn stay open", async () => {
    let p = await open("#/s/" + FOLDS);
    const folded = "[...document.querySelectorAll('#steps .st.turn.fold')]";
    const selected = "document.querySelector('#steps .st[aria-selected=true]')";
    await p.waitFor(`${folded}.length === 3`, "turns 1, 2 and 4 folded");
    // The failure is on screen: turn 3 is open, and so is the last turn.
    assert.match(await p.eval("document.querySelector('#steps .st.is-fail:not(.fold)')?.textContent || ''"), /npm run build/);
    assert.match(await p.eval("[...document.querySelectorAll('#steps .st:not(.fold)')].map((r) => r.textContent).join('|')"), /Done./);
    assert.equal(await p.eval("document.querySelectorAll('#steps .st').length"), 8, "17 steps in 8 rows");
    // The folded row: the prompt, its length and tool calls, what it did in words, and its time.
    const row1 = `${folded}[0]`;
    assert.equal(await p.eval(`${row1}.querySelector('.t').textContent`), "Turn 1");
    assert.equal(await p.eval(`${row1}.querySelector('.arg').textContent`), "fix the parser");
    assert.equal(await p.eval(`${row1}.querySelector('.sum').textContent`), "9.0s · 4 tool calls · read 2 files, 1 edit +1 −1, 1 command");
    assert.equal(await p.eval(`${row1}.getAttribute('aria-expanded')`), "false");
    assert.equal(await p.eval(`${row1}.getAttribute('aria-selected')`), "true", "the list opens on its first row");
    // Enter opens the turn and its row says so; Enter again folds it.
    await p.eval("document.querySelector('#steps').focus()");
    await p.press("Enter");
    await p.waitFor(`${folded}.length === 2 && /fix the parser/.test(${selected}.textContent) && ${selected}.getAttribute('aria-expanded') === 'true'`, "Enter opens turn 1");
    assert.match(await p.eval("document.querySelector('#event-pane').textContent"), /fix the parser/);
    await p.press("Enter");
    await p.waitFor(`${folded}.length === 3 && ${selected}.getAttribute('aria-expanded') === 'false'`, "Enter folds it again");
    // A click on a folded row opens it.
    await p.eval(`${folded}[1].click()`);
    await p.waitFor(`${folded}.length === 2 && /find the callers/.test(${selected}.textContent)`, "a click opens turn 2");
    // z shows every step, and the choice is remembered (each test page has its own storage, so reload this one); z again folds them back.
    await p.press("z");
    await p.waitFor(`${folded}.length === 0`, "z expands all");
    await p.eval("window.beforeReload = true; location.reload()");
    await p.waitFor("!window.beforeReload && document.querySelectorAll('#steps .st').length === 17", "still expanded after a reload");
    await p.eval("document.querySelector('#steps').focus()");
    await p.press("z");
    await p.waitFor(`${folded}.length === 3`, "z folds them back");
    // A link to a step inside a folded turn opens that turn on the step.
    p = await open("#/s/" + FOLDS + "/" + FOLDS + "-e20");
    await p.waitFor(`${selected} && /a step inside turn four/.test(${selected}.textContent)`, "the deep link opens turn 4");
    assert.equal(await p.eval(`${folded}.length`), 2);
    // } into a folded turn opens it; { from there goes back to its prompt's turn.
    await p.eval("document.querySelector('#steps').focus()");
    await p.press("Home");
    await p.press("}");
    await p.waitFor(`/find the callers/.test(${selected}.textContent) && ${selected}.getAttribute('aria-expanded') === 'true'`, "} opens turn 2");
    // ← folds the turn the selected step is in.
    await p.press("j");
    await p.press("ArrowLeft");
    await p.waitFor(`/find the callers/.test(${selected}.textContent) && ${selected}.classList.contains('fold')`, "← folds turn 2");
    assert.deepEqual(p.errors, []);
  });

  test("a case filter chip keeps focus when the chips are redrawn", async () => {
    const p = await open("#/experiments/exp-prod-smoke");
    const all = "document.querySelector('[data-case-filter=all]')";
    await p.waitFor(all, "case filters");
    assert.ok(await focusOn(p, all));
    await p.press("Enter");
    await p.waitFor(`${all}.getAttribute('aria-pressed') === 'true'`, "all cases");
    assert.equal(await p.eval(`document.activeElement === ${all}`), true);
    assert.equal(await p.eval("document.querySelectorAll('[role=option]').length"), 2);
  });

  test("Enter on a button inside an open case row presses the button; the row stays open", async () => {
    const p = await open("#/experiments/exp-prod-smoke");
    const lb = "document.querySelector('.case-table [role=listbox]')";
    await p.waitFor(`${lb} && ${lb}.querySelector('[role=option]')`, "cases");
    assert.ok(await focusOn(p, lb));
    await p.press("Enter");
    const all = `${lb}.querySelector('[aria-expanded=true] .show-all')`;
    await p.waitFor(all, "the open row's clipped output");
    assert.ok(await focusOn(p, all));
    await p.press("Enter");
    await p.waitFor(`${lb}.querySelector('[aria-expanded=true]') && !${all}`, "the whole output, row still open");
    assert.ok((await p.eval(`${lb}.querySelector("[aria-expanded=true] pre").textContent.split("\\n").length`)) > 420, "more than the clipped 400 lines");
    assert.notEqual(await p.eval(focused), "body");
    assert.deepEqual(p.errors, []);
  });

  test("an Explore control keeps focus when its change redraws the page", async () => {
    const p = await open("#/explore");
    const week = "[...document.querySelectorAll('.mx-controls [aria-label=Bucket] button')].find((b) => b.textContent === 'Week')";
    await p.waitFor(week, "the Explore controls");
    assert.ok(await focusOn(p, week));
    await p.press("Enter");
    await p.waitFor(`/per=week/.test(location.hash) && ${week}.getAttribute('aria-pressed') === 'true'`, "weekly buckets");
    assert.equal(await p.eval(`document.activeElement === ${week}`), true, "the Week button keeps focus");
    const by = "document.querySelector('.mx-controls select')";
    await p.eval(`(() => { const s = ${by}; s.focus(); s.value = 'model'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await p.waitFor(`/by=model/.test(location.hash) && ${by}.value === 'model'`, "split by model");
    assert.equal(await p.eval(`document.activeElement === ${by}`), true, "the select keeps focus, so the next arrow key changes it again");
    assert.deepEqual(p.errors, []);
  });

  test("a button that removes itself hands focus to its pane, not to <body>", async () => {
    const p = await open("#/s/" + LONG, 600);
    await p.waitFor("document.querySelectorAll('#steps .st').length >= 2", "steps");
    await p.eval("[...document.querySelectorAll('#steps .st')].find((t) => /ls -R/.test(t.textContent)).click()");
    const all = "document.querySelector('#event-pane .show-all')";
    await p.waitFor(all, "a clipped output with Show all");
    assert.ok(await focusOn(p, all));
    await p.press("Enter");
    await p.waitFor(`!${all}`, "the whole output");
    assert.equal(await p.eval(focused), "#event-pane");
  });
});
