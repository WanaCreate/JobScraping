import { scrapeCareers } from "./scrapeCareers.js";
import type { ScrapeResult } from "../types.js";
import { logInfo } from "../utils/logger.js";
import { pathToFileURL } from "node:url";
import { writeFile } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import path from "node:path";

const INPUT_URLS = [
  "https://www.foxcareers.com/",
  "https://www.brooklinen.com/pages/careers",
  "https://www.accenture.com/us-en/careers",
  "https://amazon.jobs/en/",
  "https://www.adobe.com/careers.html",
  "https://careers.roblox.com/"
];

function parseInputUrls(): string[] {
  const cliUrls = process.argv.slice(2).filter((arg) => /^https?:\/\//i.test(arg));
  if (cliUrls.length > 0) return cliUrls;

  const jsonEnv = process.env.SCRAPER_URLS_JSON;
  if (jsonEnv) {
    try {
      const parsed = JSON.parse(jsonEnv);
      if (Array.isArray(parsed)) {
        return parsed.filter((value) => typeof value === "string" && /^https?:\/\//i.test(value));
      }
    } catch {
      return INPUT_URLS;
    }
  }

  return INPUT_URLS;
}

async function parseInputUrlsAsync(): Promise<string[]> {
  const directUrls = parseInputUrls();
  if (directUrls.length !== INPUT_URLS.length || directUrls.some((url, index) => url !== INPUT_URLS[index])) {
    return directUrls;
  }

  const fileFromEnv = process.env.SCRAPER_URLS_FILE;
  const defaultFile = "pipeline/company_career_urls.json";
  const filePath = fileFromEnv?.trim() || defaultFile;

  try {
    const raw = await readFile(path.resolve(process.cwd(), filePath), "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const urls = parsed.filter((value) => typeof value === "string" && /^https?:\/\//i.test(value));
      if (urls.length > 0) return urls;
    }
  } catch {
    return directUrls;
  }

  return directUrls;
}

function parseOutputPath(): string | null {
  const args = process.argv.slice(2);
  const outputFlagIndex = args.findIndex((arg) => arg === "--output");
  if (outputFlagIndex >= 0 && args[outputFlagIndex + 1]) {
    return args[outputFlagIndex + 1];
  }

  const outputEnv = process.env.SCRAPER_OUTPUT_FILE;
  if (outputEnv && outputEnv.trim()) return outputEnv.trim();

  return null;
}

async function runWithConcurrency<TInput, TOutput>(
  items: TInput[],
  concurrency: number,
  worker: (item: TInput) => Promise<TOutput>
): Promise<TOutput[]> {
  const results: TOutput[] = new Array(items.length);
  let index = 0;

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const current = index;
      index += 1;
      if (current >= items.length) break;
      results[current] = await worker(items[current]);
    }
  });

  await Promise.all(workers);
  return results;
}

export async function runScraper(urls: string[], concurrency = 20): Promise<ScrapeResult[]> {
  logInfo("Starting batch scrape", { companies: urls.length, concurrency });
  const results = await runWithConcurrency(urls, concurrency, scrapeCareers);
  logInfo("Batch scrape completed", { companies: urls.length });
  return results;
}

async function main(): Promise<void> {
  const urls = await parseInputUrlsAsync();
  const concurrency = Number(process.env.SCRAPER_CONCURRENCY ?? "8");
  const safeConcurrency = Number.isFinite(concurrency) && concurrency > 0 ? concurrency : 8;
  const results = await runScraper(urls, safeConcurrency);
  const outputJson = JSON.stringify(results, null, 2);
  const outputPath = parseOutputPath();

  if (outputPath) {
    const resolvedPath = path.resolve(process.cwd(), outputPath);
    await writeFile(resolvedPath, outputJson, "utf8");
    logInfo("Wrote JSON output", { outputPath: resolvedPath });
    return;
  }

  console.log(outputJson);
}

const directRunHref = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === directRunHref) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
