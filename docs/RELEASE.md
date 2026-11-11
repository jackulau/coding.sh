# Releasing coding.sh

This is the checklist for publishing coding.sh and deploying the site. A tag `vX.Y.Z` creates the
GitHub release as soon as the checks pass, with no approval and no credentials, so
`curl -fsSL https://coding.sh/install | sh` gets the new version right away. The same tag also
publishes five packages, once you approve the npm and PyPI jobs and their credentials exist:

| Package | Registry | Source |
|---|---|---|
| `coding.sh` (CLI) | npm | `packages/coding.sh` |
| `@codingdotsh/sdk` | npm | `packages/sdk` |
| `coding.sh-store-postgres` | npm | `packages/store-postgres` |
| `coding.sh-store-s3` | npm | `packages/blob-s3` |
| `coding-sh` (Python SDK) | PyPI | `packages/sdk-python` |

The canonical repository is **`https://github.com/jackulau/coding.sh`**. These files all name it,
so change all of them together if the repo moves (for example to a `coding-sh` org):

| File | Value |
|---|---|
| `apps/site/src/data/site.ts` | `REPO_URL` |
| `packages/*/package.json`, `packages/sdk-python/pyproject.toml` | `repository`, `bugs`, project URLs (npm provenance requires `repository` to match the repo) |
| `packages/coding.sh/src/update/index.ts` | `REPO` (update checks; the npm fallback also requires `repository` to contain it) |
| `install.sh` | `REPO` |
| `.github/workflows/release.yml` | the trusted publishers on npm and PyPI are bound to this repo and workflow |
| `CHANGELOG.md`, `SECURITY.md`, `CONTRIBUTING.md`, `README.md`, `.github/ISSUE_TEMPLATE/config.yml` | links |

## First publish

The npm steps are done: `coding.sh`, `@codingdotsh/sdk` and the store plugins are on npm. PyPI is
not: `coding-sh` has no release yet, so step 4 is still open. Until it is done, each tag's PyPI job
sits waiting for approval; reject it, or leave it. Everything in the repo is ready (`scripts/release/smoke.sh` packs, installs and exercises
all five packages); these are the steps only you can do. Your npm and PyPI accounts need
two-factor authentication on.

1. **Log in to npm** on your machine: `npm login`, then `npm whoami`.
2. **Create the npm org** that owns `@codingdotsh/sdk`: npmjs.com → your avatar → **Add
   Organization** → name `coding.sh` → **Unlimited public packages (free)**. The unscoped names
   `coding.sh`, `coding.sh-store-postgres` and `coding.sh-store-s3` need no org.
3. **Give CI a one-time npm token.** npm can attach a trusted publisher only to a package that
   already exists, so the first publish uses a token. npmjs.com → **Access Tokens → Generate New
   Token**: check **Bypass two-factor authentication**, **Packages and scopes** = *Read and write*
   on *All packages*, expiration 7 days. Copy it, then:
   ```sh
   gh secret set NPM_TOKEN --env release --repo jackulau/coding.sh   # paste the token
   ```
4. **Add the PyPI pending publisher** (this creates the `coding-sh` project on first publish):
   pypi.org → **Your account → Publishing → Add a new pending publisher → GitHub**. PyPI project
   name `coding-sh`, owner `jackulau`, repository `coding.sh`, workflow `release.yml`, environment
   `release`.
5. **Keep v0.1.0 as it is.** The v0.1.0 tag and GitHub release (commit `011401c`, 2026-11-06)
   never reached npm. Leave them alone: the first npm and PyPI publish is the next version you tag
   (0.1.1 or later), and the workflow refuses to replace a release that holds a different tarball.
6. **Tag** (see the release checklist below for the version bump and changelog):
   ```sh
   git checkout main && git pull
   git tag -a vX.Y.Z -m "coding.sh X.Y.Z" && git push origin vX.Y.Z
   ```
   The GitHub release appears as soon as *verify* passes.
