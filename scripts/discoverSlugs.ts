/**
 * scripts/discoverSlugs.ts
 *
 * Slug discovery via Common Crawl CDX index.
 * Queries each ATS host prefix, extracts company slugs, deduplicates against
 * pipeline/company_career_urls.json, and writes new candidates to
 * pipeline/pending_review.json.
 *
 * Usage:
 *   npx tsx scripts/discoverSlugs.ts [--max-pages-per-host N] [--hosts greenhouse,lever,...]
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { http } from "../utils/http.js";
import type { AxiosError } from "axios";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);

function getArgValue(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx !== -1 && idx + 1 < args.length) return args[idx + 1];
  return undefined;
}

const MAX_PAGES_PER_HOST = parseInt(getArgValue("--max-pages-per-host") ?? "30", 10);
const hostsFilter = getArgValue("--hosts");

// ---------------------------------------------------------------------------
// Host definitions: CDX prefix → slug extractor
// ---------------------------------------------------------------------------
interface HostDef {
  key: string;
  cdxPrefix: string; // pattern for CDX url= param
  baseUrl: string; // prefix to build canonical URL from slug
  extractSlug: (url: string) => string | null;
}

function extractPathSlug(url: string, host: string): string | null {
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.endsWith(host) && parsed.hostname !== host) return null;
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length === 0) return null;
    const slug = parts[0];
    // Skip non-slug paths
    if (isJunkSlug(slug)) return null;
    return slug.toLowerCase();
  } catch {
    return null;
  }
}

const JUNK_SLUGS = new Set([
  "embed", "blog", "jobs", "careers", "api", "static", "assets", "js", "css",
  "img", "images", "fonts", "favicon.ico", "robots.txt", "sitemap.xml",
  "privacy", "terms", "login", "auth", "signup", "oauth", "callback",
  "help", "support", "faq", "about", "contact", "home", "index",
  "healthcheck", "health", ".well-known", "cdn-cgi",
]);

function isJunkSlug(slug: string): boolean {
  if (!slug) return true;
  if (JUNK_SLUGS.has(slug.toLowerCase())) return true;
  // Skip slugs that look like UUIDs (all hex + dashes, 36 chars)
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(slug)) return true;
  // Skip slugs that look like pure numeric IDs
  if (/^\d+$/.test(slug)) return true;
  // Skip single-char slugs
  if (slug.length < 2) return true;
  // Skip file extensions
  if (/\.[a-z]{2,5}$/i.test(slug)) return true;
  return false;
}

const ALL_HOSTS: HostDef[] = [
  {
    key: "greenhouse",
    cdxPrefix: "boards.greenhouse.io/*",
    baseUrl: "https://boards.greenhouse.io",
    extractSlug: (url) => extractPathSlug(url, "boards.greenhouse.io"),
  },
  {
    key: "greenhouse-job-boards",
    cdxPrefix: "job-boards.greenhouse.io/*",
    baseUrl: "https://job-boards.greenhouse.io",
    extractSlug: (url) => extractPathSlug(url, "job-boards.greenhouse.io"),
  },
  {
    key: "lever",
    cdxPrefix: "jobs.lever.co/*",
    baseUrl: "https://jobs.lever.co",
    extractSlug: (url) => extractPathSlug(url, "jobs.lever.co"),
  },
  {
    key: "ashby",
    cdxPrefix: "jobs.ashbyhq.com/*",
    baseUrl: "https://jobs.ashbyhq.com",
    extractSlug: (url) => extractPathSlug(url, "jobs.ashbyhq.com"),
  },
  {
    key: "workable",
    cdxPrefix: "apply.workable.com/*",
    baseUrl: "https://apply.workable.com",
    extractSlug: (url) => {
      // workable paths: /company-slug/j/JOBID or /company-slug
      return extractPathSlug(url, "apply.workable.com");
    },
  },
  {
    key: "smartrecruiters",
    cdxPrefix: "jobs.smartrecruiters.com/*",
    baseUrl: "https://jobs.smartrecruiters.com",
    extractSlug: (url) => extractPathSlug(url, "jobs.smartrecruiters.com"),
  },
];

// ---------------------------------------------------------------------------
// Sleep / retry helpers
// ---------------------------------------------------------------------------
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryable(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as AxiosError;
  const status = e.response?.status ?? 0;
  const code = e.code ?? "";
  if (status === 429) return true;
  if (status >= 500 && status <= 599) return true;
  if (["ECONNABORTED", "ETIMEDOUT", "ECONNRESET", "EAI_AGAIN", "ENOTFOUND", "EHOSTUNREACH"].includes(code)) return true;
  return false;
}

async function fetchWithRetry(
  url: string,
  maxAttempts = 5,
  baseDelayMs = 1000
): Promise<string> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await http.get<string>(url, {
        responseType: "text",
        timeout: 45000,
      });
      return typeof response.data === "string" ? response.data : String(response.data);
    } catch (err) {
      lastError = err;
      const status = (err as AxiosError)?.response?.status ?? 0;
      if (!isRetryable(err)) {
        throw err;
      }
      // Back off more aggressively on rate limits
      const multiplier = status === 429 ? 3 : 1;
      const jitter = Math.floor(Math.random() * 300);
      const delay = baseDelayMs * Math.pow(2, attempt - 1) * multiplier + jitter;
      console.log(`    [retry ${attempt}/${maxAttempts}] ${status || "network"} — waiting ${Math.round(delay / 1000)}s`);
      await sleep(delay);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Fetch failed after retries");
}

// ---------------------------------------------------------------------------
// Common Crawl CDX helpers
// ---------------------------------------------------------------------------
interface CrawlInfo {
  id: string;
  "cdx-api": string;
  name?: string;
}

async function getLatestCdxApiUrl(): Promise<string> {
  console.log("Fetching Common Crawl index list...");
  const text = await fetchWithRetry("https://index.commoncrawl.org/collinfo.json");
  const collections: CrawlInfo[] = JSON.parse(text);
  if (!collections || collections.length === 0) {
    throw new Error("No crawl collections returned from collinfo.json");
  }
  // Collections are returned newest-first
  const latest = collections[0];
  console.log(`Using crawl: ${latest.id} — ${latest["cdx-api"]}`);
  return latest["cdx-api"];
}

async function getCdxPageCount(cdxApiUrl: string, urlPattern: string): Promise<number> {
  const queryUrl = `${cdxApiUrl}?url=${encodeURIComponent(urlPattern)}&output=json&fl=url&showNumPages=true`;
  try {
    const text = await fetchWithRetry(queryUrl, 3, 1000);
    const trimmed = text.trim();
    if (!trimmed) return 0;
    // May return JSON: {"pages": N, "pageSize": M, "blocks": K}
    try {
      const obj = JSON.parse(trimmed);
      if (typeof obj === "object" && obj !== null && "pages" in obj) {
        return Number(obj.pages) || 0;
      }
    } catch {
      // Fallback: plain integer string
      const n = parseInt(trimmed, 10);
      return isNaN(n) ? 0 : n;
    }
  } catch (err) {
    const status = (err as AxiosError)?.response?.status ?? 0;
    if (status === 404) return 0;
    console.warn(`  Warning: could not get page count for ${urlPattern}: ${(err as Error).message}`);
    return 0;
  }
  return 0;
}

/**
 * Fetch one CDX page and return a list of URLs.
 * CDX output=json returns JSONL (one JSON object per line), not a JSON array.
 */
