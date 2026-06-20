import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// Module-level registry — accumulates domains during a scrape run, flushed once in main()
const discoveredRegistry = new Set<string>();

function cleanHostname(raw: string): string | null {
  try {
    // Accept bare domains or full URLs
    const normalized = raw.includes("://") ? raw : `https://${raw}`;
    const hostname = new URL(normalized).hostname.toLowerCase().replace(/^www\./, "");
    // Skip empty, IP addresses, or obviously non-company-website strings
    if (!hostname || /^\d+\.\d+\.\d+\.\d+$/.test(hostname)) return null;
    return hostname;
  } catch {
    return null;
  }
}

/**
 * Extracts company website domains from schema.org/JobPosting JSON-LD in HTML.
 * Looks at hiringOrganization.sameAs fields. Never throws.
 */
export function extractDiscoveredDomains(html: string): string[] {
  const domains: string[] = [];

  // Find all <script type="application/ld+json"> blocks
  const scriptRegex = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;

  while ((match = scriptRegex.exec(html)) !== null) {
    const raw = match[1];
    if (!raw) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Malformed JSON-LD — skip silently
      continue;
    }

    // Normalize to an array of nodes (handle @graph, single object, or bare array)
    const nodes: unknown[] = [];
    if (Array.isArray(parsed)) {
      // Could be an array of nodes or a @graph pattern
      for (const item of parsed) {
        if (item && typeof item === "object") {
          const obj = item as Record<string, unknown>;
          if (Array.isArray(obj["@graph"])) {
            for (const n of obj["@graph"] as unknown[]) {
              nodes.push(n);
            }
          } else {
            nodes.push(item);
          }
        }
      }
    } else if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      if (Array.isArray(obj["@graph"])) {
        for (const n of obj["@graph"] as unknown[]) {
          nodes.push(n);
        }
      } else {
        nodes.push(parsed);
      }
    }

    for (const node of nodes) {
      if (!node || typeof node !== "object") continue;
      const n = node as Record<string, unknown>;

      // Check if this is a JobPosting node
      const type = n["@type"];
      const isJobPosting =
        type === "JobPosting" ||
        (Array.isArray(type) && (type as string[]).includes("JobPosting"));
      if (!isJobPosting) continue;

      // Extract hiringOrganization.sameAs
      const hiringOrg = n["hiringOrganization"];
      if (!hiringOrg || typeof hiringOrg !== "object") continue;
      const org = hiringOrg as Record<string, unknown>;
      const sameAs = org["sameAs"];
      if (!sameAs) continue;

      const candidates = Array.isArray(sameAs) ? sameAs : [sameAs];
      for (const candidate of candidates) {
        if (typeof candidate !== "string") continue;
        const domain = cleanHostname(candidate);
        if (domain) domains.push(domain);
      }
    }
  }

  return domains;
}

/**
 * Adds domains to the module-level registry.
 * Call from inside scrapeCareers for each page's html.
 */
export function recordDiscoveredDomains(domains: string[]): void {
  for (const domain of domains) {
    if (domain) discoveredRegistry.add(domain);
  }
}

/**
 * Flushes the accumulated registry to pipeline/new_companies_discovered.json.
 * Call ONCE in main() after all scraping completes.
 * Deduplicates against already-known domains from company_career_urls.json.
 * If registry is empty, does nothing.
 * Returns the count of newly written domains.
 */
export async function flushDiscoveredCompanies(): Promise<number> {
  if (discoveredRegistry.size === 0) return 0;

  const cwd = process.cwd();
  const knownUrlsPath = path.resolve(cwd, "pipeline/company_career_urls.json");
  const discoveryPath = path.resolve(cwd, "pipeline/new_companies_discovered.json");

  // Build set of already-known domains from company_career_urls.json
  const knownDomains = new Set<string>();
  try {
    const raw = await readFile(knownUrlsPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        if (typeof entry === "string") {
          const domain = cleanHostname(entry);
          if (domain) knownDomains.add(domain);
        }
      }
    }
  } catch {
    // File missing or malformed — proceed without known-domains filtering
  }

  // Load existing discovery file if present
  const existingDiscovered: string[] = [];
  try {
    const raw = await readFile(discoveryPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        if (typeof entry === "string") existingDiscovered.push(entry);
      }
    }
  } catch {
    // File doesn't exist yet — that's fine
  }

  const existingSet = new Set(existingDiscovered);

  // New domains = registry MINUS known career-page domains AND already in discovery file
  const newDomains: string[] = [];
  for (const domain of discoveredRegistry) {
    if (!knownDomains.has(domain) && !existingSet.has(domain)) {
      newDomains.push(domain);
    }
  }

  if (newDomains.length === 0) return 0;

  const merged = [...existingDiscovered, ...newDomains].sort();
  await writeFile(discoveryPath, JSON.stringify(merged, null, 2), "utf8");
  return newDomains.length;
}
