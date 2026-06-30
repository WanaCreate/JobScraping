/**
 * Phase 1 — full extraction of architecture-related roles from the firm list.
 *
 * Reads firms.json, dispatches each firm to the right scraper (reusing the
 * repo's Workday/iCIMS adapters + a Playwright generic fallback, plus light
 * UltiPro/BambooHR API adapters), filters titles to architecture roles, and
 * writes a CSV + JSON snapshot and a per-firm coverage report.
 *
 * Run:  npx tsx experiments/architecture-firms/scrape.ts
 * Flags:
 *   --firm "Gensler"   only this firm (substring match) — handy for testing
 *   --limit 5          first N firms only
 *   --concurrency 4    parallel firms (default 4)
 *   --all-jobs         also write every job (pre arch-filter) for inspection
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { RawJob } from "../../types.js";
import { fetchPageWithRetry } from "../../utils/http.js";
import { detectATS } from "../../ats/detectATS.js";
import { extractTenant } from "../../ats/extractTenant.js";
import { scrapeWorkday } from "../../adapters/workday.js";
import { scrapeIcims } from "../../adapters/icims.js";
import { scrapeGenericPlaywright } from "../../adapters/genericPlaywright.js";
import { scrapeSmartRecruiters } from "../../adapters/smartrecruiters.js";
import { scrapeUltiPro, scrapeBambooHr, scrapeJobsyn, scrapeOracle, scrapeEightfold, buildWorkdayEndpoint } from "./extraAdapters.js";
import { classifyArchTitle } from "./archFilter.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface Firm {
  name: string;
  url: string | null;
  scraper: "workday" | "icims" | "ultipro" | "bamboohr" | "jobsyn" | "oracle" | "eightfold" | "smartrecruiters" | "playwright" | "skip";
  ats?: string;
  note?: string;
}

export interface FirmResult {
  firm: string;
  url: string | null;
  scraper: string;
  detectedAts: string | null;
  totalJobsFound: number;
  archJobsFound: number;
  status: "ok" | "no-jobs" | "error" | "skipped";
  error?: string;
}

export interface ArchJobRow {
  firm: string;
  title: string;
  location: string;
  url: string;
  ats: string;
  datePosted: string;
  sourceUrl: string;
  scrapedAt: string;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function dedupe(jobs: RawJob[]): RawJob[] {
  const seen = new Set<string>();
  const out: RawJob[] = [];
  for (const j of jobs) {
    const key = `${(j.title ?? "").toLowerCase().trim()}|${(j.url ?? "").toLowerCase().trim()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(j);
  }
  return out;
}

/** Get raw jobs for one firm using its declared scraper, with sensible fallbacks. */
async function scrapeFirm(firm: Firm): Promise<{ jobs: RawJob[]; detectedAts: string | null }> {
  const url = firm.url as string;

  if (firm.scraper === "ultipro") return { jobs: await scrapeUltiPro(url), detectedAts: "ultipro" };
  if (firm.scraper === "bamboohr") return { jobs: await scrapeBambooHr(url), detectedAts: "bamboohr" };
  if (firm.scraper === "jobsyn") return { jobs: await scrapeJobsyn(url), detectedAts: "jobsyn (.jobs)" };
  if (firm.scraper === "oracle") return { jobs: await scrapeOracle(url), detectedAts: "oracle-cloud" };
  if (firm.scraper === "eightfold") return { jobs: await scrapeEightfold(url), detectedAts: "eightfold" };
  if (firm.scraper === "smartrecruiters") {
    const tenant = url.match(/\/company\/([^/?]+)/i)?.[1] ?? url.match(/smartrecruiters\.com\/([^/?]+)/i)?.[1];
    if (!tenant) throw new Error(`SmartRecruiters: could not parse tenant from ${url}`);
    return { jobs: await scrapeSmartRecruiters(tenant), detectedAts: "smartrecruiters" };
  }

  if (firm.scraper === "workday") {
    const wd = buildWorkdayEndpoint(url);
    if (!wd) throw new Error(`Workday: could not parse endpoint from ${url}`);
    return {
      jobs: await scrapeWorkday({ sourceUrl: url, tenant: wd.tenant, endpoints: [wd.endpoint] }),
      detectedAts: "workday",
    };
  }

  if (firm.scraper === "icims") {
    const { html, finalUrl } = await fetchPageWithRetry(url);
    const ats = detectATS(html, finalUrl);
    const tenant = extractTenant(html, finalUrl, ats);
    return {
      jobs: await scrapeIcims({ tenant: tenant.tenant, endpoints: tenant.endpoints.length ? tenant.endpoints : [url] }),
      detectedAts: ats,
    };
  }

  // playwright generic fallback (also catches embedded JSON / XHR feeds)
  const jobs = await scrapeGenericPlaywright(url, { maxPages: 6 });
  return { jobs, detectedAts: firm.ats ?? "generic" };
}

/** Run the declared scraper; if it errors or finds nothing, retry via Playwright. */
async function scrapeFirmWithFallback(firm: Firm): Promise<{ jobs: RawJob[]; detectedAts: string | null }> {
  try {
    const primary = await scrapeFirm(firm);
    if (primary.jobs.length > 0 || firm.scraper === "playwright") return primary;
  } catch (err) {
    if (firm.scraper === "playwright") throw err;
  }
  // fallback
  const jobs = await scrapeGenericPlaywright(firm.url as string, { maxPages: 6 });
  return { jobs, detectedAts: `${firm.ats ?? "generic"} (pw-fallback)` };
}

