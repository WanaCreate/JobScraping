import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { scrapeAmazon } from "../adapters/amazon.js";
import { scrapeAshby } from "../adapters/ashby.js";
import { scrapeGenericHtmlCrawler } from "../adapters/genericHtmlCrawler.js";
import { scrapeGenericPlaywright } from "../adapters/genericPlaywright.js";
import { scrapeGreenhouse } from "../adapters/greenhouse.js";
import { scrapeIcims } from "../adapters/icims.js";
import { scrapeLever } from "../adapters/lever.js";
import { scrapeSmartRecruiters } from "../adapters/smartrecruiters.js";
import { scrapeWorkable } from "../adapters/workable.js";
import { scrapeWorkday } from "../adapters/workday.js";
import { detectATS } from "../ats/detectATS.js";
import { extractTenant } from "../ats/extractTenant.js";
import { filterCreativeJobs } from "../filters/creativeFilter.js";
import type { RawJob, ScrapeResult, TenantInfo } from "../types.js";
import { extractDiscoveredDomains, flushDiscoveredCompanies, recordDiscoveredDomains } from "../utils/discoverCompanies.js";
import { withHostLimit } from "../utils/hostLimiter.js";
import { fetchPage } from "../utils/http.js";
import { isLikelyJobEntryLoose, isLikelyJobPosting } from "../utils/jobHeuristics.js";
import { logError, logInfo, logWarn } from "../utils/logger.js";
import { normalizeJobs } from "../utils/normalize.js";

