# Releasing coding.sh

This is the checklist for publishing `coding.sh` to npm and GitHub and deploying the site. It
covers 0.1.0 and every release after it. Nothing here runs automatically: a human runs every
command below.

The canonical repository is **`https://github.com/jackulau/coding.sh`**. These files all name it,
so change all of them together if the repo moves (for example to a `coding-sh` org):

| File | Value |
|---|---|
| `apps/site/src/data/site.ts` | `REPO_URL` |
| `packages/coding.sh/package.json` | `repository`, `bugs` |
| `packages/coding.sh/src/update/index.ts` | `REPO` (update checks; the npm fallback also requires `repository` to contain it) |
| `install.sh` | `REPO` |
| `CHANGELOG.md`, `SECURITY.md`, `CONTRIBUTING.md`, `README.md`, `.github/ISSUE_TEMPLATE/config.yml` | links |

## How a release flows

1. You push a tag `vX.Y.Z` that matches `packages/coding.sh/package.json`.
2. `.github/workflows/release.yml`, job **verify**, checks that the tag matches the version and
   that `CHANGELOG.md` has a `## [X.Y.Z]` section. It then runs the typecheck and the tests,
   builds, and packs `coding.sh-X.Y.Z.tgz`.
3. Job **publish** waits for approval in the `release` environment. After approval it runs
   `npm publish coding.sh-X.Y.Z.tgz --provenance` and creates the GitHub release `vX.Y.Z` with
   the same tarball attached, using that CHANGELOG section as the notes.
4. Users get the release three ways. `npm i -g coding.sh` and `npx coding.sh` install from npm.
   `curl -fsSL https://coding.sh/install | sh` and `coding.sh update` install the tarball attached
   to the latest GitHub release (`releases/download/vX.Y.Z/coding.sh-X.Y.Z.tgz`). Running installs
   show the update notice within a day.

The GitHub release asset has to be named `coding.sh-X.Y.Z.tgz`, which is what `npm pack`
produces. `install.sh` and `coding.sh update` depend on that name.

## One-time setup

### 1. Review what gets pushed

The working tree has never been committed. Before the first push, decide what stays private.
These paths hold personal traces, internal agent workflows or local tooling:

- `tasks/` (plans, lessons, dogfood scorecards, QA notes)
- `docs/research/` (including `my-traces.md` and `rodev-*.md`)
- `.claude/` (workflow scripts; `.claude/bin/` and `settings.local.json` are already ignored)
- `.codex/hooks.json` (the dogfood hook config)
- `scripts/traces/`, `scripts/dogfood/`

Either add the ones you want to keep private to `.gitignore`, or move them out of the repo. Then:

```sh
cd ~/coding-sh
git status --short            # check nothing unexpected is listed
git ls-files --others --exclude-standard | xargs grep -IlE 'sk-ant-|ghp_|github_pat_|AKIA|xox[abpr]-|npm_[A-Za-z0-9]{36}|BEGIN [A-Z ]*PRIVATE KEY' || true
```

The only hits should be the redaction rules and their tests (`src/core/redact.ts`,
`test/core/redact.test.ts` and similar), which contain fake keys.

### 2. Create the GitHub repository and push

```sh
gh auth login
git checkout -b main                       # the local branch is "master" with no commits
git add -A
git commit -m "coding.sh 0.1.0"
gh repo create jackulau/coding.sh --public --source . --remote origin \
  --description "Local-first observability and evals for any AI agent" \
  --homepage https://coding.sh
git push -u origin main
```

Then, in the repository settings:

- **Settings → Environments → New environment → `release`**. Add yourself under *Required
  reviewers*, and restrict deployment to tags matching `v*.*.*`.
- **Settings → Code security**: enable *Private vulnerability reporting*, which `SECURITY.md`
  links to.
- **Settings → Actions → General**: leave the default workflow permissions read-only. The release
  job asks for `contents: write` and `id-token: write` itself.
- Wait for the first **CI** run on `main` to pass (Node 22 and 24, Ubuntu and macOS).

### 3. Claim the npm name

```sh
npm view coding.sh            # expect E404 while the name is free
npm login
npm whoami
```

npm trusted publishing can only be configured for a package that already exists, so the first
publish uses a token:

