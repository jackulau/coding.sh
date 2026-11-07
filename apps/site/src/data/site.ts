// Single source of truth for site identity used by machine-readable surfaces
// (JSON-LD, llms.txt, OG tags) and the landing page.

export const SITE_URL = "https://coding.sh";

// The repository is public; the npm name is not published yet. Every copyable
// `npx` command stays gated on PACKAGE_PUBLISHED so the page never invites
// people to run a package name nobody owns.
export const REPO_URL = "https://github.com/jackulau/coding.sh";
export const REPO_PUBLIC = true;
export const PACKAGE_PUBLISHED = false;
export const ISSUES_URL = `${REPO_URL}/issues`;
export const LICENSE_URL = `${REPO_URL}/blob/main/LICENSE`;
export const LICENSE = "MIT";

/** Docs appear in the nav as soon as any page exists under src/pages/docs. */
export const DOCS_PUBLIC =
  Object.keys(import.meta.glob("/src/pages/docs/**/*.{astro,md,mdx,ts}")).length > 0;

/** Build from source, the way to run it before the first npm release. */
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
export const RELEASE = "0.1.0";
export const RELEASE_TGZ = `${REPO_URL}/releases/download/v${RELEASE}/coding.sh-${RELEASE}.tgz`;

export const SITE = {
  name: "coding.sh",
  tagline: "observability and evals for AI agents, on your machine",
  description:
    "coding.sh is open-source, local-first observability and evals for AI agents, in early development. It is being built to record agent runs over a local OpenTelemetry receiver and coding-agent hooks, turn failures into evals with calibrated graders, and compare prompt, harness and model changes with paired statistics. MIT licensed and pre-alpha. Install: curl -fsSL https://coding.sh/install | sh",
  version: "pre-alpha",
  status: "install with curl -fsSL https://coding.sh/install | sh",
} as const;

/** Shown in the version pill; the full history is in /CHANGELOG.md. */
export const VERSION = "0.1";

export const NAV_PAGES = [
  {
    path: "/",
    title: "Home",
    summary: "What coding.sh is, with a working sample of the local viewer, and how recording, evals and comparisons work.",
  },
  {
    path: "/changelog",
    title: "Changelog",
    summary: "Every coding.sh release, newest first, rendered from CHANGELOG.md.",
  },
] as const;