async function fetchCdxPage(cdxApiUrl: string, urlPattern: string, page: number): Promise<string[]> {
  const queryUrl = `${cdxApiUrl}?url=${encodeURIComponent(urlPattern)}&output=json&fl=url&collapse=urlkey&page=${page}`;
  const text = await fetchWithRetry(queryUrl, 5, 1500);
  const urls: string[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as { url?: string };
      if (obj.url) urls.push(obj.url);
    } catch {
      // Skip malformed lines
    }
  }
  return urls;
}

// ---------------------------------------------------------------------------
// Main per-host discovery
// ---------------------------------------------------------------------------
async function discoverHost(
  cdxApiUrl: string,
  hostDef: HostDef
): Promise<{ slugs: Set<string>; captured: number }> {
  const slugs = new Set<string>();
  let captured = 0;

  console.log(`\n[${hostDef.key}] Querying CDX for prefix: ${hostDef.cdxPrefix}`);

  // First get total page count
  let totalPages = await getCdxPageCount(cdxApiUrl, hostDef.cdxPrefix);
  if (totalPages === 0) {
    console.log(`  No pages found (or page-count unavailable) — will attempt page 0 anyway`);
    totalPages = 1;
  }

  const pagesToFetch = Math.min(totalPages, MAX_PAGES_PER_HOST);
  console.log(`  Total pages: ${totalPages}, fetching up to: ${pagesToFetch}`);

  for (let page = 0; page < pagesToFetch; page++) {
    process.stdout.write(`  Page ${page + 1}/${pagesToFetch}... `);

    let urls: string[];
    try {
      urls = await fetchCdxPage(cdxApiUrl, hostDef.cdxPrefix, page);
    } catch (err) {
      const status = (err as AxiosError)?.response?.status ?? 0;
      console.log(`FAILED (${status || (err as Error).message}), skipping page`);
      // Short pause before continuing
      await sleep(2000);
      continue;
    }

    captured += urls.length;
    for (const url of urls) {
      const slug = hostDef.extractSlug(url);
      if (slug) slugs.add(slug);
    }

    console.log(`${urls.length} URLs → ${slugs.size} unique slugs so far`);

    // Polite delay between pages to avoid hammering CDX
    if (page < pagesToFetch - 1) {
      await sleep(300 + Math.floor(Math.random() * 200));
    }
  }

  return { slugs, captured };
}

