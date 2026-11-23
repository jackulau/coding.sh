# Get an alert when failures or spend cross a threshold

An alert watches one number across your stored sessions, such as the failure rate or the cost of
the last day. When the number crosses a threshold you set, coding.sh posts to a webhook or runs a
command.

```sh
coding.sh alert add failures --measure failure-rate --over 0.5 --window 1d --notify webhook:https://example.com/hook
coding.sh alert test failures
coding.sh alert check
```

You need: coding.sh capturing your sessions (`coding.sh init`). On Windows, type
`npx -p coding.sh codingsh` for `npx coding.sh`, and in PowerShell or cmd, `codingsh` for an
installed `coding.sh`.

## Add an alert

The alert above reads the share of failed sessions among those that started in the last day, and
goes to ALERT above 0.5 (50%).

| Option | What it sets |
|---|---|
| `--measure` | `failure-rate` (a share from 0 to 1), `cost` (USD), `sessions`, `flag:<FLAG>` (sessions with that flag or tag) or `score:<NAME>` (the mean of that score) |
| `--over`, `--warn` | ALERT above `--over`, WARNING above `--warn` |
| `--under`, `--warn-under` | The same, below the threshold, for a number that should not fall, such as a score |
| `--window` | `1h`, `1d` or `7d`: the sessions that started that long before the check |
| `--where` | Only the sessions a query matches, such as `--where agent:codex` |
| `--by agent` | One state per agent, each notified on its own |
| `--notify` | `webhook:<URL>` or `command:"<CMD>"` |
| `--no-data` | The state for a window with no sessions: `ok`, `alert` or `keep` (the last state) |

The states are OK, WARNING, ALERT and NO_DATA. An alert starts at OK, and only a change of state
notifies. A window with no sessions is NO_DATA unless you set `--no-data`, and moving to NO_DATA
notifies like any change. The [CLI reference](../reference/cli.md#codingsh-alert-add) has every
option.

Each notification is one JSON object. This one is a test of the alert above, sent before any
session:

```json
{"alert":"failures","state":"OK","previous":"OK","value":null,"threshold":0.5,"window":"1d","at":"2026-11-22T10:27:26.391Z","test":true}
```

`value` is `null` when there is no data. A real change has no `test`. `by` (`{"agent": …}`) is there
only with `--by agent`, and `direction` (`"under"`) only with `--under`.

## Test it

```sh
coding.sh alert test failures
```

This sends one notification now, with `"test": true` and the alert's last state as both `state` and
`previous`. It prints `✓ Delivered a test notification to webhook https://example.com/hook`, or why
the delivery failed.

## Check on a schedule

Nothing checks alerts on its own: the hook and the read commands never run them. `alert check`
reads every alert's number, saves its state, and notifies each change:

```sh
coding.sh alert check
```

It prints each alert's state, value and threshold, with `was OK` (or the state before) for each
change, then `Sent 1 notification.` It exits 0 whatever the alerts say; a script reads the states
from `alert check --json`.

`alert list --json` prints the saved states without a check. Each alert's `states` is a list with
one entry per group, and the entry has `agent` under `--by agent`. PowerShell reads it with
`codingsh alert list --json | ConvertFrom-Json`.

Run it every few minutes from cron or Task Scheduler. On Windows, `where.exe codingsh.cmd` prints
the path to give Task Scheduler as the program, with `alert check` as its arguments.

`coding.sh serve` runs the same check every minute; the first comes a minute after it starts. A
`--role viewer` replica runs none ([production](../PRODUCTION.md#17-metrics-and-logs)).

## Verify a webhook

A webhook gets a POST with the JSON as its body, signed with the secret `alert add` prints once
(`Signing secret (shown once): csh_whsec_…`):

- `X-Coding-Sh-Timestamp` is when it was sent, in unix seconds.
- `X-Coding-Sh-Signature-V2` is `sha256=` and the hex HMAC-SHA256 of `<timestamp>.<body>`, keyed
  with the secret.
- `X-Coding-Sh-Signature` signs the body alone, so it does not stop a replay. Check V2.

Refuse a POST whose timestamp is more than 5 minutes from your clock. This receiver does both
checks and prints each alert it accepts:

```js
// receiver.mjs: takes coding.sh alerts on http://127.0.0.1:8787 and refuses any whose signature
// does not match. Start it with ALERT_SECRET set to the secret `alert add` printed.
import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

const secret = process.env.ALERT_SECRET;
createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    const ts = String(req.headers["x-coding-sh-timestamp"] ?? "");
    const want = Buffer.from(`sha256=${createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex")}`);
    const got = Buffer.from(String(req.headers["x-coding-sh-signature-v2"] ?? ""));
    const fresh = Math.abs(Date.now() / 1000 - Number(ts)) <= 300;
    if (!fresh || got.length !== want.length || !timingSafeEqual(got, want)) return res.writeHead(401).end();
    const a = JSON.parse(body);
    console.log(`${a.alert}: ${a.previous} -> ${a.state}${a.test ? " (test)" : ""}`);
    res.writeHead(204).end();
  });
}).listen(Number(process.env.PORT ?? 8787), "127.0.0.1");
```

Add an alert that posts to it, start it with the secret the first command prints, and send a test:

```sh
coding.sh alert add hook --measure failure-rate --over 0.5 --window 1d --notify webhook:http://127.0.0.1:8787/
ALERT_SECRET=csh_whsec_… node receiver.mjs &
coding.sh alert test hook
```

The receiver prints `hook: OK -> OK (test)`. With a wrong secret it answers 401, and `alert test`
fails with `POST http://127.0.0.1:8787/ → 401`.

