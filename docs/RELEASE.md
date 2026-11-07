# Releasing coding.sh

This is the checklist for publishing coding.sh and deploying the site. One tag publishes five
packages:

| Package | Registry | Source |
|---|---|---|
| `coding.sh` (CLI) | npm | `packages/coding.sh` |
| `@coding.sh/sdk` | npm | `packages/sdk` |
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

Nothing is on npm or PyPI yet. Everything in the repo is ready (`scripts/release/smoke.sh` packs,
installs and exercises all five packages); these are the steps only you can do. Your npm and PyPI
accounts need two-factor authentication on.

1. **Log in to npm** on your machine: `npm login`, then `npm whoami`.
2. **Create the npm org** that owns `@coding.sh/sdk`: npmjs.com → your avatar → **Add
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
5. **Remove the stale v0.1.0.** The existing tag and GitHub release were cut from an older commit
   (`011401c`) whose release run failed in verify, so nothing reached npm. The workflow refuses to
   publish while that release holds a different tarball:
   ```sh
   gh release delete v0.1.0 --cleanup-tag --yes --repo jackulau/coding.sh
   git tag -d v0.1.0 2>/dev/null; true
   ```
   (Until step 6 finishes, `curl https://coding.sh/install | sh` has no release to install.
   To keep v0.1.0 as it is instead, bump every package to 0.1.1 and release that.)
6. **Date the changelog and tag:**
   ```sh
   git checkout main && git pull
   sed -i.bak "s/^## \[0.1.0\] - Unreleased/## [0.1.0] - $(date +%F)/" CHANGELOG.md && rm CHANGELOG.md.bak
   git commit -m "Release 0.1.0" CHANGELOG.md && git push origin main
   git tag -a v0.1.0 -m "coding.sh 0.1.0" && git push origin v0.1.0
   ```
7. **Approve.** GitHub → **Actions → Release**: when *verify* is green, **Review deployments** →
   tick `release` for both *publish-npm* and *publish-pypi* → **Approve and deploy**.
8. **Switch npm to trusted publishing and drop the token** (needs npm 11.15+, hence `npx npm@11`):
   ```sh
   for p in coding.sh @coding.sh/sdk coding.sh-store-postgres coding.sh-store-s3; do
     npx -y npm@11 trust github "$p" --file release.yml --repo jackulau/coding.sh --env release --allow-publish --yes
   done
   gh secret delete NPM_TOKEN --env release --repo jackulau/coding.sh
   ```
   Then delete the token on npmjs.com → **Access Tokens**. From now on each release publishes
   through OIDC with provenance and no stored secret.
9. **Turn on the npm commands on the site:** set `PACKAGE_PUBLISHED = true` in
   `apps/site/src/data/site.ts` and push to `main` (the Site workflow deploys it).

Check it worked: `npm view coding.sh version`, `npm view @coding.sh/sdk version`,
`pip index versions coding-sh`, `gh release view v0.1.0`.

## How a release flows

1. You push a tag `vX.Y.Z` that matches `packages/coding.sh/package.json`.
2. `.github/workflows/release.yml`, job **verify** (GitHub-hosted): checks that the tag matches
   the version and that `CHANGELOG.md` has a `## [X.Y.Z]` section, typechecks and tests every
   package (store-postgres against a real Postgres service), packs the four npm tarballs, builds
   the Python sdist and wheel, and runs `scripts/release/smoke.sh` on those exact files.
3. Jobs **publish-npm** and **publish-pypi** wait for approval in the `release` environment.
   publish-npm publishes `coding.sh`, `@coding.sh/sdk`, `coding.sh-store-postgres` and
   `coding.sh-store-s3` in that order (the stores peer-depend on `coding.sh`) with provenance,
   then creates the GitHub release `vX.Y.Z` with the same `coding.sh-X.Y.Z.tgz` attached and that
   CHANGELOG section as the notes. publish-pypi publishes `coding-sh` through PyPI trusted
   publishing.
4. Each package publishes the version in its own manifest, and a version already on the registry
   is skipped. So a release that only bumps the CLI republishes nothing else, and **Re-run failed
   jobs** is always safe. An existing GitHub release is reused when its tarball matches and
   rejected (before anything is published) when it doesn't.
5. Users get the CLI three ways. `npm i -g coding.sh` and `npx coding.sh` install from npm.
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
      npm test            # timing tests assume an idle machine; rerun failures alone
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
- [ ] In **Actions → Release**, wait for *verify* to pass, then approve *publish-npm* and
      *publish-pypi*.
- [ ] Verify the release:
      ```sh
      npm view coding.sh version                 # X.Y.Z
      npm view @coding.sh/sdk version            # and the stores, if bumped
      pip index versions coding-sh               # if bumped
      npm audit signatures                       # in any project that depends on it
      gh release view vX.Y.Z                     # has coding.sh-X.Y.Z.tgz
      npx -y coding.sh@X.Y.Z --version
      curl -fsSL https://coding.sh/install | CODING_SH_NO_INIT=1 sh && coding.sh --version
      ```
- [ ] Deploy the site (below), so `/changelog` and `/install` show the new release.

### If the publish job fails

- **npm or PyPI publish failed** (auth or name): fix the token or the trusted publisher, then use
  **Re-run failed jobs**. Packages that did publish are skipped on the re-run.
- **"release vX.Y.Z already has a different coding.sh-X.Y.Z.tgz"**: a GitHub release for this
  version was made from another commit. Delete it (`gh release delete vX.Y.Z --cleanup-tag`) and
  re-tag, or release a new version. Nothing was published.
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


## Known issues to weigh before tagging 0.1.0

None of these block the release, but each one is worth a decision:

- **`index.db` and `blobs/` follow the umask** (usually 644/755), unlike the spool and config files
  (600/700). On a shared machine, other local users can read captured sessions unless the home
  directory is private.
- **Timing tests** (hook latency, `--help` startup, snapshot and batch-write speed) fail on a
  heavily loaded machine. Watch for them on shared CI runners.