export async function processFirm(firm: Firm, scrapedAt: string): Promise<{
  result: FirmResult;
  archRows: ArchJobRow[];
  allJobs: RawJob[];
}> {
  if (firm.scraper === "skip" || !firm.url) {
    return {
      result: { firm: firm.name, url: firm.url, scraper: firm.scraper, detectedAts: null, totalJobsFound: 0, archJobsFound: 0, status: "skipped", error: "no url" },
      archRows: [],
      allJobs: [],
    };
  }

  try {
    const { jobs, detectedAts } = await scrapeFirmWithFallback(firm);
    const unique = dedupe(jobs);
    const archRows: ArchJobRow[] = [];

    for (const j of unique) {
      if (!classifyArchTitle(j.title).matched) continue;
      archRows.push({
        firm: firm.name,
        title: (j.title ?? "").trim(),
        location: (j.location ?? "").trim(),
        url: (j.url ?? "").trim(),
        ats: detectedAts ?? j.ats ?? "",
        datePosted: (j.datePosted ?? "").trim(),
        sourceUrl: firm.url,
        scrapedAt,
      });
    }

    return {
      result: {
        firm: firm.name, url: firm.url, scraper: firm.scraper, detectedAts,
        totalJobsFound: unique.length, archJobsFound: archRows.length,
        status: unique.length === 0 ? "no-jobs" : "ok",
      },
      archRows,
      allJobs: unique,
    };
  } catch (err) {
    return {
      result: {
        firm: firm.name, url: firm.url, scraper: firm.scraper, detectedAts: firm.ats ?? null,
        totalJobsFound: 0, archJobsFound: 0, status: "error",
        error: err instanceof Error ? err.message : String(err),
      },
      archRows: [],
      allJobs: [],
    };
  }
}

function csvEscape(v: string): string {
  if (/[",\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

export function toCsv(rows: ArchJobRow[]): string {
  const header = ["firm", "title", "location", "url", "ats", "datePosted", "sourceUrl", "scrapedAt"];
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push([r.firm, r.title, r.location, r.url, r.ats, r.datePosted, r.sourceUrl, r.scrapedAt].map(csvEscape).join(","));
  }
  return lines.join("\n");
}

export async function pool<T, R>(items: T[], size: number, fn: (item: T, idx: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return results;
}

async function main() {
  const firms: Firm[] = JSON.parse(readFileSync(join(__dirname, "firms.json"), "utf8"));

  let selected = firms;
  const firmFilter = arg("firm");
  if (firmFilter) selected = selected.filter((f) => f.name.toLowerCase().includes(firmFilter.toLowerCase()));
  const limit = arg("limit");
  if (limit) selected = selected.slice(0, Number(limit));

  const concurrency = Number(arg("concurrency") ?? 4);
  const now = new Date();
  const scrapedAt = now.toISOString();
  const dateFolder = `${now.toLocaleString("en-US", { month: "long" })}${now.getDate()}-${now.getFullYear()}`;

  console.log(`Scraping ${selected.length} firms (concurrency ${concurrency})...\n`);

  const outcomes = await pool(selected, concurrency, async (firm, idx) => {
    const out = await processFirm(firm, scrapedAt);
    const r = out.result;
    const tag = r.status === "ok" ? "OK " : r.status === "error" ? "ERR" : r.status === "no-jobs" ? "---" : "SKP";
    console.log(`[${idx + 1}/${selected.length}] ${tag} ${firm.name}: ${r.archJobsFound} arch / ${r.totalJobsFound} total${r.error ? `  (${r.error.slice(0, 80)})` : ""}`);
    return out;
  });

  const archRows = outcomes.flatMap((o) => o.archRows);
  const results = outcomes.map((o) => o.result);

  const outDir = join(__dirname, "output", dateFolder);
  mkdirSync(outDir, { recursive: true });

  const csvPath = join(outDir, `architecture_jobs_${dateFolder}.csv`);
  writeFileSync(csvPath, toCsv(archRows), "utf8");
  writeFileSync(join(outDir, "arch_jobs.json"), JSON.stringify(archRows, null, 2), "utf8");
  writeFileSync(join(outDir, "run_summary.json"), JSON.stringify({ scrapedAt, totalFirms: selected.length, totalArchJobs: archRows.length, results }, null, 2), "utf8");

  if (flag("all-jobs")) {
    const allByFirm = outcomes.map((o) => ({ firm: o.result.firm, jobs: o.allJobs }));
    writeFileSync(join(outDir, "all_jobs_prefilter.json"), JSON.stringify(allByFirm, null, 2), "utf8");
  }

  // Coverage report to console
  const ok = results.filter((r) => r.status === "ok").length;
  const noJobs = results.filter((r) => r.status === "no-jobs").length;
  const errored = results.filter((r) => r.status === "error");
  console.log(`\n=== Summary ===`);
  console.log(`Firms with jobs: ${ok} | no jobs: ${noJobs} | errors: ${errored.length} | skipped: ${results.filter((r) => r.status === "skipped").length}`);
  console.log(`Total architecture roles: ${archRows.length}`);
  if (errored.length) {
    console.log(`\nErrors / gaps to revisit:`);
    for (const e of errored) console.log(`  - ${e.firm} (${e.scraper}): ${e.error?.slice(0, 100)}`);
  }
  console.log(`\nOutput: ${outDir}`);
  console.log(`  ${csvPath}`);
}

// Only auto-run the full Phase-1 extraction when this file is executed directly
// (e.g. `tsx scrape.ts`). When track.ts imports processFirm/pool from here, the
// guard prevents main() from firing as a side effect of the import.
const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
