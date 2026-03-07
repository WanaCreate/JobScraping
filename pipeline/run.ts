/**
 * Unified pipeline runner.
 *
 * Usage:
 *   npx tsx pipeline/run.ts                    # Run all 3 stages
 *   npx tsx pipeline/run.ts --stage 2          # Run stages 2+3 only
 *   npx tsx pipeline/run.ts --stage 3          # Run stage 3 only
 *   npx tsx pipeline/run.ts --stage 1          # Run stage 1 only
 *
 * Options:
 *   --stage <n>         Start from stage N (default: 1)
 *   --run-dir <path>    Use existing run directory (skips timestamp generation)
 *   --concurrency <n>   Override concurrency for all stages
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

function toRunTag(date: Date): string {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const min = String(date.getUTCMinutes()).padStart(2, "0");
  const ss = String(date.getUTCSeconds()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}_${hh}${min}${ss}Z`;
}

function getArg(flag: string): string | null {
  const idx = process.argv.indexOf(flag);
  if (idx < 0) return null;
  const value = process.argv[idx + 1];
  return value && !value.startsWith("--") ? value : null;
}

function runStage(label: string, script: string, args: string[]): void {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  ${label}`);
  console.log(`${"=".repeat(60)}\n`);

  const tsxPath = process.platform === "win32" ? "npx.cmd" : "npx";
  execFileSync(tsxPath, ["tsx", script, ...args], {
    stdio: "inherit",
    cwd: process.cwd(),
    env: process.env,
  });
}

async function main(): Promise<void> {
  const startStage = Number(getArg("--stage") ?? "1");
  const runDir = getArg("--run-dir");
  const concurrencyOverride = getArg("--concurrency");

  const runTag = toRunTag(new Date());
  const outputDir = runDir
    ? path.resolve(process.cwd(), runDir)
    : path.resolve(process.cwd(), "outputs", "history", runTag);

  await mkdir(outputDir, { recursive: true });

  const scrapeOutput = path.join(outputDir, "results_scrape.json");
  const jobsCsv = path.join(outputDir, "results_jobs_api.csv");
  const enrichedCsv = path.join(outputDir, "results_enriched_api_gpt.csv");

  console.log(`[RUN] Pipeline run: ${runTag}`);
  console.log(`[RUN] Output dir:   ${outputDir}`);
  console.log(`[RUN] Start stage:  ${startStage}`);

  if (startStage <= 1) {
    const args = ["--output", scrapeOutput];
    if (concurrencyOverride) {
      process.env.SCRAPER_CONCURRENCY = concurrencyOverride;
    }
    runStage("STAGE 1: Scrape Career Pages", "pipeline/stage1_scrapeCareers.ts", args);
  }

  if (startStage <= 2) {
    const args = [
      "--input", scrapeOutput,
      "--csvOutput", jobsCsv,
      "--latestDir", outputDir,
      "--noHistory",
    ];
    if (concurrencyOverride) args.push("--concurrency", concurrencyOverride);
    runStage("STAGE 2: Collect Job Details", "pipeline/stage2_collectJobDetails.ts", args);
  }

  if (startStage <= 3) {
    const args = [
      "--input", jobsCsv,
      "--output", enrichedCsv,
    ];
    if (concurrencyOverride) args.push("--concurrency", concurrencyOverride);
    runStage("STAGE 3: GPT Enrichment", "pipeline/stage3_enrichGpt.ts", args);
  }

  // Write manifest
  const manifest = {
    runTag,
    startedAt: new Date().toISOString(),
    outputDir,
    stages: {
      stage1: startStage <= 1 ? scrapeOutput : "skipped",
      stage2: startStage <= 2 ? jobsCsv : "skipped",
      stage3: startStage <= 3 ? enrichedCsv : "skipped",
    },
  };
  await writeFile(path.join(outputDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  console.log(`\n[RUN] Pipeline complete. Output: ${outputDir}`);
}

const directRunHref = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === directRunHref) {
  main().catch((error) => {
    console.error("[FATAL]", error);
    process.exit(1);
  });
}