1. On npmjs.com, go to **Access Tokens → Generate New Token → Granular**. Give it *Read and write*
   on all packages (or only `coding.sh` once it exists) and a short expiry.
2. Store it as a secret in the `release` environment, not in the repository:
   ```sh
   gh secret set NPM_TOKEN --env release --repo jackulau/coding.sh
   ```
3. After 0.1.0 is out: on npmjs.com open **coding.sh → Settings → Trusted publishing**, add GitHub
   Actions with repository `jackulau/coding.sh`, workflow `release.yml` and environment `release`.
   Then delete the `NPM_TOKEN` secret and the token. The workflow publishes through OIDC when no
   token is set.

To claim the name before CI is ready, you can also publish 0.1.0 by hand from a clean checkout:
`cd packages/coding.sh && npm publish --access public`. `prepublishOnly` runs the check and the
build first. That publish has no provenance. Then create the GitHub release by hand, as shown
under "If the publish job fails" below.

## Release checklist (every release)

```sh
cd ~/coding-sh && git checkout main && git pull
```

- [ ] `packages/coding.sh/package.json` has the new version, and the `packages/coding.sh` entry in
      `package-lock.json` matches (`npm install --package-lock-only` updates it).
- [ ] `CHANGELOG.md` has `## [X.Y.Z] - YYYY-MM-DD` (replace `Unreleased` with today's date) and a
      `[X.Y.Z]: https://github.com/jackulau/coding.sh/releases/tag/vX.Y.Z` link.
- [ ] `apps/site/src/data/site.ts`: `RELEASE` is `X.Y.Z`, `VERSION` matches, and once the
      package is on npm, `PACKAGE_PUBLISHED = true` (this turns on the `npx` commands on the site).
- [ ] The README and `packages/coding.sh/README.md` agent statuses still match reality.
- [ ] Local gates pass:
      ```sh
      cd packages/coding.sh
      npx tsc -p tsconfig.json --noEmit
      npm test            # timing tests assume an idle machine; rerun failures alone
      npm run build
      npm pack --dry-run  # expect only dist/*.mjs, README.md, LICENSE, package.json
      cd ../../apps/site && npm run build && npm run check
      ```
- [ ] Hands-on smoke from the packed tarball in a throwaway HOME:
      ```sh
      cd packages/coding.sh && npm pack
      export T=$(mktemp -d) && mkdir -p "$T/home/.claude"
      HOME="$T/home" npm i -g --prefix "$T/prefix" ./coding.sh-X.Y.Z.tgz
      HOME="$T/home" NO_UPDATE_NOTIFIER=1 "$T/prefix/bin/coding.sh" init --agent claude-code --yes
      HOME="$T/home" NO_UPDATE_NOTIFIER=1 "$T/prefix/bin/coding.sh" doctor
      HOME="$T/home" NO_UPDATE_NOTIFIER=1 "$T/prefix/bin/coding.sh" uninstall --yes
      rm coding.sh-X.Y.Z.tgz
      ```
- [ ] Commit, tag and push:
      ```sh
      git commit -am "Release X.Y.Z"
      git tag -a vX.Y.Z -m "coding.sh X.Y.Z"
      git push origin main vX.Y.Z
      ```
- [ ] In **Actions → Release**, wait for *verify* to pass, then approve *publish*.
- [ ] Verify the release:
      ```sh
      npm view coding.sh version                 # X.Y.Z
      npm audit signatures                       # in any project that depends on it
      gh release view vX.Y.Z                     # has coding.sh-X.Y.Z.tgz
      npx -y coding.sh@X.Y.Z --version
      curl -fsSL https://coding.sh/install | CODING_SH_NO_INIT=1 sh && coding.sh --version
      ```
- [ ] Deploy the site (below), so `/changelog` and `/install` show the new release.

### If the publish job fails

- **npm publish failed** (auth or name): fix the secret or the trusted publisher, then use
  **Re-run failed jobs**. Nothing was published.
- **npm succeeded but the GitHub release failed**: create the release by hand from the same
  tarball. A rebuild produces a different tarball, so download the workflow artifact instead:
  ```sh
  gh run download <run-id> -n tarball
  gh release create vX.Y.Z coding.sh-X.Y.Z.tgz --title "coding.sh X.Y.Z" --notes-file <notes>
  ```
- **A broken version reached npm**: run `npm deprecate coding.sh@X.Y.Z "<reason>"` and release
  X.Y.(Z+1). Do not unpublish.

## Deploying the site

`apps/site` is a static Astro build. `npm run build` writes `apps/site/dist/`, which includes the
installer at `/install` and `/install.sh` (copied from the repo's `install.sh` at build time),
`llms.txt`, the Markdown twins and `_headers`. It needs Node 22 or newer and reads files outside
`apps/site` (`install.sh`, `CHANGELOG.md`), so build from the repository root.

### Cloudflare Pages (primary; uses `public/_headers`)

Dashboard: **Workers & Pages → Create → Pages → Connect to Git → jackulau/coding.sh**.

| Setting | Value |
|---|---|
| Production branch | `main` |
| Root directory | *(empty: repository root)* |
| Build command | `npm ci && npm run build -w @coding.sh/site` |
| Build output directory | `apps/site/dist` |
| Environment variable | `NODE_VERSION=22` |

Or deploy from your machine:

```sh
npm ci && npm run build -w @coding.sh/site
npx wrangler pages project create coding-sh --production-branch main
npx wrangler pages deploy apps/site/dist --project-name coding-sh --branch main
```

Then add the custom domain `coding.sh` under the project's *Custom domains*. `_headers` sets
immutable caching for `/_astro/*`, UTF-8 text for `/install`, `/install.sh`, `*.txt` and `*.md`,
and the Atom type for `/changelog.xml`.

### Vercel (alternative; uses `apps/site/vercel.json`)

Dashboard: **Add New → Project → Import jackulau/coding.sh**.

| Setting | Value |
|---|---|
| Root Directory | `apps/site` |
| Include files outside the root directory | enabled (the build imports `../../install.sh` and `../../CHANGELOG.md`) |
| Framework preset | Astro |
| Build command | `npm run build` |
| Output directory | `dist` |
| Node.js version | 22.x |

Or from your machine:

```sh
cd apps/site
npx vercel link          # choose the scope and project
npx vercel --prod
```

Vercel ignores `_headers`. `vercel.json` sets the content types for `/install`, `/install.sh`,
`/changelog.xml`, `llms.txt` and `llms-full.txt`. Port the cache rules from `_headers` into
`vercel.json` if you want them on Vercel too.

After either deploy, check:

```sh
curl -sI https://coding.sh/install | grep -i content-type     # text/plain; charset=utf-8
curl -fsSL https://coding.sh/install | head -3                 # the installer, not HTML
curl -s https://coding.sh/llms.txt | head -3
```

## Not part of 0.1.0

These exist in the repository but are not released or documented as supported yet:

- `coding.sh serve`, the production server described in `docs/PRODUCTION.md`, along with the
  `Dockerfile`, `docker-compose.yml`, `render.yaml` and `deploy/` that run it. The 0.1.0 CLI has
  no `serve` command.
- `@coding.sh/sdk`, `packages/sdk-python`, `coding.sh-store-postgres` and `coding.sh-store-s3`
  (all still at 0.0.1, none published).

## Known issues to weigh before tagging 0.1.0

None of these block the release, but each one is worth a decision:

- **`npx coding.sh init` registers the MCP server at the npx cache path.** The hook is copied to
  `~/.coding.sh/bin`, but the MCP entry runs `node ~/.npm/_npx/<hash>/…/dist/cli.mjs mcp`. That
  path disappears on `npm cache clean`. The README recommends `npm i -g` for this reason.
- **`index.db` and `blobs/` follow the umask** (usually 644/755), unlike the spool and config files
  (600/700). On a shared machine, other local users can read captured sessions unless the home
  directory is private.
- **The `coding.sh/store` and `coding.sh/store/conformance` exports** point `types` at
  `src/store/*.ts`, which the tarball does not include (`files` ships only `dist/*.mjs`). The
  runtime entries resolve. Only TypeScript consumers of the not-yet-published store plugin API
  are affected.
- **Timing tests** (hook latency, `--help` startup, snapshot and batch-write speed) fail on a
  heavily loaded machine. Watch for them on shared CI runners.
