# Security policy

## Supported versions

coding.sh is pre-1.0. Security fixes go into the latest release only. Run `coding.sh update` to
get it.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's advisory form:
<https://github.com/jackulau/coding.sh/security/advisories/new>.

Do not open a public issue, and do not include real captured sessions or secrets in the report.
Include the version (`coding.sh --version`), your OS and Node version, and steps to reproduce.

You should get an acknowledgement within 3 business days. We agree on a disclosure date with you
and credit you in the advisory unless you prefer otherwise.

## What is in scope

coding.sh runs on your machine, next to your coding agents, and stores what they do. These issues
matter most:

- Secrets reaching the index, blobs, logs or a sink despite redaction.
- Session content leaving the machine without a sink the user configured, or a metadata-mode sink
  sending content.
- A repository-level `.coding.sh/config.toml` that adds sinks, moves the stores or weakens
  redaction (it is only allowed to add privacy).
- The hook blocking, failing or changing the behavior of an agent, or running untrusted input.
- `init` or `uninstall` corrupting or losing an agent's config file, or editing files outside the
  ones it reports.
- The local viewer (127.0.0.1, per-process token), the OTLP receiver or the MCP server being
  reachable or exploitable by other origins or users.
- The update check or `coding.sh update` installing something other than an official release.

## Design notes

- With no sinks configured, no session data is sent anywhere. The only default network request is
  the daily update check (GitHub releases API, falling back to the npm registry). Disable it with
  `CODING_SH_NO_UPDATE_CHECK=1` or `[update] check = false`.
- Spool files, `config.toml`, `installs.json` and config backups are written with mode 600 (or in
  700 directories). The index (`index.db`) and `blobs/` currently follow your umask, so keep your
  home directory private on shared machines.
- npm releases are published from GitHub Actions with provenance. Verify one with
  `npm audit signatures`.
