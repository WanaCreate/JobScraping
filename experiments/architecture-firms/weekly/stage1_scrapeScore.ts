/**
 * Weekly pipeline — Stage 1: scrape, resume-score, recency-gate.
 *
 *   1. Scrape every firm we scrape successfully (scraper !== "skip"), reusing the
 *      Phase-1 core (processFirm/pool) which already applies the architecture-role
 *      title filter.
 *   2. Score each role for resume fit (title-only) and keep those >= --min-score.
 *   3. Recency: keep roles posted within --days (default 7). Roles with NO posted
 *      date yet are kept as "unknown" and deferred to Stage 2, which collects the
 *      date from the job page — we don't drop a role just because the listing API
 *      didn't carry a date.
 *
 * Run:  npx tsx experiments/architecture-firms/weekly/stage1_scrapeScore.ts
 * Flags: --firm <substr>  --limit N  --concurrency N  --days 7  --min-score 6
 *
 * Output: output/weekly/<date>/stage1_scored.json  (+ .csv)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { type Firm, type ArchJobRow, processFirm, pool } from "../scrape.js";
import { scoreTitleFit } from "./resumeScore.js";
import { normalizePostedDate, cutoffDate, isoDate } from "./dates.js";
import type { Stage1Job } from "./types.js";
import { EXP_DIR, WEEKLY_OUTPUT_DIR, arg, flag, dateFolderName, ensureDir, writeJson, toCsv, isMain } from "./io.js";

const STAGE1_HEADER = ["firm", "title", "fitScore", "recency", "postedDate", "datePosted", "location", "ats", "url"];
const stage1Cells = (j: Stage1Job) => [j.firm, j.title, j.fitScore, j.recency, j.postedDate, j.datePosted, j.location, j.ats, j.url];

export interface Stage1Result {
  runDate: string;
  scrapedAt: string;
  days: number;
  minScore: number;
  firmsScraped: number;
  archTotal: number;
  passedScore: number;
  jobs: Stage1Job[];
}

export async function runStage1(opts?: {
  firm?: string; limit?: number; concurrency?: number; days?: number; minScore?: number;
}): Promise<{ result: Stage1Result; outDir: string }> {
  const allFirms: Firm[] = JSON.parse(readFileSync(join(EXP_DIR, "firms.json"), "utf8"));
  let selected = allFirms.filter((f) => f.scraper !== "skip" && !!f.url);
  if (opts?.firm) selected = selected.filter((f) => f.name.toLowerCase().includes(opts.firm!.toLowerCase()));
  if (opts?.limit) selected = selected.slice(0, opts.limit);

  const concurrency = opts?.concurrency ?? 4;
  const days = opts?.days ?? 7;
  const minScore = opts?.minScore ?? 6;

  const now = new Date();
  const scrapedAt = now.toISOString();
  const runDate = isoDate(now);
  const cutoff = cutoffDate(runDate, days);

  console.log(`[stage1] scraping ${selected.length} firms (concurrency ${concurrency}); fit>=${minScore}, posted<=${days}d (cutoff ${cutoff})\n`);

  const outcomes = await pool(selected, concurrency, async (firm, idx) => {
    const out = await processFirm(firm, scrapedAt);
    const r = out.result;
    const tag = r.status === "ok" ? "OK " : r.status === "error" ? "ERR" : r.status === "no-jobs" ? "---" : "SKP";
    console.log(`[stage1][${idx + 1}/${selected.length}] ${tag} ${firm.name}: ${r.archJobsFound} arch / ${r.totalJobsFound} total${r.error ? `  (${r.error.slice(0, 60)})` : ""}`);
    return out;
  });

  const archRows: ArchJobRow[] = outcomes.flatMap((o) => o.archRows);

  const jobs: Stage1Job[] = [];
  let passedScore = 0;
  for (const r of archRows) {
    const fitScore = scoreTitleFit(r.title);
    if (fitScore < minScore) continue;
    passedScore += 1;

    const postedDate = normalizePostedDate(r.datePosted, runDate);
    // Recency gate: keep if posted within window, OR posted date unknown (defer
    // to Stage 2). Drop only roles we KNOW are older than the window.
    let recency: Stage1Job["recency"];
    if (!postedDate) recency = "unknown";
    else if (postedDate >= cutoff) recency = "recent";
    else continue; // known-older-than-window → drop

    jobs.push({
      firm: r.firm, title: r.title, location: r.location, url: r.url, ats: r.ats,
      datePosted: r.datePosted, postedDate, sourceUrl: r.sourceUrl, scrapedAt,
      fitScore, recency,
    });
  }

  // Highest fit first, then most recent.
  jobs.sort((a, b) => b.fitScore - a.fitScore || (b.postedDate || "").localeCompare(a.postedDate || ""));

  const result: Stage1Result = {
    runDate, scrapedAt, days, minScore,
    firmsScraped: selected.length, archTotal: archRows.length, passedScore, jobs,
  };

  const outDir = join(WEEKLY_OUTPUT_DIR, dateFolderName(now));
  ensureDir(outDir);
  writeJson(join(outDir, "stage1_scored.json"), result);
  writeFileSync(join(outDir, "stage1_scored.csv"), toCsv(jobs, STAGE1_HEADER, stage1Cells), "utf8");

  const recent = jobs.filter((j) => j.recency === "recent").length;
  const unknown = jobs.filter((j) => j.recency === "unknown").length;
  console.log(`\n[stage1] arch roles: ${archRows.length} → passed fit (>=${minScore}): ${passedScore} → recency-kept: ${jobs.length}  (recent ${recent}, date-unknown ${unknown})`);
  console.log(`[stage1] wrote ${join(outDir, "stage1_scored.json")}`);
  return { result, outDir };
}

if (isMain(import.meta.url)) {
  runStage1({
    firm: arg("firm"),
    limit: arg("limit") ? Number(arg("limit")) : undefined,
    concurrency: arg("concurrency") ? Number(arg("concurrency")) : undefined,
    days: arg("days") ? Number(arg("days")) : undefined,
    minScore: arg("min-score") ? Number(arg("min-score")) : undefined,
  }).catch((e) => { console.error(e); process.exit(1); });
}
