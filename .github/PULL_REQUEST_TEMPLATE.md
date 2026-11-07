## What this changes

<!-- One or two sentences. Link the issue if there is one: "Fixes #123". -->

## How I tested it

<!-- Commands you ran and what you saw. For an adapter, say whether you checked it against a live install or only fixtures. -->

## Checklist

- [ ] `npm run check` and `npm run build` pass in `packages/coding.sh`
- [ ] New behavior has tests, and tests point `HOME` and `CODING_SH_HOME` at temp dirs
- [ ] No new runtime dependencies in `packages/coding.sh`
- [ ] If a command, flag or output changed: help text in `src/cli/registry.ts`, the README and `CHANGELOG.md` are updated
- [ ] Anything that stores or sends event content goes through the redactor