function inferTenantFromJobUrls(ats: ScrapeResult["ats"], jobs: RawJob[]): string | null {
  for (const job of jobs) {
    const url = job.url ?? "";
    if (!url) continue;

    if (ats === "greenhouse") {
      const match = url.match(/(?:job-boards|boards)\.greenhouse\.io\/([a-z0-9_-]+)/i);
      if (match?.[1]) return match[1];
    }

    if (ats === "lever") {
      const match = url.match(/jobs\.lever\.co\/([a-z0-9_-]+)/i);
      if (match?.[1]) return match[1];
    }

    if (ats === "smartrecruiters") {
      const match = url.match(/jobs\.smartrecruiters\.com\/([a-z0-9_-]+)/i);
      if (match?.[1]) return match[1];
    }

    if (ats === "workday") {
      const match = url.match(/\/wday\/cxs\/([a-z0-9_-]+)\//i);
      if (match?.[1]) return match[1];
    }

    if (ats === "icims") {
      const match = url.match(/\/\/([a-z0-9-]+)\.icims\.com/i);
      if (match?.[1]) return match[1];
    }

    if (ats === "ashby") {
      const match = url.match(/jobs\.ashbyhq\.com\/([a-z0-9_-]+)/i);
      if (match?.[1]) return match[1];
    }

    if (ats === "workable") {
      const match =
        url.match(/apply\.workable\.com\/([a-z0-9_-]+)/i) ??
        url.match(/workable\.com\/api\/accounts\/([a-z0-9_-]+)/i) ??
        url.match(/jobs\.workable\.com\/([a-z0-9_-]+)/i);
      if (match?.[1]) return match[1];
    }
  }

  return null;
}

async function extractViaAdapter(params: {
  ats: ScrapeResult["ats"];
  sourceUrl: string;
  tenant: string | null;
  endpoints: string[];
}): Promise<RawJob[]> {
  const { ats, sourceUrl, tenant, endpoints } = params;

  switch (ats) {
    case "greenhouse":
      return tenant ? scrapeGreenhouse(tenant) : [];
    case "lever":
      return tenant ? scrapeLever(tenant) : [];
    case "workday":
      return scrapeWorkday({ sourceUrl, tenant, endpoints });
    case "smartrecruiters":
      return tenant ? scrapeSmartRecruiters(tenant) : [];
    case "icims":
      return scrapeIcims({ tenant, endpoints });
    case "ashby":
      return tenant ? scrapeAshby(tenant) : [];
    case "amazon":
      return scrapeAmazon(sourceUrl);
    case "workable":
      return tenant ? scrapeWorkable(tenant) : [];
    default:
      return [];
  }
}

// ATSs served by a public JSON API where the URL encodes the tenant. For these,
// the API result is authoritative: a 0-job or error result means the board is
// empty/dead, so we must NOT fall back to fetching the HTML listing page (same
// rate-limited host, needs a browser) — that just re-introduces 403/429 storms.
const CLEAN_API_ATS = new Set<ScrapeResult["ats"]>([
  "greenhouse",
  "lever",
  "ashby",
  "workable",
  "smartrecruiters"
]);

export async function scrapeCareers(sourceUrl: string): Promise<ScrapeResult> {
  let ats: ScrapeResult["ats"] = "generic";
  let tenant: string | null = null;
  let html = "";
  let finalUrl = sourceUrl;

  try {
    let tenantInfo: TenantInfo = { tenant: null, metadata: {}, endpoints: [] };
    let jobs: RawJob[] = [];
    let adapterJobsFound = false;
    let urlFirstAuthoritative = false;

    // --- URL-first detection: the discovered ATS URLs (boards.greenhouse.io/{slug},
    // jobs.ashbyhq.com/{slug}, apply.workable.com/{slug}, ...) already encode the
    // ATS + tenant, so hit the public JSON API directly. No HTML fetch — avoids
    // 403/404 on listing pages and needs no headless browser.
    const urlAts = detectATS("", sourceUrl);
    if (urlAts !== "generic") {
      const urlTenantInfo = extractTenant("", sourceUrl, urlAts);
      if (urlTenantInfo.tenant || urlTenantInfo.endpoints.length > 0) {
        try {
          const urlJobs = await extractViaAdapter({
            ats: urlAts,
            sourceUrl,
            tenant: urlTenantInfo.tenant,
            endpoints: urlTenantInfo.endpoints
          });
          if (urlJobs.length > 0) {
            ats = urlAts;
            tenant = urlTenantInfo.tenant;
            tenantInfo = urlTenantInfo;
            jobs = urlJobs;
            adapterJobsFound = true;
            logInfo("Adapter extraction via URL-first detection", {
              source: sourceUrl,
              ats,
              count: jobs.length
            });
          }
          // Clean-API ATS ran without error → result is authoritative even if empty.
          if (CLEAN_API_ATS.has(urlAts)) {
            ats = urlAts;
            tenant = urlTenantInfo.tenant;
            urlFirstAuthoritative = true;
          }
        } catch (error) {
          // A 404/error from a clean-API board means it's gone; the HTML page is on
          // the same throttled host and needs a browser, so don't bother.
          if (CLEAN_API_ATS.has(urlAts)) {
            ats = urlAts;
            urlFirstAuthoritative = true;
          }
          logWarn("URL-first adapter failed", {
            source: sourceUrl,
            ats: urlAts,
            authoritative: urlFirstAuthoritative,
            reason: error instanceof Error ? error.message : String(error)
          });
        }
      }
    }

    // --- Fallback: fetch HTML, detect from page, run adapter. Used for custom
    // career pages and any ATS URL the JSON API didn't yield from. Skipped when a
    // clean-API ATS already gave an authoritative answer.
    if (!adapterJobsFound && !urlFirstAuthoritative) {
      try {
        const fetched = await fetchPage(sourceUrl);
        html = fetched.html;
        finalUrl = fetched.finalUrl;

        ats = detectATS(html, finalUrl);
        tenantInfo = extractTenant(html, finalUrl, ats);
        tenant = tenantInfo.tenant;

        if (html) {
          try {
            recordDiscoveredDomains(extractDiscoveredDomains(html));
          } catch {
            // discovery never breaks a scrape
          }
        }
      } catch (error) {
        logWarn("Initial HTTP fetch failed; continuing with generic fallbacks", {
          source: sourceUrl,
          reason: error instanceof Error ? error.message : String(error)
        });
      }

      logInfo("Detected ATS", { source: sourceUrl, ats, tenant });

      if (ats !== "generic") {
        try {
          jobs = await extractViaAdapter({
            ats,
            sourceUrl: finalUrl,
            tenant,
            endpoints: tenantInfo.endpoints
          });
          adapterJobsFound = jobs.length > 0;
          logInfo("Adapter extraction completed", { source: sourceUrl, ats, count: jobs.length });
        } catch (error) {
          logWarn("Adapter extraction failed; falling back to generic extractors", {
            source: sourceUrl,
            ats,
            reason: error instanceof Error ? error.message : String(error)
          });
        }
      }
    }

    const fallbackAts: RawJob["ats"] = ats === "generic" ? "generic" : ats;

    if (jobs.length === 0 && !urlFirstAuthoritative) {
      try {
        const htmlFallback = await scrapeGenericHtmlCrawler({
          sourceUrl,
          initialHtml: html || undefined,
          initialFinalUrl: finalUrl,
          maxPages: ats === "phenom" ? 14 : 10
        });
        jobs = htmlFallback.jobs.map((job): RawJob => ({
          ...job,
          ats: fallbackAts
        }));

        logInfo("HTML fallback extraction completed", {
          source: sourceUrl,
          fallbackCount: jobs.length,
          pagesVisited: htmlFallback.discoveredPages.length
        });
      } catch (error) {
        logWarn("HTML fallback extraction failed", {
          source: sourceUrl,
          reason: error instanceof Error ? error.message : String(error)
        });
      }
    }

    const trueJobCountAfterHtml = jobs.filter((job) => isLikelyJobPosting(job)).length;

    // Skip the Playwright fallback when an ATS JSON adapter already yielded jobs
    // (the API result is authoritative, and the browser path is costly/unavailable
    // in headless-only environments).
    if (!adapterJobsFound && !urlFirstAuthoritative && (jobs.length === 0 || trueJobCountAfterHtml === 0)) {
      const seedUrls: string[] = [];
      if (finalUrl !== sourceUrl) seedUrls.push(finalUrl);
      try {
        const baseJobsPath = new URL("/jobs", finalUrl).toString();
        seedUrls.push(baseJobsPath);
      } catch {
        // no-op
      }

      const playwrightJobs: RawJob[] = (await scrapeGenericPlaywright(sourceUrl, { seedUrls, maxPages: 5 })).map(
        (job): RawJob => ({
          ...job,
          ats: fallbackAts
        })
      );
      jobs = [...jobs, ...playwrightJobs];
      logInfo("Playwright fallback extraction completed", {
        source: sourceUrl,
        fallbackCount: playwrightJobs.length
      });
    }

    if (!tenant) {
      tenant = inferTenantFromJobUrls(ats, jobs);
    }

    const strictJobs = jobs.filter((job) => isLikelyJobPosting(job));
    const looseJobs = jobs.filter((job) => isLikelyJobEntryLoose(job));
    const selectedJobs = adapterJobsFound ? jobs : strictJobs.length > 0 ? strictJobs : looseJobs.length > 0 ? looseJobs : jobs;

    const normalized = normalizeJobs(selectedJobs, sourceUrl, ats);
    const creativeJobs = filterCreativeJobs(normalized);

    return {
      source: sourceUrl,
      ats,
      tenant,
      jobs_count: normalized.length,
      creative_jobs: creativeJobs
    };
  } catch (error) {
    logError("Failed to scrape source", {
      source: sourceUrl,
      reason: error instanceof Error ? error.message : String(error)
    });
    return {
      source: sourceUrl,
      ats,
      tenant,
      jobs_count: 0,
      creative_jobs: []
    };
  }
}

// --- Merged from runScraper.ts ---

function parseInputUrls(): string[] {
  const cliUrls = process.argv.slice(2).filter((arg) => /^https?:\/\//i.test(arg));
  if (cliUrls.length > 0) return cliUrls;

  const jsonEnv = process.env.SCRAPER_URLS_JSON;
  if (jsonEnv) {
    try {
      const parsed = JSON.parse(jsonEnv);
      if (Array.isArray(parsed)) {
        return parsed.filter((value) => typeof value === "string" && /^https?:\/\//i.test(value));
      }
    } catch { /* fall through */ }
  }

  return []; // will fall through to file-based loading in parseInputUrlsAsync
}

async function parseInputUrlsAsync(): Promise<string[]> {
  const directUrls = parseInputUrls();
  if (directUrls.length > 0) {
    return directUrls;
  }

  const fileFromEnv = process.env.SCRAPER_URLS_FILE;
  const defaultFile = "pipeline/company_career_urls.json";
  const filePath = fileFromEnv?.trim() || defaultFile;

  try {
    const raw = await readFile(path.resolve(process.cwd(), filePath), "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const urls = parsed.filter((value) => typeof value === "string" && /^https?:\/\//i.test(value));
      if (urls.length > 0) return urls;
    }
  } catch {
    // fall through
  }

  return [];
}

function parseOutputPath(): string | null {
  const args = process.argv.slice(2);
  const outputFlagIndex = args.findIndex((arg) => arg === "--output");
  if (outputFlagIndex >= 0 && args[outputFlagIndex + 1]) {
    return args[outputFlagIndex + 1];
  }

  const outputEnv = process.env.SCRAPER_OUTPUT_FILE;
  if (outputEnv && outputEnv.trim()) return outputEnv.trim();

  return null;
}

async function runWithConcurrency<TInput, TOutput>(
  items: TInput[],
  concurrency: number,
  worker: (item: TInput) => Promise<TOutput>
): Promise<TOutput[]> {
  const results: TOutput[] = new Array(items.length);
  let index = 0;

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const current = index;
      index += 1;
      if (current >= items.length) break;
      results[current] = await worker(items[current]);
    }
  });

  await Promise.all(workers);
  return results;
}

