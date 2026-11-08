# Fly.io

`deploy/fly.toml` runs one machine with SQLite on a volume. Nothing else to provision, and no keys
to make: the first start makes a key pair on the volume. Switch to Postgres with one secret when
you outgrow it.

## 3 steps

Run these from the repo root, after `fly auth login`.

```sh
# 1. Create the app and its volume.
fly launch --no-deploy --copy-config --config deploy/fly.toml --name my-coding-sh
fly volumes create coding_sh_data --size 3 --config deploy/fly.toml

# 2. Deploy the published image, or build it here with --dockerfile Dockerfile instead of --image.
fly deploy --config deploy/fly.toml --image ghcr.io/jackulau/coding.sh:latest

# 3. Read the keys and the connect command from the logs.
fly logs --config deploy/fly.toml --no-tail | grep -A5 'No keys are configured'
```

The image is published from release 0.1.2 on; before that, use `--dockerfile Dockerfile`. The
printed URLs are the machine's own address: use `https://my-coding-sh.fly.dev` in their place.
Connect each developer with `coding.sh init --remote https://my-coding-sh.fly.dev --key csh_ik_…`,
send traces with `CODING_SH_URL=https://my-coding-sh.fly.dev`, and open
`https://my-coding-sh.fly.dev/?t=csh_rk_…`.

To use your own keys instead, set both before the deploy:
`fly secrets set --config deploy/fly.toml CODING_SH_INGEST_KEYS='myapp:csh_ik_…' CODING_SH_READ_KEYS='*:csh_rk_…'`.

## Postgres instead of SQLite

```sh
fly secrets set --config deploy/fly.toml CODING_SH_STORE_URL='postgres://…?sslmode=require'
```

Blobs follow to the same database. You can then remove `[mounts]` from `fly.toml`, but set your own
keys first: without the volume, first-start keys change on every deploy.

## Notes

- **One machine.** SQLite on a volume means exactly one machine. Keep it that way (`fly scale count 1`).
  With Postgres you can add read replicas that run `serve --role viewer`, but only one machine ingests.
- **Always on.** `auto_stop_machines = "off"`: a stopped machine would drop exporter batches.
- **Deploys.** Fly replaces the machine in place: SIGTERM, a drain of up to 25 s (`kill_timeout = 30`),
  then the new version starts. Clients retry during the gap, so nothing is lost. The check is `/readyz`.
  If you switch to the `bluegreen` deploy strategy, change the check to `/healthz`, because the new
  machine waits in standby until the old one releases the writer lock.
- **TLS** is Fly's. `CODING_SH_TRUST_PROXY=1` is set in `fly.toml`.
