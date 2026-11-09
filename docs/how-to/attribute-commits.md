# See which agent session wrote each commit

`coding.sh attribution` matches the lines each commit added to the lines each captured agent
session added. `coding.sh blame` shows it per line of a file. `coding.sh attribution export` writes
the result as [Agent Trace](https://agent-trace.dev) records, so other tools can read it.

All three only read git (`log`, `diff`, `blame`, notes). They never write refs, notes, the index
or objects in your repository.

## 1. Commits and the sessions that wrote them

Run it inside the repository:

```sh
coding.sh attribution
coding.sh attribution --since 7d --rev main
coding.sh attribution --all        # also list commits with no agent lines
```

```
4 commits since Oct 1 04:50: 32 of 43 added lines by 3 sessions (74%)

COMMIT    DATE         AGENT LINES  SESSIONS              SUBJECT
59ad9fa7  Oct 1 11:00  10/10        s3-claud claude-code  add smoothstep
48752711  Oct 1 08:00  12/15        s2-codex codex        add util
bdebb9c2  Oct 1 06:00  10/10        s1-claud claude-code  add clamp
```

`AGENT LINES` is lines credited to a session out of lines the commit added. By default it reads
every commit since the first captured session in the repo. `--json` prints one document with the
totals, the sessions credited and, per commit, each attribution: path, line ranges, session, agent,
model, confidence and method.

## 2. Who wrote each line of a file

```sh
coding.sh blame src/math.ts
coding.sh blame src/math.ts:17-21
```

```
src/math.ts at 59ad9fa7: 15 of 21 lines by 3 agent sessions

 4  3cd19232  -                       return value;
 8  bdebb9c2  s1-claud claude-code  export function clamp(value: number, lo: number, hi: number): number {
18  59ad9fa7  s3-claud claude-code  export function smoothstep(edge0: number, edge1: number, x: number): number {
```

Each line shows the commit that last changed it, as `git blame` does, and the session that wrote
it. `-` means no captured session wrote the line. Open a session with `coding.sh show <id>`.

## 3. Export Agent Trace records

```sh
coding.sh attribution export > agent-trace.jsonl
coding.sh attribution export --since 30d --out trace.jsonl
coding.sh attribution export --viewer-url https://coding.example.com
```

The export prints one record per commit with agent lines, as JSON lines:

- `vcs.revision` is the commit. Line numbers are the commit's own, so `git blame` and then the
  record answer who wrote a line.
- Each session is one conversation with contributor `ai` and a `model_id` such as
  `anthropic/claude-opus-4-1`. Its `url` and `related` session link point at the viewer
  (`http://127.0.0.1:4319/#/s/<id>` unless you pass `--viewer-url`).
- Each range has a `content_hash` of its lines (`sha256:` plus 16 hex digits). The lines themselves
  are not exported.
- `version` is `"0.1"`. The RFC's schema requires major.minor, though its prose example says
  `0.1.0`.
- `id` is derived from the commit, so exporting again gives the same records. `timestamp` is the
  commit time.
- `metadata.confidence` is the commit's mean confidence. `metadata["sh.coding"]` has the subject,
  lines added, lines credited and each session's agent, lines, confidence and method.

Every record is checked against the RFC 0.1.0 trace-record schema before it is written.
`--json` prints `{version, records}` as one document instead.

## How matching works

For each session, coding.sh takes the lines it added:

1. The diff from the session's start state (its pre-agent snapshot, else HEAD at its start) to its
   end snapshot, read from the shadow repo. This sees every write, Bash and subagents included.
2. Without an end snapshot, the session's own edit tool calls (Write, Edit, apply_patch and the
   others replay knows).

Then, for each commit on the branch, oldest first, and each file it changed:

- **Patch id.** When the file's change, with whitespace and line numbers ignored, equals what one
  session did to that file, every added line is that session's. A rebase keeps this id, so a
  rebased commit still maps.
- **Line hash.** Otherwise each added line goes to a session that added the same line to the same
  file. A long line (24 or more characters) can also match a line the session wrote in another
  file, at lower confidence, which covers moved files.
- **Trivial lines.** Braces, blank lines and words like `else` never match on their own. They go to
  the session of the nearest matched line in the same block, if that session added them too.
- **git-ai.** When the repo has [git-ai](https://github.com/git-ai-project/git-ai) notes
  (`refs/notes/ai`), lines they credit to an agent and that no captured session matched are
  credited to that agent's conversation, with no session link.

A session's line is credited once. If a person types the same line again in a later commit, that
copy is theirs. A session can be credited for commits authored or committed from its start (10
minutes of clock skew allowed) to 21 days later. When two sessions added the same line, the one
that started later wins.

Lines no session matched belong to no session: a person wrote them, a person rewrote what the agent
wrote, or an agent coding.sh did not capture wrote them.

Confidence is 1 for a match from a pre-agent snapshot, 0.9 from a HEAD start, and 0.8 from edit
tool calls. It drops for a file the session's tools never named (0.85x), a moved line (0.8x) and a
trivial line (0.95x).

Sessions are found by repo root, including the repo's other worktrees. A session's lines are kept
as hashes in the store's key/value table (`attribution:source:<id>`), and each commit's result
under `attribution:commit:<sha>`. No code text is stored.

## Limits

- Commits before `--since` are not read, so a line one of them used could be credited again later.
  The default (the first captured session) avoids this.
- A merge commit's own changes (conflict resolutions) are not attributed.
- Content that redaction changed in a stored tool call does not match the committed line.
- A session with neither an end snapshot nor edit tool calls has nothing to match. Live capture
  takes the end snapshot when ingest runs soon after the session's turn ends.
