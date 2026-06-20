/**
 * scripts/promotePending.ts
 *
 * Promotion gate for newly-discovered ATS URLs. Reads a Stage 1 scrape of
 * pipeline/pending_review.json, scores each company with the shared creative
 * rubric (utils/creativeScoreLib.ts — same as score_jobs.py), and promotes
 * companies that have at least one creative job at score >= min-score into the
 * live company_career_urls.json. The rest are rejected or left pending.
 *
 * Usage (after a Stage 1 scrape of pending_review.json):
 *   npx tsx scripts/promotePending.ts [--input <path>] [--min-score <N>] [--apply]
 *
 * Flags:
 *   --input <path>    Stage 1 JSON (array of ScrapeResult) of the pending URLs.
 *                     Default: outputs/results_pending_11k.json
 *   --min-score <N>   Quality floor for a creative job. Default: 6
 *   --apply           Append promoted URLs to company_career_urls.json (deduped)
 *                     and drop them from pending_review.json. Without --apply the
 *                     script only proposes (writes promoted_companies.json + report).
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ScrapeResult } from "../types.js";
import { loadJsonWeights, scoreTitle } from "../utils/creativeScoreLib.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const CAREER_URLS_PATH = path.join(ROOT, "pipeline", "company_career_urls.json");
const PENDING_PATH = path.join(ROOT, "pipeline", "pending_review.json");
const SCORE_JSON_PATH = path.join(ROOT, "pipeline", "creativeScore.json");
const PROMOTED_PATH = path.join(ROOT, "pipeline", "promoted_companies.json");
const REJECTED_PATH = path.join(ROOT, "pipeline", "pending_review_rejected.json");

function parseArgs(): { input: string; minScore: number; apply: boolean } {
  const args = process.argv.slice(2);

  const inputIdx = args.indexOf("--input");
  const input =
    inputIdx >= 0 && args[inputIdx + 1]
      ? args[inputIdx + 1]
      : path.join(ROOT, "outputs", "results_pending_11k.json");

  const minScoreIdx = args.indexOf("--min-score");
  const minScoreRaw = minScoreIdx >= 0 ? Number(args[minScoreIdx + 1]) : 6;
  const minScore = Number.isFinite(minScoreRaw) && minScoreRaw >= 1 ? Math.round(minScoreRaw) : 6;

  const apply = args.includes("--apply");

  return { input: path.resolve(ROOT, input), minScore, apply };
}

async function readJsonArray(p: string): Promise<string[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(p, "utf-8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string");
  } catch {
    return [];
  }
}

async function main(): Promise<void> {
  const { input, minScore, apply } = parseArgs();

  if (!existsSync(input)) {
    console.error(
      `\nError: Stage 1 scrape of pending_review.json not found at: ${input}\n\n` +
      `Run a Stage 1 scrape of the pending URLs first, e.g.:\n` +
      `  SCRAPER_URLS_FILE=pipeline/pending_review.json SCRAPER_OUTPUT_FILE=outputs/results_pending_11k.json npm run stage1\n` +
      `\nThen re-run:\n` +
      `  npm run promote-pending -- --input ${path.relative(ROOT, input)}\n`
    );
    process.exit(1);
  }

  console.log(`[promote] Loading scrape results from: ${input}`);
  const scrapeRaw: unknown = JSON.parse(await readFile(input, "utf-8"));
  if (!Array.isArray(scrapeRaw)) {
    console.error(`Error: input must be a JSON array of ScrapeResult objects.`);
    process.exit(1);
  }
  const scrapeResults = scrapeRaw as ScrapeResult[];

  const weights = await loadJsonWeights(SCORE_JSON_PATH);
  console.log(
    weights
      ? `[promote] Loaded ${weights.length} keyword weights from creativeScore.json`
      : `[promote] Using hardcoded fallback tier scoring`
  );

  const pendingUrls = await readJsonArray(PENDING_PATH);
  const masterUrls = await readJsonArray(CAREER_URLS_PATH);
  const masterSet = new Set(masterUrls);
  console.log(`[promote] pending_review.json: ${pendingUrls.length} URLs · company_career_urls.json: ${masterUrls.length} URLs`);

  // Partition the SCRAPED sources into promote / reject by quality-job count.
  const promote: string[] = [];
  const rejected: string[] = [];
  let totalQualityJobs = 0;
  const scrapedSources = new Set<string>();

  for (const result of scrapeResults) {
    scrapedSources.add(result.source);
    const qualityJobs = result.creative_jobs.filter(
      (job) => scoreTitle(job.title, weights) >= minScore
    ).length;
    if (qualityJobs > 0) {
      // Don't re-promote something already in the live list.
      if (!masterSet.has(result.source)) promote.push(result.source);
      totalQualityJobs += qualityJobs;
    } else {
      rejected.push(result.source);
    }
  }

  // Pending URLs never reached by the scrape (timeout, not in input subset) stay pending.
  const notScraped = pendingUrls.filter((u) => !scrapedSources.has(u));

  // Report
  console.log("\n" + "=".repeat(60));
  console.log("PROMOTION REPORT");
  console.log("=".repeat(60));
  console.log(`Quality floor (min-score):       ${minScore}`);
  console.log(`Scrape input:                    ${input}`);
  console.log(`Companies scraped:               ${scrapeResults.length}`);
  console.log("");
  console.log(`PROMOTE (≥1 job score ≥${minScore}, new):  ${promote.length}`);
  console.log(`REJECT  (scraped, 0 quality jobs):  ${rejected.length}`);
  console.log(`NOT REACHED (still pending):        ${notScraped.length}`);
  console.log("");
  console.log(`Total quality jobs across promoted: ${totalQualityJobs}`);
  if (promote.length > 0) {
    console.log(`Yield per promoted company:         ${(totalQualityJobs / promote.length).toFixed(2)} quality jobs/company`);
  }
  console.log("=".repeat(60));

  // Always write the proposal artifacts.
  await mkdir(path.dirname(PROMOTED_PATH), { recursive: true });
  await writeFile(PROMOTED_PATH, JSON.stringify(promote, null, 2) + "\n", "utf-8");
  console.log(`\n[promote] Wrote promote list (${promote.length}) → ${PROMOTED_PATH}`);
  await writeFile(REJECTED_PATH, JSON.stringify(rejected, null, 2) + "\n", "utf-8");
  console.log(`[promote] Wrote rejected list (${rejected.length}) → ${REJECTED_PATH}`);

  if (apply) {
    // Append promoted to the live list (dedup, preserve existing order).
    const merged = [...masterUrls];
    for (const u of promote) if (!masterSet.has(u)) { merged.push(u); masterSet.add(u); }
    await writeFile(CAREER_URLS_PATH, JSON.stringify(merged, null, 2) + "\n", "utf-8");
    console.log(`[promote] --apply: company_career_urls.json now ${merged.length} URLs (+${merged.length - masterUrls.length}).`);

    // Drop promoted + rejected from pending; keep only the not-yet-decided.
    const decided = new Set<string>([...promote, ...rejected]);
    const remainingPending = pendingUrls.filter((u) => !decided.has(u));
    await writeFile(PENDING_PATH, JSON.stringify(remainingPending, null, 2) + "\n", "utf-8");
    console.log(`[promote] --apply: pending_review.json trimmed ${pendingUrls.length} → ${remainingPending.length}.`);
  } else {
    console.log(
      `\nReview ${path.relative(ROOT, PROMOTED_PATH)}, then apply with:\n` +
      `  npm run promote-pending -- --input "${path.relative(ROOT, input)}" --apply`
    );
  }

  console.log("\nDone.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
