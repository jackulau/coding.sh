// JSON-LD builders, derived from src/data/* so structured data cannot drift
// from what the pages render.
import { SITE_URL, SITE, REPO_URL, REPO_PUBLIC, LICENSE_URL, RELEASE } from "../data/site";

export function websiteSchema() {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    "@id": `${SITE_URL}/#website`,
    name: SITE.name,
    url: SITE_URL,
    description: SITE.description,
    inLanguage: "en-US",
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
      item: `${SITE_URL}${item.path}`,
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
    url: SITE_URL,
    logo: `${SITE_URL}/icon-512.png`,
    sameAs: [REPO_URL],
  };
}
