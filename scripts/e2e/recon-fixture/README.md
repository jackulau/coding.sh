# recon-fixture

An owned target for dogfooding the **app-recon** skill: a tiny local HTTP service
with a known API, plus an unminified client bundle with planted strings, so a
reverse-engineering run has a fixed answer key to be graded against. Nothing here
is a real secret, and no third party is ever touched.

- `server.mjs` — `POST /api/login` mints a signed token, `GET /api/feed` needs it,
  `GET /api/config` is open. Run with a port, or `0` to get a free one.
- `client/bundle.js` — the "client binary": planted symbol `makeHarderRanking`,
  config `FEED_RANKING_SALT`, a public `ANALYTICS_WRITE_KEY`, the three endpoints.
- `EXPECTED.md` — the answer key. The verifier reads it; the agent under test
  does not.
- `verify.mjs` — grades an app-recon report against the key. Exits non-zero
  unless it names every endpoint, describes the login -> feed auth chain,
  surfaces the planted artifacts, flags the public key, and states the
  authorization case.
- `run.mjs` — the continuous reference run.

## Continuous check (no model, no Docker)

```sh
node scripts/e2e/recon-fixture/run.mjs
```

Boots the fixture on a free port, performs the recon mechanically, grades the
report, and runs the negative control (an empty report must fail). This keeps the
fixture + verifier loop honest on every edit; it does not exercise a live agent's
reasoning.

## Real agent eval (continuous testing of the skill itself)

To grade the live skill, follow the A/B skill-eval pattern in
`examples/skill-eval/` (Docker, `--candidate` for skill edits, LLM judge):
install app-recon as the arm's skill, point the task repo at this fixture, drive
the recon, and set the task verifier to `node scripts/e2e/recon-fixture/verify.mjs
<report>`. See `docs/how-to/evaluate-a-skill.md`. Because the fixture is owned,
the skill's authorization gate passes on case one, which also tests that the
agent records the gate.
