/**
 * scripts/measureDiscovery.ts
 *
 * Phase 1 measurement tool: reads a Stage 1 scrape of discovered boards and
 * prints the key metrics needed to answer "how close does the free ATS-discovery
 * path alone get to 100K creative jobs/week?"
 *
 * Typical flow:
 *   1. npm run discover-slugs          # populate pipeline/pending_review.json
 *   2. npm run scrape-pending           # Stage 1 scrape of all discovered boards
 *   3. npm run measure-discovery        # this script
 *   4. npm run promote-pending -- --input outputs/results_pending.json --apply
 *                                       # merge qualifying boards into company_career_urls.json
 *
 * Usage:
 *   npx tsx scripts/measureDiscovery.ts [--input <path>] [--min-score <N>]
 *                                        [--output <path>] [--no-persist]
 *
 * Flags:
 *   --input <path>     Stage 1 JSON (ScrapeResult[]).
 *                      Default: outputs/results_pending.json
 *   --min-score <N>    scoreTitle threshold for a "qualifying creative job".
 *                      Default: 4 (keeps designer 6.4, copywriter ~4, drops
 *                      "project manager" 3.37 / "web developer" 2.18)
 *   --output <path>    Where to write discovered_boards.json (boards with ≥1
 *                      qualifying job). Default: pipeline/discovered_boards.json
 *   --no-persist       Print the report only; do not write discovered_boards.json
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "url";
import type { ScrapeResult } from "../types.js";
import { loadJsonWeights, scoreTitle } from "../utils/creativeScoreLib.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const SCORE_JSON_PATH = path.join(ROOT, "pipeline", "creativeScore.json");

function parseArgs(): {
  input: string;
  minScore: number;
  output: string;
  persist: boolean;
} {
  const args = process.argv.slice(2);

  const inputIdx = args.indexOf("--input");
  const input =
    inputIdx >= 0 && args[inputIdx + 1]
      ? path.resolve(ROOT, args[inputIdx + 1])
      : path.join(ROOT, "outputs", "results_pending.json");

  const minScoreIdx = args.indexOf("--min-score");
  const minScoreRaw = minScoreIdx >= 0 ? Number(args[minScoreIdx + 1]) : 4;
  const minScore =
    Number.isFinite(minScoreRaw) && minScoreRaw >= 1 ? minScoreRaw : 4;

  const outputIdx = args.indexOf("--output");
  const output =
    outputIdx >= 0 && args[outputIdx + 1]
      ? path.resolve(ROOT, args[outputIdx + 1])
      : path.join(ROOT, "pipeline", "discovered_boards.json");

  const persist = !args.includes("--no-persist");

  return { input, minScore, output, persist };
}

interface AtsStats {
  boards: number;
  boardsWithHits: number;
  totalJobs: number;
  qualifyingJobs: number;
}

async function main(): Promise<void> {
  const { input, minScore, output, persist } = parseArgs();

  if (!existsSync(input)) {
    console.error(
      `\nError: Stage 1 scrape not found at: ${input}\n\n` +
        `Run a Stage 1 scrape of the discovered boards first:\n` +
        `  npm run scrape-pending\n` +
        `or:\n` +
        `  SCRAPER_URLS_FILE=pipeline/pending_review.json ` +
        `SCRAPER_OUTPUT_FILE=outputs/results_pending.json npm run stage1\n`
    );
    process.exit(1);
  }

  console.log(`[measure] Loading scrape results from: ${input}`);
  const raw: unknown = JSON.parse(await readFile(input, "utf-8"));
  if (!Array.isArray(raw)) {
    console.error("Error: input must be a JSON array of ScrapeResult objects.");
    process.exit(1);
  }
  const results = raw as ScrapeResult[];

  const weights = await loadJsonWeights(SCORE_JSON_PATH);
  console.log(
    weights
      ? `[measure] Loaded ${weights.length} keyword weights from creativeScore.json`
      : `[measure] Using hardcoded fallback tier scoring`
  );
  console.log(`[measure] Qualifying threshold: scoreTitle ≥ ${minScore}\n`);

  // Per-ATS aggregates
  const atsMap = new Map<string, AtsStats>();
  const qualifyingBoardUrls: string[] = [];

  let totalBoards = 0;
  let totalBoardsWithHits = 0;
  let totalRawJobs = 0;
  let totalQualifyingJobs = 0;

  for (const result of results) {
    const atsKey = result.ats ?? "unknown";
    if (!atsMap.has(atsKey)) {
      atsMap.set(atsKey, {
        boards: 0,
        boardsWithHits: 0,
        totalJobs: 0,
        qualifyingJobs: 0,
      });
    }
    const stat = atsMap.get(atsKey)!;

    stat.boards++;
    totalBoards++;
    stat.totalJobs += result.jobs_count ?? 0;
    totalRawJobs += result.jobs_count ?? 0;

    // creative_jobs already passed the regex filter in stage1; apply scoreTitle on top
    const qualCount = (result.creative_jobs ?? []).filter(
      (job) => scoreTitle(job.title, weights) >= minScore
    ).length;

    stat.qualifyingJobs += qualCount;
    totalQualifyingJobs += qualCount;

    if (qualCount > 0) {
      stat.boardsWithHits++;
      totalBoardsWithHits++;
      qualifyingBoardUrls.push(result.source);
    }
  }

  // Print report
  const bar = "=".repeat(72);
  const dash = "-".repeat(72);
  console.log(bar);
  console.log("PHASE 1 DISCOVERY MEASUREMENT REPORT");
  console.log(bar);
  console.log(`Input file:          ${input}`);
  console.log(`Min score threshold: ${minScore}`);
  console.log("");
  console.log(
    `${"ATS".padEnd(18)}${"Boards".padEnd(10)}${"w/ hits".padEnd(10)}` +
      `${"Hit %".padEnd(10)}${"Raw jobs".padEnd(12)}${"Qual. jobs".padEnd(14)}` +
      `${"Qual/board".padEnd(12)}`
  );
  console.log(dash);

  // Sort by qualifying jobs descending
  const sortedAts = [...atsMap.entries()].sort(
    (a, b) => b[1].qualifyingJobs - a[1].qualifyingJobs
  );

  for (const [atsKey, s] of sortedAts) {
    const hitPct =
      s.boards > 0 ? ((s.boardsWithHits / s.boards) * 100).toFixed(1) : "0.0";
    const qpb =
      s.boardsWithHits > 0
        ? (s.qualifyingJobs / s.boardsWithHits).toFixed(1)
        : "0.0";
    console.log(
      `${atsKey.padEnd(18)}${String(s.boards).padEnd(10)}${String(s.boardsWithHits).padEnd(10)}` +
        `${(hitPct + "%").padEnd(10)}${String(s.totalJobs).padEnd(12)}${String(s.qualifyingJobs).padEnd(14)}` +
        `${qpb.padEnd(12)}`
    );
  }

  console.log(dash);
  const totalHitPct =
    totalBoards > 0
      ? ((totalBoardsWithHits / totalBoards) * 100).toFixed(1)
      : "0.0";
  const totalQpb =
    totalBoardsWithHits > 0
      ? (totalQualifyingJobs / totalBoardsWithHits).toFixed(1)
      : "0.0";
  console.log(
    `${"TOTAL".padEnd(18)}${String(totalBoards).padEnd(10)}${String(totalBoardsWithHits).padEnd(10)}` +
      `${(totalHitPct + "%").padEnd(10)}${String(totalRawJobs).padEnd(12)}${String(totalQualifyingJobs).padEnd(14)}` +
      `${totalQpb.padEnd(12)}`
  );
  console.log(bar);
  console.log("");
  console.log("SUMMARY");
  console.log(dash);
  console.log(`Boards scraped:                ${totalBoards}`);
  console.log(`Boards with ≥1 qualifying job: ${totalBoardsWithHits} (${totalHitPct}%)`);
  console.log(`Total raw jobs seen:           ${totalRawJobs}`);
  console.log(`Qualifying creative jobs:      ${totalQualifyingJobs}`);
  if (totalBoards > 0) {
    const existingBoardCount = 1000; // approximate current company_career_urls.json size
    const scaleFactor = totalBoards / existingBoardCount;
    const projectedFromExisting = Math.round(totalQualifyingJobs * (existingBoardCount / Math.max(totalBoards, 1)));
    console.log("");
    console.log(
      `Scale factor vs current ~${existingBoardCount} boards: ${scaleFactor.toFixed(1)}×`
    );
    console.log(
      `Estimated weekly yield at this board count:        ${totalQualifyingJobs.toLocaleString()} qualifying jobs`
    );
    console.log(
      `Target 100K/week requires: ~${Math.ceil(100_000 / Math.max(totalQualifyingJobs / Math.max(totalBoardsWithHits, 1), 1)).toLocaleString()} boards with hits`
    );
  }
  console.log(bar);

  if (persist) {
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(
      output,
      JSON.stringify(qualifyingBoardUrls, null, 2) + "\n",
      "utf-8"
    );
    console.log(
      `\n[measure] Wrote ${qualifyingBoardUrls.length} qualifying board URLs → ${output}`
    );
    console.log(
      `\nNext steps:\n` +
        `  1. Review ${path.relative(ROOT, output)} if desired\n` +
        `  2. Merge into the live list:\n` +
        `       npm run promote-pending -- --input ${path.relative(ROOT, input)} --apply\n` +
        `     (promotes boards with ≥1 job at score ≥ ${minScore} into company_career_urls.json)\n` +
        `  3. Run the normal weekly pipeline to collect jobs from all boards:\n` +
        `       npm run stage1`
    );
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
