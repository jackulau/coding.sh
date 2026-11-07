// Routes withheld from agent-facing surfaces (sitemap, llms-full.txt, Markdown
// twins). Plain .mjs so both the Astro layout and scripts/gen-agent-text.mjs can
// import it. Only the 404 page is unlisted.
export const AGENT_EXCLUDED = [/^\/404\/?$/];

export const isAgentExcluded = (path) => AGENT_EXCLUDED.some((re) => re.test(path));
