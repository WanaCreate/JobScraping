/**
 * Weekly pipeline — Stage 2: collect full job detail + heuristic date/location.
 *
 * For each Stage 1 job, fetch the detail page (enrich.ts) and resolve:
 *   - full description
 *   - location   (seed → JSON-LD → description heuristic)   [point 4]
 *   - posted date (source → JSON-LD datePosted → description heuristic) [point 4]
 *   - work type, and a description-aware resume-fit re-score
 * Then re-apply the recency window now that previously-unknown dates are known
 * (drop roles revealed to be older than the window; keep still-unknown ones).
 *
 * Run:  npx tsx experiments/architecture-firms/weekly/stage2_collect.ts
 * Flags: --days 7  --concurrency 3  --no-playwright   (reads latest stage1_scored.json)
 *
 * Output: output/weekly/<date>/stage2_enriched.json  (+ .csv)
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { pool } from "../scrape.js";
import { scoreResumeFit } from "./resumeScore.js";
import { enrichDetail } from "./enrich.js";
import { normalizePostedDate, cutoffDate, daysBetween, isoDate } from "./dates.js";
import type { Stage1Job, Stage2Job } from "./types.js";
import type { Stage1Result } from "./stage1_scrapeScore.js";
import { WEEKLY_OUTPUT_DIR, arg, flag, dateFolderName, ensureDir, writeJson, readJson, toCsv, isMain } from "./io.js";

const STAGE2_HEADER = [
  "firm", "title", "fitScoreFull", "postedDateResolved", "daysAgo", "postedDateSource",
  "locationResolved", "locationSource", "workType", "descriptionChars", "enrichStatus", "ats", "url",
];
const stage2Cells = (j: Stage2Job) => [
  j.firm, j.title, j.fitScoreFull, j.postedDateResolved, j.daysAgo ?? "", j.postedDateSource,
  j.locationResolved, j.locationSource, j.workType, j.descriptionChars, j.enrichStatus, j.ats, j.url,
];

/** Find the most recent output/weekly/<date>/ that has a stage1 file. */
function latestStage1Dir(): string | null {
  if (!existsSync(WEEKLY_OUTPUT_DIR)) return null;
  const dirs = readdirSync(WEEKLY_OUTPUT_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(WEEKLY_OUTPUT_DIR, d.name, "stage1_scored.json")))
    .map((d) => d.name);
  if (dirs.length === 0) return null;
  // folder names are "Month D-YYYY"; sort by the embedded date
  dirs.sort((a, b) => +new Date(b.replace(/(\D+)(\d+)-(\d+)/, "$1 $2 $3")) - +new Date(a.replace(/(\D+)(\d+)-(\d+)/, "$1 $2 $3")));
  return join(WEEKLY_OUTPUT_DIR, dirs[0]);
}

export async function runStage2(opts?: {
  dir?: string; days?: number; concurrency?: number; allowPlaywright?: boolean;
}): Promise<{ jobs: Stage2Job[]; outDir: string }> {
  const outDir = opts?.dir ?? latestStage1Dir();
  if (!outDir) throw new Error("[stage2] no stage1_scored.json found — run stage 1 first.");

  const stage1 = readJson<Stage1Result>(join(outDir, "stage1_scored.json"));
  const days = opts?.days ?? stage1.days ?? 7;
  const concurrency = opts?.concurrency ?? 3;
  const allowPlaywright = opts?.allowPlaywright ?? true;

  const runDate = isoDate(new Date());
  const cutoff = cutoffDate(runDate, days);
  const seeds: Stage1Job[] = stage1.jobs;

  console.log(`[stage2] enriching ${seeds.length} jobs (concurrency ${concurrency}, playwright ${allowPlaywright ? "on" : "off"})...\n`);

  const enriched = await pool(seeds, concurrency, async (seed, idx): Promise<Stage2Job> => {
    let detail;
    try {
      detail = await enrichDetail(seed.url, { allowPlaywright });
    } catch {
      detail = null;
    }

    const description = detail?.description ?? "";
    const enrichStatus: Stage2Job["enrichStatus"] = detail?.fetched ? "ok" : "fetch-failed";

    // Resolve location: prefer detail (jsonld/description), else seed.
    let locationResolved = seed.location;
    let locationSource: Stage2Job["locationSource"] = seed.location ? "seed" : "none";
    if (detail && detail.location) {
      locationResolved = detail.location;
      locationSource = detail.locationSource === "none" ? locationSource : detail.locationSource;
    }

    // Resolve posted date: prefer stage-1 source date, else detail jsonld/desc heuristic.
    let postedDateResolved = seed.postedDate; // already normalized from source (may be "")
    let postedDateSource: Stage2Job["postedDateSource"] = seed.postedDate ? "source" : "none";
    if (!postedDateResolved && detail && detail.postedDate) {
      const norm = normalizePostedDate(detail.postedDate, runDate);
      if (norm) {
        postedDateResolved = norm;
        postedDateSource = detail.postedDateSource === "none" ? "none" : detail.postedDateSource;
      }
    }

    const daysAgo = postedDateResolved ? daysBetween(postedDateResolved, runDate) : null;
    const fitScoreFull = scoreResumeFit(seed.title, description).score;

    console.log(`[stage2][${idx + 1}/${seeds.length}] ${enrichStatus === "ok" ? "OK " : "FX "} ${seed.firm}: ${seed.title.slice(0, 48)} | ${postedDateResolved || "date?"} | ${locationResolved || "loc?"}`);

    return {
      ...seed,
      description,
      descriptionChars: description.length,
      locationResolved,
      locationSource,
      postedDateResolved,
      postedDateSource,
      daysAgo,
      workType: detail?.workType ?? "",
      fitScoreFull,
      enrichStatus,
    };
  });

  // Re-apply recency now that dates may be resolved: drop known-older-than-window,
  // keep still-unknown (optimistic — Stage 3 will US-filter; we don't want to lose
  // a fresh role just because no date was published anywhere).
  const kept = enriched.filter((j) => !(j.postedDateResolved && j.postedDateResolved < cutoff));
  const droppedOld = enriched.length - kept.length;

  kept.sort((a, b) => b.fitScoreFull - a.fitScoreFull || (b.postedDateResolved || "").localeCompare(a.postedDateResolved || ""));

  ensureDir(outDir);
  writeJson(join(outDir, "stage2_enriched.json"), { runDate, days, count: kept.length, jobs: kept });
  writeFileSync(join(outDir, "stage2_enriched.csv"), toCsv(kept, STAGE2_HEADER, stage2Cells), "utf8");

  const dateResolved = kept.filter((j) => j.postedDateResolved).length;
  const locResolved = kept.filter((j) => j.locationResolved).length;
  console.log(`\n[stage2] enriched ${enriched.length} → kept ${kept.length} (dropped ${droppedOld} now-known-older-than-${days}d)`);
  console.log(`[stage2] posted date known: ${dateResolved}/${kept.length} | location known: ${locResolved}/${kept.length}`);
  console.log(`[stage2] wrote ${join(outDir, "stage2_enriched.json")}`);
  return { jobs: kept, outDir };
}

if (isMain(import.meta.url)) {
  runStage2({
    days: arg("days") ? Number(arg("days")) : undefined,
    concurrency: arg("concurrency") ? Number(arg("concurrency")) : undefined,
    allowPlaywright: flag("no-playwright") ? false : undefined,
  }).catch((e) => { console.error(e); process.exit(1); });
}
