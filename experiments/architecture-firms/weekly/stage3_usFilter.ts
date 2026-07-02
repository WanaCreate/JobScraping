/**
 * Weekly pipeline — Stage 3: optimistic US-only filter.
 *
 * Classifies each enriched role's resolved location with the shared heuristic
 * (usGeo.classifyLocation) and keeps it UNLESS it's confirmed foreign. "Optimistic"
 * per spec: roles whose location is US *or* unknown/ambiguous pass through — we
 * accept some non-US noise rather than risk dropping a real US listing.
 *
 * Run:  npx tsx experiments/architecture-firms/weekly/stage3_usFilter.ts
 *
 * Output: output/weekly/<date>/stage3_us_jobs.json  (+ weekly_jobs_<date>.csv — the deliverable)
 */
import { writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { classifyLocation } from "../usGeo.js";
import type { Stage2Job, Stage3Job } from "./types.js";
import { WEEKLY_OUTPUT_DIR, arg, dateFolderName, ensureDir, writeJson, readJson, toCsv, isMain } from "./io.js";

const FINAL_HEADER = [
  "firm", "title", "fitScoreFull", "geo", "postedDateResolved", "daysAgo",
  "locationResolved", "workType", "ats", "url",
];
const finalCells = (j: Stage3Job) => [
  j.firm, j.title, j.fitScoreFull, j.geo, j.postedDateResolved, j.daysAgo ?? "",
  j.locationResolved, j.workType, j.ats, j.url,
];

function latestStage2Dir(): string | null {
  if (!existsSync(WEEKLY_OUTPUT_DIR)) return null;
  const dirs = readdirSync(WEEKLY_OUTPUT_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(WEEKLY_OUTPUT_DIR, d.name, "stage2_enriched.json")))
    .map((d) => d.name);
  if (dirs.length === 0) return null;
  dirs.sort((a, b) => +new Date(b.replace(/(\D+)(\d+)-(\d+)/, "$1 $2 $3")) - +new Date(a.replace(/(\D+)(\d+)-(\d+)/, "$1 $2 $3")));
  return join(WEEKLY_OUTPUT_DIR, dirs[0]);
}

export function runStage3(opts?: { dir?: string }): { jobs: Stage3Job[]; outDir: string } {
  const outDir = opts?.dir ?? latestStage2Dir();
  if (!outDir) throw new Error("[stage3] no stage2_enriched.json found — run stage 2 first.");

  const stage2 = readJson<{ jobs: Stage2Job[]; runDate?: string }>(join(outDir, "stage2_enriched.json"));
  const classified: Stage3Job[] = stage2.jobs.map((j) => {
    const geo = classifyLocation(j.locationResolved);
    return { ...j, geo, kept: geo !== "foreign" };
  });

  const kept = classified.filter((j) => j.kept);
  const dropped = classified.filter((j) => !j.kept);

  const folder = outDir.split(/[\\/]/).pop() ?? dateFolderName(new Date());
  ensureDir(outDir);
  writeJson(join(outDir, "stage3_us_jobs.json"), {
    count: kept.length,
    breakdown: {
      us: kept.filter((j) => j.geo === "us").length,
      unknown: kept.filter((j) => j.geo === "unknown").length,
      foreignDropped: dropped.length,
    },
    jobs: kept,
  });
  // The deliverable.
  writeFileSync(join(outDir, `weekly_jobs_${folder}.csv`), toCsv(kept, FINAL_HEADER, finalCells), "utf8");
  // Keep the excluded-foreign list for auditing.
  writeFileSync(join(outDir, "stage3_dropped_foreign.csv"), toCsv(dropped, FINAL_HEADER, finalCells), "utf8");

  const us = kept.filter((j) => j.geo === "us").length;
  const unk = kept.filter((j) => j.geo === "unknown").length;
  console.log(`[stage3] ${classified.length} enriched → kept ${kept.length} (US ${us}, unknown/ambiguous ${unk}) | dropped confirmed-foreign ${dropped.length}`);

  const byFirm: Record<string, number> = {};
  for (const j of kept) byFirm[j.firm] = (byFirm[j.firm] ?? 0) + 1;
  console.log(`\nKept roles by firm:`);
  for (const f of Object.keys(byFirm).sort((a, b) => byFirm[b] - byFirm[a])) {
    console.log(`  ${String(byFirm[f]).padStart(3)}  ${f}`);
  }
  console.log(`\n[stage3] deliverable: ${join(outDir, `weekly_jobs_${folder}.csv`)}  (${kept.length} rows)`);
  return { jobs: kept, outDir };
}

if (isMain(import.meta.url)) {
  runStage3({ dir: arg("dir") });
}
