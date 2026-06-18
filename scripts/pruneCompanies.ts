/**
 * scripts/pruneCompanies.ts
 *
 * Partition company_career_urls.json into keep / low-yield / unknown buckets
 * based on a Stage 1 scrape output, using the same scoring logic as score_jobs.py.
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
// Scoring — exact port of score_jobs.py logic
//
// score_jobs.py:
//   1. text = (title + " " + desc_snippet).lower()
//   2. If JSON weights loaded: iterate all (pattern, weight), take MAX matching
//      weight, round(), clamp [2, 10]. If no match → return 3 (neutral default).
//   3. Fallback (no JSON): first matching tier wins: 10 > 8 > 6 > 4 > 2. Default 3.
//
// Here we only have titles (no description snippet from Stage 1 creative_jobs),
// so we score title.toLowerCase() alone — identical to what score_jobs.py does
// when desc_snippet is "".
// ---------------------------------------------------------------------------

type JsonWeightEntry = [RegExp, number]; // [compiled pattern, weight]

// Hardcoded tier fallback patterns (verbatim from score_jobs.py)
const SCORE_10_PATTERNS = [
  /\billustrat/i, /\banimator\b/i, /\banimation\b/i, /\bart director\b/i,
  /\bgraphic design/i, /\bvisual design/i, /\bux design/i, /\bui design/i,
  /\bui\/ux\b/i, /\bux\/ui\b/i, /\bvideo edit/i, /\bmotion design/i,
  /\bmotion graphic/i, /\bgame design/i, /\bcharacter design/i,
  /\btypograph/i, /\bfashion design/i, /\bjewelry design/i,
  /\bindustrial design/i, /\bproduct design/i, /\binteraction design/i,
  /\bexperience design/i, /\bcreative direct/i, /\bart lead\b/i,
  /\bconceptual artist\b/i, /\bconcept artist\b/i, /\bdigital artist\b/i,
  /\bfine art\b/i, /\bphotograph/i, /\bvideograph/i, /\bcinematograph/i,
  /\bsound design/i, /\bmusic produc/i, /\baudio engineer/i,
  /\bvfx\b/i, /\bspecial effects\b/i, /\b3d artist\b/i, /\b3d model/i,
  /\bsculptor\b/i, /\bstoryboard/i, /\bcomic\b/i, /\bcartoon/i,
  /\bfootwear design/i, /\btextile design/i, /\bapparel design/i,
  /\bpackaging design/i, /\bprint design/i,
];

const SCORE_8_PATTERNS = [
  /\bcopywriter\b/i, /\bcreative writer\b/i, /\bcontent creator\b/i,
  /\bbrand design/i, /\bbrand identity\b/i, /\bcreative strateg/i,
  /\bcreative produc/i, /\bvisual storytell/i, /\bsocial media content\b/i,
  /\beditorial design/i, /\bweb design/i, /\bfront.end design/i,
  /\bcreative services\b/i, /\bcreative team\b/i, /\bcreative manager\b/i,
  /\bcreative lead\b/i, /\bcreative specialist\b/i,
  /\bsenior designer\b/i, /\blead designer\b/i, /\bstaff designer\b/i,
  /\bux researcher\b/i, /\buser research/i, /\bproduct designer\b/i,
  /\bspatial design/i, /\benvironmental design/i,
  /\bmusician\b/i, /\bcomposer\b/i, /\blyricist\b/i,
  /\bfilm\b.*\bproduc/i, /\bproduction design/i,
  /\bcontent design/i, /\bcreative content\b/i,
];

const SCORE_6_PATTERNS = [
  /\bmarketing design/i, /\bcampaign manag/i, /\bbrand manag/i,
  /\bcontent manag/i, /\bcontent strateg/i, /\bcontent market/i,
  /\bsocial media manag/i, /\bcommunity manag/i,
  /\bux\b/i, /\bui\b/i, /\buser experience\b/i, /\buser interface\b/i,
  /\bcreative\b/i, /\bdesign\b/i, /\bvisual\b/i,
  /\bwriter\b/i, /\beditor\b/i, /\bproducer\b/i,
  /\bstylish\b/i, /\bstylist\b/i, /\bfashion\b/i,
  /\barch(itect|itectur)/i, /\binterior\b/i,
  /\bgame dev/i, /\bgame artist\b/i,
  /\bphotoshop\b/i, /\bsketch\b.*\bdesign/i,
  /\bdigital market/i, /\becommerce.*design/i,
  /\bcreative ops\b/i, /\bcreative operat/i,
  /\bnarrat/i, /\bstorytell/i,
  /\bweb content\b/i, /\bcopyedit/i,
  /\bpost produc/i, /\bbroadcast/i,
];

const SCORE_4_PATTERNS = [
  /\bmarketing\b/i, /\bbrand\b/i, /\bcommunic/i,
  /\bsocial media\b/i, /\bpublic relation/i, /\bpr\b/i,
  /\bproduct manag/i, /\bprogram manag/i,
  /\bproject manag.*creative/i, /\bcreative.*project/i,
  /\bcustomer experienc/i, /\bcx\b/i,
  /\bcontent\b/i, /\bmedia\b/i,
  /\btraining.*design/i, /\binstructional design/i,
  /\bevent\b/i, /\bshow\b.*\bproduc/i,
  /\bstudio manag/i, /\bstudio operat/i,
  /\bdigital.*manag/i, /\bdigital prod/i,
];

const SCORE_2_PATTERNS = [
  /\bengine/i, /\bdevelop/i, /\bsoftware\b/i, /\bdata\b/i,
  /\banalyst\b/i, /\banalysis\b/i, /\bscient/i,
  /\bfinance\b/i, /\bfinancial\b/i, /\baccounting\b/i,
  /\boperat/i, /\blogistic/i, /\bsupply chain\b/i,
  /\bproject manag\b/i, /\bprogram manag\b/i,
  /\bhr\b/i, /\bhuman resource/i, /\brecruit/i,
  /\bsafety\b/i, /\bcomplian/i, /\blegal\b/i,
  /\bsales\b/i, /\bbusiness dev/i, /\baccount exec/i,
  /\bcustomer support\b/i, /\bcustomer service\b/i,
  /\bwarehouse\b/i, /\bmanufactur/i, /\bproduct/i,
  /\badmin\b/i, /\bcoordinat/i, /\bassistant\b/i,
];

/** Hardcoded fallback scoring (score_jobs.py: _score_fallback) */
function scoreFallback(text: string): number {
  for (const p of SCORE_10_PATTERNS) if (p.test(text)) return 10;
  for (const p of SCORE_8_PATTERNS) if (p.test(text)) return 8;
  for (const p of SCORE_6_PATTERNS) if (p.test(text)) return 6;
  for (const p of SCORE_4_PATTERNS) if (p.test(text)) return 4;
  for (const p of SCORE_2_PATTERNS) if (p.test(text)) return 2;
  return 3;
}

