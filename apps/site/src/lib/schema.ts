// JSON-LD builders, derived from src/data/* so structured data cannot drift
// from what the pages render.
import { SITE_URL, SITE, REPO_URL, REPO_PUBLIC, LICENSE_URL, RELEASE, SAME_AS } from "../data/site";

export function websiteSchema() {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    "@id": `${SITE_URL}/#website`,
    name: SITE.name,
    alternateName: [...SITE.altNames],
    // The home page's canonical URL, trailing slash included: Google reads the
    // site name from the WebSite object whose url is the canonical home page.
    url: `${SITE_URL}/`,
    description: SITE.description,
    inLanguage: "en-US",
    publisher: { "@id": `${SITE_URL}/#org` },
  };
}

export function breadcrumbSchema(trail: { name: string; path: string }[]) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: trail.map((item, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: item.name,
      item: new URL(item.path, SITE_URL).toString(),
    })),
  };
}

// The app as installed: free, MIT, from the public repository.
export function softwareSchema() {
  return {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    "@id": `${SITE_URL}/#software`,
    name: SITE.name,
    alternateName: [...SITE.altNames],
    url: SITE_URL,
    description: SITE.description,
    applicationCategory: "DeveloperApplication",
    operatingSystem: "macOS, Linux, Windows",
    softwareVersion: RELEASE,
    softwareRequirements: "Node.js 22.15 or newer",
    installUrl: `${SITE_URL}/install`,
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    license: LICENSE_URL,
    ...(REPO_PUBLIC ? { codeRepository: REPO_URL } : {}),
    publisher: { "@id": `${SITE_URL}/#org` },
  };
}

export function organizationSchema() {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    "@id": `${SITE_URL}/#org`,
    name: SITE.name,
    alternateName: [...SITE.altNames],
    url: SITE_URL,
    logo: `${SITE_URL}/icon-512.png`,
    description: SITE.description,
    sameAs: [...SAME_AS],
  };
}

// One docs page. `path` is the canonical route (/docs/quickstart); dateModified
// is the last commit to its source (src/lib/lastmod.mjs).
export function techArticleSchema(page: { path: string; title: string; summary: string; dateModified: string; image?: string }) {
  const url = new URL(page.path, SITE_URL).toString();
  return {
    "@context": "https://schema.org",
    "@type": "TechArticle",
    "@id": `${url}#article`,
    headline: page.title,
    description: page.summary,
    url,
    mainEntityOfPage: url,
    inLanguage: "en-US",
    dateModified: page.dateModified,
    image: new URL(page.image ?? "/og-image.png", SITE_URL).toString(),
    author: { "@type": "Organization", name: SITE.name, url: SITE_URL },
    publisher: { "@type": "Organization", name: SITE.name, url: SITE_URL, logo: `${SITE_URL}/icon-512.png` },
    // The full WebSite and SoftwareApplication nodes are on the home page only,
    // so these references carry their own type, name and url.
    isPartOf: { "@type": "WebSite", "@id": `${SITE_URL}/#website`, name: SITE.name, url: `${SITE_URL}/` },
    about: { "@type": "SoftwareApplication", "@id": `${SITE_URL}/#software`, name: SITE.name, url: SITE_URL },
  };
}

// In its own file with no imports so test/clamp.test.mjs can load it.
export { clampDescription } from "./clamp";

/** Plain text from a fragment of our own HTML (tags dropped, entities decoded). */
export function plainText(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

// Questions the page itself shows, word for word: the home FAQ, /docs/faq, and
// the "Questions" section of a docs page (DocsLayout finds it).
export function faqSchema(items: { q: string; a: string }[]) {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map((item) => ({
      "@type": "Question",
      name: plainText(item.q),
      acceptedAnswer: { "@type": "Answer", text: plainText(item.a) },
    })),
  };
}
