# See which agent session wrote each commit

`coding.sh attribution` shows which captured agent session wrote the lines each commit added.
Use it to see how much of a branch an agent wrote, or which session to open for a line.

It only reads git (`log`, `diff`, `blame`, notes). It never writes refs, notes, the index or
objects in your repository.

## Commits and the sessions that wrote them

Run it inside the repository:

```sh
coding.sh attribution
```

```text
4 commits since Oct 1 04:50: 32 of 43 added lines by 3 sessions (74%)

COMMIT    DATE         AGENT LINES  SESSIONS              SUBJECT
59ad9fa7  Oct 1 11:00  10/10        s3-claud claude-code  add smoothstep
48752711  Oct 1 08:00  12/15        s2-codex codex        add util
bdebb9c2  Oct 1 06:00  10/10        s1-claud claude-code  add clamp
```

`AGENT LINES` is lines credited to a session out of lines the commit added.

| Option | What it does |
|---|---|
| `--since 7d` | Only commits after this time (default: the first captured session in the repo) |
| `--rev main` | Walk back from this branch or commit (default: HEAD) |
| `--all` | Also list commits with no agent lines |
| `--json` | Totals, sessions and each commit's attributions as one document |

All options: [coding.sh attribution](https://coding.sh/docs/cli/attribution).

## See who wrote each line of a file

```sh
coding.sh blame src/math.ts
coding.sh blame src/math.ts:17-21
```

```text
src/math.ts at 59ad9fa7: 15 of 21 lines by 3 agent sessions

 4  3cd19232  -                       return value;
 8  bdebb9c2  s1-claud claude-code  export function clamp(value: number, lo: number, hi: number): number {
18  59ad9fa7  s3-claud claude-code  export function smoothstep(edge0: number, edge1: number, x: number): number {
```

Each line shows the commit that last changed it, as `git blame` does, and the session that wrote
it. `-` means no captured session wrote it. Open a session with `coding.sh show <id>`.

## Export Agent Trace records

```sh
coding.sh attribution export > agent-trace.jsonl
coding.sh attribution export --since 30d --out trace.jsonl
coding.sh attribution export --viewer-url https://coding.example.com
```

It prints one [Agent Trace](https://agent-trace.dev) record per commit with agent lines, as JSON
lines, so other tools can read them. Each record is checked against the RFC 0.1.0 schema before it
is written. `--json` prints `{version, records}` as one document instead.

| Field | Holds |
|---|---|
| `vcs.revision` | The commit. Line numbers are the commit's own, so they match `git blame`. |
| conversations | One per session: contributor `ai`, a `model_id` such as `anthropic/claude-opus-4-1`, and a viewer `url` |
| ranges | A `content_hash` of the lines (`sha256:` plus 16 hex digits); the lines themselves are not exported |
| `id`, `timestamp` | Derived from the commit, so exporting again gives the same records |
| `version` | `"0.1"`, the major.minor the RFC's schema requires |
| `metadata` | `confidence` (the commit's mean) and `sh.coding`: subject, line counts, each session's lines and method |

Session links point at `http://127.0.0.1:4319/#/s/<id>` unless you pass `--viewer-url`.

## How matching works

For each session, coding.sh takes the lines it added: the diff from its start state to its end
snapshot. It keeps a file of that diff only when the session's tools named the file, or the session
ran a shell or subagent call, which can write files nothing names. A session with none of these is
credited nothing. A named file takes the lines its edit steps added, not the diff.

For a named file the diff does not hold, it uses the session's own edit tool calls. That is every
such file when there is no end snapshot, and a file whose change had left the tree by then.

Then it walks each commit, oldest first, in passes over the files the commit changed:

| Method | Matches when | Confidence |
|---|---|---|
| Patch id | The file's change equals what one session did to it. A rebased commit still matches. | as the source |
| Line hash | A session added the same line to the same file | as the source |
| Moved line | Once every file of the commit has had its same-file matches, a line of 24+ characters still unmatched matches one the session wrote in another file | 0.8x |
| Trivial line | Braces, blank lines and `else` follow the nearest matched line in their block | 0.95x |
| git-ai | [git-ai](https://github.com/git-ai-project/git-ai) notes (`refs/notes/ai`) credit lines no session matched, to that agent with no session link | 0.9 |

The source sets the starting confidence: 1 from a pre-agent snapshot, 0.9 from HEAD at the
session's start, 0.8 from edit tool calls. A file the session's tools never named gives 0.85x (only a shell or subagent call allows one).

- A session's line is credited once. A person who types the same line in a later commit, or copies
  it into another file of the same commit, owns that copy.
- An edit tool call counts for the lines it added itself, less the ones a later call of the session
  removed. Lines someone else added to the file between two calls are not the session's.
- A session is credited for commits from its start (10 minutes of clock skew allowed) to 21 days
  later.
- When two sessions added the same line, the one that started later wins.
- Lines no session matched were written by a person, rewritten by one, or written by an agent
  coding.sh did not capture.

Sessions are found by repo root, including its other worktrees. Lines are stored as hashes, never
as code text.

## Limits

- Commits before `--since` are not read, so a line one of them used could be credited again. The
  default avoids this.
- A merge commit's own changes (conflict resolutions) are not attributed.
- Content that redaction changed in a stored tool call does not match the committed line.
- A session with neither an end snapshot nor edit tool calls has nothing to match. Live capture
  takes the end snapshot when ingest runs soon after the turn ends.
- A session that ran a shell or subagent call can still be credited a file a person wrote by hand
  before its end snapshot (the tree at ingest), at lower confidence.
- A file written only by a tool coding.sh does not read as an edit (some MCP tools) is not credited,
  unless the session also ran a shell or subagent call.