export async function runScraper(urls: string[], concurrency = 20): Promise<ScrapeResult[]> {
  logInfo("Starting batch scrape", { companies: urls.length, concurrency });
  // Global concurrency lets independent hosts proceed in parallel; per-host
  // concurrency caps + spacing (withHostLimit) prevent 429/403 throttling when
  // thousands of URLs concentrate on a few ATS hosts.
  const results = await runWithConcurrency(urls, concurrency, (url) =>
    withHostLimit(url, () => scrapeCareers(url))
  );
  logInfo("Batch scrape completed", { companies: urls.length });
  return results;
}

async function main(): Promise<void> {
  const urls = await parseInputUrlsAsync();
  const concurrency = Number(process.env.SCRAPER_CONCURRENCY ?? "8");
  const safeConcurrency = Number.isFinite(concurrency) && concurrency > 0 ? concurrency : 8;
  const results = await runScraper(urls, safeConcurrency);

  const newCompaniesCount = await flushDiscoveredCompanies();
  if (newCompaniesCount > 0) {
    logInfo("Discovered new companies", { count: newCompaniesCount, file: "pipeline/new_companies_discovered.json" });
  }

  const outputJson = JSON.stringify(results, null, 2);
  const outputPath = parseOutputPath();

  if (outputPath) {
    const resolvedPath = path.resolve(process.cwd(), outputPath);
    await mkdir(path.dirname(resolvedPath), { recursive: true });
    await writeFile(resolvedPath, outputJson, "utf8");
    logInfo("Wrote Stage 1 output", { outputPath: resolvedPath, jobCount: results.length });
    return;
  }

  console.log(outputJson);
}

const directRunHref = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === directRunHref) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