// ---------------------------------------------------------------------------
// Existing URL normalisation for dedup
// ---------------------------------------------------------------------------
function normalizeUrl(url: string): string {
  return url
    .toLowerCase()
    .replace(/^https?:\/\/www\./, "https://")
    .replace(/^https?:\/\//, "https://")
    .replace(/\/+$/, "");
}

/** Extract host+slug key from a canonical URL for dedup matching. */
function hostSlugKey(url: string): string {
  try {
    const parsed = new URL(url.startsWith("http") ? url : `https://${url}`);
    const parts = parsed.pathname.split("/").filter(Boolean);
    const slug = parts[0] ?? "";
    return `${parsed.hostname}/${slug}`.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const startTime = Date.now();

  // Filter hosts by --hosts flag
  let hosts = ALL_HOSTS;
  if (hostsFilter) {
    const keys = hostsFilter.split(",").map((k) => k.trim().toLowerCase());
    hosts = ALL_HOSTS.filter((h) => keys.some((k) => h.key.includes(k)));
    if (hosts.length === 0) {
      console.error(`No hosts matched filter: ${hostsFilter}`);
      console.error(`Available keys: ${ALL_HOSTS.map((h) => h.key).join(", ")}`);
      process.exit(1);
    }
  }

  console.log(`=== Slug Discovery via Common Crawl CDX ===`);
  console.log(`Hosts: ${hosts.map((h) => h.key).join(", ")}`);
  console.log(`Max pages per host: ${MAX_PAGES_PER_HOST}`);

  // Get CDX API URL
  const cdxApiUrl = await getLatestCdxApiUrl();

  // Load existing URLs for dedup
  const existingPath = path.join(ROOT, "pipeline", "company_career_urls.json");
  let existingUrls: string[] = [];
  if (fs.existsSync(existingPath)) {
    existingUrls = JSON.parse(fs.readFileSync(existingPath, "utf-8")) as string[];
  }
  const existingKeys = new Set(existingUrls.map(hostSlugKey));
  console.log(`\nLoaded ${existingUrls.length} existing URLs (${existingKeys.size} unique host+slug keys)`);

  // Load existing pending_review.json for merge+dedup
  const pendingPath = path.join(ROOT, "pipeline", "pending_review.json");
  let pendingExisting: string[] = [];
  if (fs.existsSync(pendingPath)) {
    pendingExisting = JSON.parse(fs.readFileSync(pendingPath, "utf-8")) as string[];
    console.log(`Loaded ${pendingExisting.length} existing pending_review entries`);
  }
  const pendingKeys = new Set(pendingExisting.map(hostSlugKey));

  // Run discovery per host
  const stats: Array<{
    key: string;
    captured: number;
    uniqueSlugs: number;
    newAfterDedup: number;
  }> = [];

  const newUrls: string[] = [];

  for (const hostDef of hosts) {
    let result: { slugs: Set<string>; captured: number };
    try {
      result = await discoverHost(cdxApiUrl, hostDef);
    } catch (err) {
      console.error(`\n[${hostDef.key}] FATAL error, skipping host: ${(err as Error).message}`);
      stats.push({ key: hostDef.key, captured: 0, uniqueSlugs: 0, newAfterDedup: 0 });
      continue;
    }

    let newCount = 0;
    for (const slug of result.slugs) {
      const canonicalUrl = `${hostDef.baseUrl}/${slug}`;
      const key = hostSlugKey(canonicalUrl);
      if (!existingKeys.has(key) && !pendingKeys.has(key)) {
        newUrls.push(canonicalUrl);
        pendingKeys.add(key);
        newCount++;
      }
    }

    stats.push({
      key: hostDef.key,
      captured: result.captured,
      uniqueSlugs: result.slugs.size,
      newAfterDedup: newCount,
    });
  }

  // Merge with existing pending_review and write
  const mergedPending = [...pendingExisting, ...newUrls];
  fs.writeFileSync(pendingPath, JSON.stringify(mergedPending, null, 2), "utf-8");

  // Print summary
  const elapsed = Math.round((Date.now() - startTime) / 1000);
  console.log("\n=== Summary ===");
  console.log(`Time elapsed: ${elapsed}s`);
  console.log("");
  console.log("Host".padEnd(30) + "Captured".padEnd(12) + "Unique slugs".padEnd(16) + "New after dedup");
  console.log("-".repeat(70));
  for (const s of stats) {
    console.log(
      s.key.padEnd(30) +
        String(s.captured).padEnd(12) +
        String(s.uniqueSlugs).padEnd(16) +
        String(s.newAfterDedup)
    );
  }
  console.log("-".repeat(70));
  const totalNew = stats.reduce((a, b) => a + b.newAfterDedup, 0);
  console.log(`Total new URLs added to pending_review.json: ${totalNew}`);
  console.log(`pending_review.json final size: ${mergedPending.length} entries`);
  console.log(`\nOutput: ${pendingPath}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