7. **Approve.** GitHub → **Actions → Release**: when *verify* and *github-release* are green,
   **Review deployments** → tick `release` for both *publish-npm* and *publish-pypi* → **Approve
   and deploy**. If an earlier tag's npm and PyPI jobs were never approved, approve the newest
   tag's run only.
8. **Switch npm to trusted publishing and drop the token** (needs npm 11.15+, hence `npx npm@11`):
   ```sh
   for p in coding.sh @codingdotsh/sdk coding.sh-store-postgres coding.sh-store-s3; do
     npx -y npm@11 trust github "$p" --file release.yml --repo jackulau/coding.sh --env release --allow-publish --yes
   done
   gh secret delete NPM_TOKEN --env release --repo jackulau/coding.sh
   ```
   Then delete the token on npmjs.com → **Access Tokens**. From now on each release publishes
   through OIDC with provenance and no stored secret.
9. **Turn on the npm commands on the site:** set `PACKAGE_PUBLISHED = true` in
   `apps/site/src/data/site.ts` and push to `main` (the Site workflow deploys it).

Check it worked: `npm view coding.sh version`, `npm view @codingdotsh/sdk version`,
`pip index versions coding-sh`, `gh release view vX.Y.Z`.

## How a release flows

1. You push a tag `vX.Y.Z` that matches `packages/coding.sh/package.json`.
2. `.github/workflows/release.yml`, job **verify** (GitHub-hosted): checks that the tag matches
   the version and that `CHANGELOG.md` has a `## [X.Y.Z]` section, typechecks and tests every
   package (store-postgres against a real Postgres service), packs the four npm tarballs, builds
   the Python sdist and wheel, runs `scripts/release/smoke.sh` on those exact files, and dry-runs the
   npm publish with `scripts/release/publish-npm.sh`, the same script publish-npm runs.
3. Job **github-release** (GitHub-hosted, no environment, no approval) runs as soon as verify
   passes. It creates the GitHub release `vX.Y.Z` with the verified `coding.sh-X.Y.Z.tgz`, the same
   bytes npm gets, attached and that CHANGELOG section as the notes. From then on install.sh and
   `coding.sh update` install the new version from the release.
4. Jobs **publish-npm** and **publish-pypi** need github-release and wait for approval in the
   `release` environment. publish-npm publishes `coding.sh`, `@codingdotsh/sdk`,
   `coding.sh-store-postgres` and `coding.sh-store-s3` in that order (the stores peer-depend on
   `coding.sh`) with provenance. publish-pypi publishes `coding-sh` through PyPI trusted
   publishing. Without approval or credentials they wait, and the GitHub release stands on its own.
5. Each package publishes the version in its own manifest, and a version already on the registry
   is skipped. So a release that only bumps the CLI republishes nothing else, and **Re-run failed
   jobs** is always safe. An existing GitHub release is reused when its tarball matches (and gets
   the tarball uploaded if it has none) and rejected when it doesn't; then github-release fails
   and neither publish job runs.
6. Users get the CLI three ways. `npm i -g coding.sh` and `npx coding.sh` install from npm.
   `curl -fsSL https://coding.sh/install | sh` installs from npm when the registry has the
   version and from the GitHub release tarball otherwise (`CODING_SH_SOURCE=npm|github` forces
   one). `coding.sh update` installs the newest of the two. Running installs show the update
   notice within a day.

The GitHub release asset has to be named `coding.sh-X.Y.Z.tgz`, which is what `npm pack`
produces. `install.sh` and `coding.sh update` depend on that name.

No release job runs on the self-hosted desk runner: npm and PyPI trusted publishing only accept
GitHub-hosted runners, and the workflow only runs for `v*.*.*` tags, which only people with write access can push. The
`release` environment also accepts deployments from those tags only.

## Release checklist (every release)

```sh
cd ~/coding-sh && git checkout main && git pull
```

- [ ] `packages/coding.sh/package.json` has the new version, and the `packages/coding.sh` entry in
      `package-lock.json` matches (`npm install --package-lock-only` updates it).