## Run a command

A command gets the same JSON on stdin and succeeds by exiting 0. Its output is not read, but what
it prints to stderr shows in the error when it fails. A try that runs past 30 seconds is stopped and
fails.

On Windows the command runs in cmd.exe, also when you added the alert in Git Bash or PowerShell. A
sh command such as `notify-send coding.sh` or `cat >> ~/alerts.log` fails there:

```text
✗ Test notification to command notify-send coding.sh failed after 3 tries: command exited 1: 'notify-send' is not recognized as an internal or external command, operable program or batch file.
```

Run a script by its full path instead, in a folder whose path has no spaces. This one adds a line to
`alerts.log` next to it for each notification:

```js
// notify.mjs: reads one coding.sh alert on stdin and adds a line to alerts.log next to this file.
import { appendFileSync } from "node:fs";

let body = "";
for await (const chunk of process.stdin) body += chunk;
const a = JSON.parse(body);
const who = a.by ? ` (${a.by.agent})` : "";
appendFileSync(new URL("alerts.log", import.meta.url), `${a.at} ${a.alert}${who}: ${a.previous} -> ${a.state}${a.test ? " (test)" : ""}\n`);
```

Save it as `C:\alerts\notify.mjs`. This line adds the alert in Git Bash, PowerShell (as `codingsh`)
and cmd:

```sh
coding.sh alert add failures --measure failure-rate --over 0.5 --window 1d --notify "command:node C:\alerts\notify.mjs"
```

A PowerShell script works too. Save this as `C:\alerts\notify.ps1`:

```powershell
# notify.ps1: reads one coding.sh alert on stdin and adds a line to alerts.log next to this file.
$a = [Console]::In.ReadToEnd() | ConvertFrom-Json
Add-Content -Path (Join-Path $PSScriptRoot 'alerts.log') -Value "$($a.at) $($a.alert): $($a.previous) -> $($a.state)"
```

`-ExecutionPolicy Bypass` lets it run where scripts are blocked:

```powershell
codingsh alert add failures --measure failure-rate --over 0.5 --window 1d --notify "command:powershell -NoProfile -ExecutionPolicy Bypass -File C:\alerts\notify.ps1"
```

Windows PowerShell 5.1 drops the double quotes inside an argument when it starts a program, so a
one-line command with inner quotes falls apart: `✗ Unknown option -Path`, then how to write the
quotes. Write each inner quote as `\"`, inside single quotes:

```powershell
codingsh alert add failures --measure failure-rate --over 0.5 --window 1d --notify 'command:powershell -NoProfile -Command \"$input | Add-Content -Path C:\alerts\alerts.log\"'
```

## When a delivery fails

Each notification is tried 3 times, 1 s and then 2 s apart. `alert check` warns about each one that
failed, with the reason: the HTTP status, or the command's exit code and stderr.

The new state is saved either way, and `alert list` shows it. Each check sends the change again
until a delivery gets through, with `previous` set to the state the target last got. Its line in
`alert check` ends `was OK (not delivered before)`. If the state goes back to the one the target
has, the check sends nothing.

After 5 failed deliveries in a row, coding.sh turns the target off and skips it. `alert list` marks
it `(disabled)` and says why. Fix the target, then run `coding.sh alert test <NAME>`: a test that
gets through turns it back on (`Notifications are on again.`), and the next check sends the changes
the target missed.
