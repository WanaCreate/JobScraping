/**
 * scripts/pruneCompanies.ts
 *
 * Partition company_career_urls.json into keep / low-yield / zero-job buckets
 * based on a Stage 1 scrape output, using the shared creative-scoring logic
 * (utils/creativeScoreLib.ts — same rubric as score_jobs.py).
 *
 * Usage (after running Stage 1):
 *   npx tsx scripts/pruneCompanies.ts [--input <path>] [--min-score <N>] [--apply]
 *
 * Flags:
 *   --input <path>    Stage 1 JSON (array of ScrapeResult). Default: outputs/results_scrape.json
 *   --min-score <N>   Minimum score to count a job as "quality". Default: 6
 *   --apply           Overwrite pipeline/company_career_urls.json with the pruned list.
 *                     Without this flag the script only proposes changes.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ScrapeResult } from "../types.js";
import { loadJsonWeights, scoreTitle } from "../utils/creativeScoreLib.js";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const CAREER_URLS_PATH = path.join(ROOT, "pipeline", "company_career_urls.json");
const SCORE_JSON_PATH = path.join(ROOT, "pipeline", "creativeScore.json");
const LOW_YIELD_PATH = path.join(ROOT, "pipeline", "low_yield_companies.json");
const PRUNED_PATH = path.join(ROOT, "pipeline", "company_career_urls.pruned.json");

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------
function parseArgs(): { input: string; minScore: number; apply: boolean } {
  const args = process.argv.slice(2);

  const inputIdx = args.indexOf("--input");
  const input =
    inputIdx >= 0 && args[inputIdx + 1]
      ? args[inputIdx + 1]
      : path.join(ROOT, "outputs", "results_scrape.json");

  const minScoreIdx = args.indexOf("--min-score");
  const minScoreRaw = minScoreIdx >= 0 ? Number(args[minScoreIdx + 1]) : 6;
  const minScore = Number.isFinite(minScoreRaw) && minScoreRaw >= 1 ? Math.round(minScoreRaw) : 6;

  const apply = args.includes("--apply");

  return { input: path.resolve(ROOT, input), minScore, apply };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface CompanyStats {
  source: string;
  totalJobs: number;
  qualityJobs: number; // count with score >= minScore
}

async function main(): Promise<void> {
  const { input, minScore, apply } = parseArgs();

  // 1. Load Stage 1 input
  if (!existsSync(input)) {
    console.error(
      `\nError: Stage 1 output not found at: ${input}\n\n` +
      `Run Stage 1 first:\n` +
      `  npm run stage1\n` +
      `  # or: npx tsx pipeline/stage1_scrapeCareers.ts --output outputs/results_scrape.json\n` +
      `\nThen re-run:\n` +
      `  npm run prune-companies -- --input <path-to-stage1-output.json>\n`
    );
    process.exit(1);
  }

  console.log(`[prune] Loading Stage 1 results from: ${input}`);
  const scrapeRaw: unknown = JSON.parse(await readFile(input, "utf-8"));
  if (!Array.isArray(scrapeRaw)) {
    console.error(`Error: Stage 1 file must be a JSON array of ScrapeResult objects.`);
    process.exit(1);
  }
  const scrapeResults = scrapeRaw as ScrapeResult[];

  // 2. Load scoring weights (shared lib — same rubric as score_jobs.py)
  const weights = await loadJsonWeights(SCORE_JSON_PATH);
  console.log(
    weights
      ? `[prune] Loaded ${weights.length} keyword weights from creativeScore.json`
      : `[prune] Using hardcoded fallback tier scoring`
  );

  // 3. Load master URL list
  const urlsRaw: unknown = JSON.parse(await readFile(CAREER_URLS_PATH, "utf-8"));
  if (!Array.isArray(urlsRaw)) {
    console.error(`Error: ${CAREER_URLS_PATH} must be a JSON array of URLs.`);
    process.exit(1);
  }
  const masterUrls = (urlsRaw as unknown[]).filter((u): u is string => typeof u === "string");
  console.log(`[prune] Loaded ${masterUrls.length} URLs from company_career_urls.json`);

  // 4. Build a map of source → stats from Stage 1 results
  const statsMap = new Map<string, CompanyStats>();
  for (const result of scrapeResults) {
    const qualityJobs = result.creative_jobs.filter(
      (job) => scoreTitle(job.title, weights) >= minScore
    ).length;
    statsMap.set(result.source, {
      source: result.source,
      totalJobs: result.jobs_count,
      qualityJobs,
    });
  }

  // 5. Partition master URL list into buckets
  const keep: string[] = [];
  const lowYield: string[] = [];
  const zeroJobs: string[] = [];
  const notInScrape: string[] = [];

  for (const url of masterUrls) {
    const stats = statsMap.get(url);
    if (stats === undefined) {
      notInScrape.push(url);
    } else if (stats.totalJobs === 0) {
      zeroJobs.push(url);
    } else if (stats.qualityJobs === 0) {
      lowYield.push(url);
    } else {
      keep.push(url);
    }
  }

  // 6. Compute yield metric
  const totalQualityJobs = keep.reduce((sum, url) => {
    const stats = statsMap.get(url);
    return sum + (stats?.qualityJobs ?? 0);
  }, 0);
  const yieldPerKeptCompany = keep.length > 0
    ? (totalQualityJobs / keep.length).toFixed(2)
    : "N/A";

  // 7. Print report
  console.log("\n" + "=".repeat(60));
  console.log("PRUNE REPORT");
  console.log("=".repeat(60));
  console.log(`Quality floor (min-score):   ${minScore}`);
  console.log(`Stage 1 input file:          ${input}`);
  console.log(`Companies in master list:    ${masterUrls.length}`);
  console.log(`Companies in Stage 1 scrape: ${scrapeResults.length}`);
  console.log("");
  console.log(`KEEP (≥1 job with score ≥${minScore}): ${keep.length}`);
  console.log(`LOW-YIELD (scraped, 0 quality jobs):  ${lowYield.length}`);
  console.log(`ZERO-JOB (scraped, 0 jobs total):     ${zeroJobs.length}`);
  console.log(`NOT IN SCRAPE (left as-is):           ${notInScrape.length}`);
  console.log("");
  console.log(`Total quality jobs (score ≥${minScore}) across kept companies: ${totalQualityJobs}`);
  console.log(`Yield per kept company:              ${yieldPerKeptCompany} quality jobs/company`);
  console.log("=".repeat(60));

  if (notInScrape.length > 0) {
    console.log(
      `\nNOTE: ${notInScrape.length} URL(s) were in company_career_urls.json but absent from` +
      ` the Stage 1 output. They are NOT dropped — they remain in the proposed pruned list.`
    );
  }

  // 8. Write output files
  await mkdir(path.dirname(LOW_YIELD_PATH), { recursive: true });

  await writeFile(LOW_YIELD_PATH, JSON.stringify(lowYield, null, 2) + "\n", "utf-8");
  console.log(`\n[prune] Wrote low-yield list (${lowYield.length} URLs) → ${LOW_YIELD_PATH}`);

  // Proposed pruned list = keep + notInScrape (don't silently drop unknowns)
  const proposed = [...keep, ...notInScrape];
  await writeFile(PRUNED_PATH, JSON.stringify(proposed, null, 2) + "\n", "utf-8");
  console.log(`[prune] Wrote proposed pruned list (${proposed.length} URLs) → ${PRUNED_PATH}`);

  if (apply) {
    await writeFile(CAREER_URLS_PATH, JSON.stringify(proposed, null, 2) + "\n", "utf-8");
    console.log(`[prune] --apply: Overwrote ${CAREER_URLS_PATH} with ${proposed.length} URLs.`);
  } else {
    console.log(
      `\nTo apply the prune (overwrite company_career_urls.json), re-run with --apply:\n` +
      `  npm run prune-companies -- --input "${input}" --apply`
    );
  }

  console.log("\nDone.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
