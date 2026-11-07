// @ts-check
import { defineConfig } from 'astro/config';

import tailwindcss from '@tailwindcss/vite';
import sitemap from '@astrojs/sitemap';
import { isAgentExcluded } from './src/lib/agent-routes.mjs';
import { pageLastmod } from './src/lib/lastmod.mjs';

// https://astro.build/config
export default defineConfig({
  site: 'https://coding.sh',
  // URLs carry no trailing slash (/docs/quickstart), matching internal links;
  // the worker's assets config (html_handling: drop-trailing-slash) agrees.
  trailingSlash: 'never',
  // No UI framework integration: every interactive piece is a plain module
  // script, so there is no renderer to ship to the client.
  //
  // Unlisted routes (see src/lib/agent-routes.mjs) are kept out of the sitemap,
  // out of llms-full.txt, and get no Markdown twin — one list, three surfaces.
  // Each URL's <lastmod> is the last commit to its source (src/lib/lastmod.mjs).
  integrations: [
    sitemap({
      filter: (page) => !isAgentExcluded(new URL(page).pathname),
      serialize: (item) => ({ ...item, lastmod: pageLastmod(new URL(item.url).pathname) }),
    }),
  ],
  output: 'static',
  // CSS is ~10KB gzipped per page. Inlining it saves the render-blocking round
  // trip (about 600ms of LCP on Slow 4G).
  build: { inlineStylesheets: 'always' },

  vite: {
    // The workspace hoists a newer vite than the one astro bundles, so the
    // plugin's types don't line up; the runtime contract is the same.
    plugins: [/** @type {any} */ (tailwindcss())],
  }
});
