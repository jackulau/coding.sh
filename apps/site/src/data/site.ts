// Single source of truth for site identity used by machine-readable surfaces
// (JSON-LD, llms.txt, OG tags) and the landing page.

export const SITE_URL = "https://coding.sh";

// The repository is public and coding.sh is on npm. Every copyable `npx`
// command stays gated on PACKAGE_PUBLISHED so the page never invites people to
// run a package name nobody owns.
export const REPO_URL = "https://github.com/jackulau/coding.sh";
export const REPO_PUBLIC = true;
export const PACKAGE_PUBLISHED = true;
export const ISSUES_URL = `${REPO_URL}/issues`;
export const LICENSE_URL = `${REPO_URL}/blob/main/LICENSE`;
export const LICENSE = "MIT";
/** The npm package and the npm org that publishes the SDK (@codingdotsh/sdk). */
export const NPM_URL = "https://www.npmjs.com/package/coding.sh";
export const NPM_ORG_URL = "https://www.npmjs.com/org/codingdotsh";
/**
 * Profiles that are this project, for schema.org sameAs. Only URLs that exist
 * and that this project controls: checked 2026-11-08 (the repo answers 200; the
 * npm registry lists coding.sh and the codingdotsh org's @codingdotsh/sdk).
 */
export const SAME_AS = [REPO_URL, NPM_URL, NPM_ORG_URL] as const;

/** Docs appear in the nav as soon as any page exists under src/pages/docs. */
export const DOCS_PUBLIC =
  Object.keys(import.meta.glob("/src/pages/docs/**/*.{astro,md,mdx,ts}")).length > 0;

/** Build from source, for running the repository version. */
export const SOURCE_STEPS = [
  `git clone ${REPO_URL}`,
  "cd coding.sh && npm i && npm run build",
] as const;
export const CLI_PATH = "packages/coding.sh/dist/cli.mjs";
/** The one-liner once it is on npm. */
export const INSTALL_CMD = "npx coding.sh init";
/** The installer (repo root install.sh, served at /install): latest GitHub release, then `init`, then the viewer. */
export const INSTALL_SH = "curl -fsSL https://coding.sh/install | sh";
/** The release tarball the installer fetches (install.sh: releases/download/<tag>/coding.sh-<n>.tgz). */
export const RELEASE = "0.1.5";
export const RELEASE_TGZ = `${REPO_URL}/releases/download/v${RELEASE}/coding.sh-${RELEASE}.tgz`;

export const SITE = {
  name: "coding.sh",
  // How people also write and say the name: the `.sh` reads as "shell". Used as
  // schema.org alternateName so the brand is found when spelled as words.
  // Every spelling people type for the brand, so a search for any of them can
  // resolve to this site: the words, the run-together form, the npm scope
  // (@codingdotsh) and the CLI's second bin name (codingsh).
  altNames: ["coding shell", "coding sh", "codingsh", "coding dot sh", "codingdotsh", "coding-sh", "coding.sh cli"],
  tagline: "observability and evals for AI agents, on your machine",
  description:
    "coding.sh is open-source, local-first observability and evals for AI agents. It records agent runs through coding-agent hooks and a local OpenTelemetry receiver, turns failures into evals with calibrated graders, and compares prompt, harness and model changes with paired statistics. MIT licensed, v0.1.4. Install: curl -fsSL https://coding.sh/install | sh",
  version: "v0.1.4, early",
  status: "install with curl -fsSL https://coding.sh/install | sh",
} as const;

/** Shown in the version pill; the full history is in /CHANGELOG.md. */
export const VERSION = "0.1.5";

export const NAV_PAGES = [
  {
    path: "/",
    title: "Home",
    summary: "What coding.sh is: a real view of the local viewer, what agents cost, and how to check that a change helped.",
  },
  {
    path: "/changelog",
    title: "Changelog",
    summary: "Every coding.sh release, newest first, rendered from CHANGELOG.md.",
  },
  {
    path: "/blog",
    title: "Blog",
    summary: "Notes on how coding.sh works and why, newest first.",
  },
] as const;
