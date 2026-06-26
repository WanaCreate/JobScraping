/**
 * scripts/scrapePendingChunked.ts
 *
 * Checkpointing wrapper around the Stage 1 scraper for the large Phase 1
 * candidate pile (pipeline/pending_review.json — ~28K boards). The plain
 * `stage1` script writes its output only once, at the very end, so a multi-hour
 * run that gets interrupted (container reclaim on inactivity) loses everything.
 *
 * This runner splits the input into chunks, scrapes each chunk with the SAME
 * runScraper() logic, and rewrites the full accumulated results to disk after
 * every chunk. On restart it skips boards already present in the output file,
 * so it resumes instead of starting over.
 *
 * Usage:
 *   node --import tsx/esm scripts/scrapePendingChunked.ts \
 *     [--input pipeline/pending_review.json] \
 *     [--output outputs/results_pending.json] \
 *     [--chunk 1500] [--concurrency 8]
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ScrapeResult } from "../types.js";
import { runScraper } from "../pipeline/stage1_scrapeCareers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function getArg(flag: string, fallback: string): string {
  const idx = process.argv.indexOf(flag);
  if (idx >= 0 && process.argv[idx + 1] && !process.argv[idx + 1].startsWith("--")) {
    return process.argv[idx + 1];
  }
  return fallback;
}

async function readJsonArray<T>(p: string): Promise<T[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(p, "utf-8"));
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

async function main(): Promise<void> {
  const input = path.resolve(ROOT, getArg("--input", "pipeline/pending_review.json"));
  const output = path.resolve(ROOT, getArg("--output", "outputs/results_pending.json"));
  const chunkSize = Math.max(1, Number(getArg("--chunk", "1500")) || 1500);
  const concurrency = Math.max(1, Number(getArg("--concurrency", "8")) || 8);

  if (!existsSync(input)) {
    console.error(`[chunked] Input not found: ${input}`);
    process.exit(1);
  }

  const allUrls = await readJsonArray<string>(input);
  console.log(`[chunked] Loaded ${allUrls.length} candidate URLs from ${path.relative(ROOT, input)}`);

  // Resume: load any already-scraped results and skip those sources.
  const existing = await readJsonArray<ScrapeResult>(output);
  const done = new Set(existing.map((r) => r.source));
  const accumulated: ScrapeResult[] = [...existing];
  if (done.size > 0) {
    console.log(`[chunked] Resuming — ${done.size} boards already scraped in ${path.relative(ROOT, output)}`);
  }

  const todo = allUrls.filter((u) => !done.has(u));
  console.log(`[chunked] ${todo.length} boards remaining · chunk=${chunkSize} · concurrency=${concurrency}`);

  await mkdir(path.dirname(output), { recursive: true });

  const totalChunks = Math.ceil(todo.length / chunkSize);
  for (let i = 0; i < todo.length; i += chunkSize) {
    const chunk = todo.slice(i, i + chunkSize);
    const chunkNo = Math.floor(i / chunkSize) + 1;
    console.log(`\n[chunked] === Chunk ${chunkNo}/${totalChunks} (${chunk.length} boards) ===`);

    const results = await runScraper(chunk, concurrency);
    accumulated.push(...results);

    // Checkpoint: rewrite the full accumulated array after every chunk.
    await writeFile(output, JSON.stringify(accumulated, null, 2), "utf8");
    const withJobs = accumulated.filter((r) => (r.jobs_count ?? 0) > 0).length;
    console.log(
      `[chunked] Checkpoint: ${accumulated.length} boards saved → ${path.relative(ROOT, output)} ` +
        `(${withJobs} with jobs)`
    );
  }

  console.log(`\n[chunked] Done. ${accumulated.length} boards scraped → ${path.relative(ROOT, output)}`);
}

main().catch((err) => {
  console.error("[chunked] Fatal:", err);
  process.exit(1);
});