- [ ] Bump `packages/sdk`, `packages/store-postgres`, `packages/blob-s3` and
      `packages/sdk-python` (`pyproject.toml` and `__version__` in `_client.py`) only if they
      changed. Unchanged versions are skipped on publish.
- [ ] `CHANGELOG.md` has `## [X.Y.Z] - YYYY-MM-DD` (replace `Unreleased` with today's date) and a
      `[X.Y.Z]: https://github.com/jackulau/coding.sh/releases/tag/vX.Y.Z` link.
- [ ] `apps/site/src/data/site.ts`: `RELEASE` is `X.Y.Z`, `VERSION` matches, and once the
      package is on npm, `PACKAGE_PUBLISHED = true` (this turns on the `npx` commands on the site).
- [ ] The README and `packages/coding.sh/README.md` agent statuses still match reality.
- [ ] Local gates pass:
      ```sh
      cd packages/coding.sh
      npx tsc -p tsconfig.json --noEmit
      npm test
      npm run build
      npm pack --dry-run  # expect only dist/*.mjs, dist/types, README.md, LICENSE, package.json
      cd ../../apps/site && npm run build && npm run check
      cd ../.. && scripts/release/smoke.sh   # packs, installs and exercises all five packages
      ```
- [ ] Commit, tag and push:
      ```sh
      git commit -am "Release X.Y.Z"
      git tag -a vX.Y.Z -m "coding.sh X.Y.Z"
      git push origin main vX.Y.Z
      ```
- [ ] In **Actions → Release**, wait for *verify* and *github-release* (the GitHub release is
      live now), then approve *publish-npm* and *publish-pypi* once their credentials exist.
- [ ] Verify the release:
      ```sh
      npm view coding.sh version                 # X.Y.Z
      npm view @codingdotsh/sdk version            # and the stores, if bumped
      pip index versions coding-sh               # if bumped
      npm audit signatures                       # in any project that depends on it
      gh release view vX.Y.Z                     # has coding.sh-X.Y.Z.tgz
      npx -y coding.sh@X.Y.Z --version
      curl -fsSL https://coding.sh/install | CODING_SH_NO_INIT=1 sh && coding.sh --version
      ```
- [ ] Deploy the site (below), so `/changelog` and `/install` show the new release.

### If the publish job fails

- **npm or PyPI publish failed** (auth or name): fix the token or the trusted publisher, then use
  **Re-run failed jobs**. Packages that did publish are skipped on the re-run. The GitHub release
  is already up and is left as it is.
- **"release vX.Y.Z already has a different coding.sh-X.Y.Z.tgz"**: a GitHub release for this
  version was made from another commit. Delete it (`gh release delete vX.Y.Z --cleanup-tag`) and
  re-tag, or release a new version. Nothing was published.
- **github-release failed for another reason** (a GitHub API error): use **Re-run failed jobs**.
  It reuses a release that already exists and uploads the tarball if it is missing. The publish
  jobs only start after it succeeds.
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

After deploying, check:

```sh
curl -sI https://coding.sh/install | grep -i content-type     # text/plain; charset=utf-8
curl -fsSL https://coding.sh/install | head -3                 # the installer, not HTML
curl -s https://coding.sh/llms.txt | head -3
curl -sI https://coding.sh/schema.json | grep -i content-type  # application/schema+json
curl -s https://coding.sh/schema.json | cmp - packages/coding.sh/src/schema/trace.schema.json && echo "schema matches"
```

The trace schema's `$id` is that URL, so a release whose site was not deployed leaves it stale or
missing.


## Known issues to weigh before a release

None of these block the release, but each one is worth a decision:

- **`index.db` and `blobs/` follow the umask** (usually 644/755), unlike the spool and config files
  (600/700). On a shared machine, other local users can read captured sessions unless the home
  directory is private.
- **Timing tests** (hook latency, `--help` startup, snapshot, redaction and batch-write speed)
  compare against a baseline measured in the same process, so load alone should not fail them.
  If one does fail on a shared runner, its message prints both numbers.