/** Load and compile JSON weights. Returns null if file missing/malformed. */
async function loadJsonWeights(): Promise<JsonWeightEntry[] | null> {
  try {
    const raw = await readFile(SCORE_JSON_PATH, "utf-8");
    const data: unknown = JSON.parse(raw);
    if (
      typeof data !== "object" ||
      data === null ||
      !("weights" in data) ||
      typeof (data as Record<string, unknown>).weights !== "object" ||
      (data as Record<string, unknown>).weights === null
    ) {
      throw new Error("'weights' key missing or not an object");
    }
    const weightsObj = (data as { weights: Record<string, unknown> }).weights;
    const entries: JsonWeightEntry[] = [];
    for (const [key, val] of Object.entries(weightsObj)) {
      const weight = typeof val === "number" ? val : parseFloat(String(val));
      if (!Number.isFinite(weight)) continue;
      // word-boundary pattern: \b<escaped-keyword>\b (same as score_jobs.py)
      const pattern = new RegExp("\\b" + key.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "i");
      entries.push([pattern, weight]);
    }
    if (entries.length === 0) throw new Error("no valid weight entries");
    // Sort descending by weight (matches score_jobs.py intent — we take MAX anyway)
    entries.sort((a, b) => b[1] - a[1]);
    return entries;
  } catch (err) {
    console.warn(
      `[prune] WARNING: Could not load ${SCORE_JSON_PATH} (${(err as Error).message}) — using hardcoded fallback tiers.`
    );
    return null;
  }
}

/**
 * Score a job title using the same logic as score_jobs.py:score_title_desc.
 * We pass title only (no desc snippet) — Stage 1 creative_jobs has no snippet.
 */
function scoreTitle(title: string, weights: JsonWeightEntry[] | null): number {
  const text = title.toLowerCase();

  if (weights !== null) {
    let best: number | null = null;
    for (const [pattern, weight] of weights) {
      if (pattern.test(text)) {
        if (best === null || weight > best) best = weight;
      }
    }
    if (best !== null) {
      return Math.max(2, Math.min(10, Math.round(best)));
    }
    // No keyword matched → neutral default (same as score_jobs.py)
    return 3;
  }

  return scoreFallback(text);
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

  // 2. Load scoring weights
  const weights = await loadJsonWeights();
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

  // 5. Partition master URL list into three buckets
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
