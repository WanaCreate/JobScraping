/**
 * Weekly tracker pipeline — orchestrator. Runs Stage 1 → 2 → 3 in one go.
 *
 * This is the WEEKLY pipeline (resume-fit scoring + 1-week recency + full detail
 * collection + optimistic US filter). It is SEPARATE from the daily tracker
 * (track.ts), which diffs for newly-appeared roles. They share the scraping core
 * and the usGeo classifier but serve different purposes.
 *
 * Run:  npx tsx experiments/architecture-firms/weekly/run.ts
 * Flags: --firm <substr>  --limit N  --concurrency N  --days 7  --min-score 6
 *        --enrich-concurrency 3  --no-playwright
 *
 * Output: output/weekly/<date>/  (stage1_scored, stage2_enriched, weekly_jobs_<date>.csv)
 */
import { runStage1 } from "./stage1_scrapeScore.js";
import { runStage2 } from "./stage2_collect.js";
import { runStage3 } from "./stage3_usFilter.js";
import { arg, flag, isMain } from "./io.js";

async function main() {
  const days = arg("days") ? Number(arg("days")) : 7;
  const minScore = arg("min-score") ? Number(arg("min-score")) : 6;

  console.log(`\n===== WEEKLY TRACKER PIPELINE =====`);
  const { outDir } = await runStage1({
    firm: arg("firm"),
    limit: arg("limit") ? Number(arg("limit")) : undefined,
    concurrency: arg("concurrency") ? Number(arg("concurrency")) : undefined,
    days,
    minScore,
  });

  console.log(`\n----- Stage 2 -----`);
  await runStage2({
    dir: outDir,
    days,
    concurrency: arg("enrich-concurrency") ? Number(arg("enrich-concurrency")) : 3,
    allowPlaywright: flag("no-playwright") ? false : undefined,
  });

  console.log(`\n----- Stage 3 -----`);
  runStage3({ dir: outDir });

  console.log(`\n===== DONE — see ${outDir} =====`);
}

if (isMain(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
