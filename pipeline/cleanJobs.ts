/**
 * Deterministic data-cleaning pipeline for JobScraping API outputs.
 * Reads primary API file + enriched reference, outputs cleaned JSON, CSV, and quality report.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ApiCreateJobRequest, EnrichedJobRecord } from "../types.js";
import {
  canonicalizeUrl,
  stepARemoveNoise,
  stepBRemoveNonCreative,
  stepCNormalizeTitle,
  stepDNormalizeDescription,
  stepENormalizeFields,
  stepFDedupe,
  type CleanContext,
} from "../utils/jobCleaner.js";

const API_FILE =
  "C:\\Users\\vyash\\Desktop\\Business\\Wana\\_Code\\JobScraping\\outputs\\api-ready\\latest\\results_jobs_api.json";
const ENRICHED_FILE =
  "C:\\Users\\vyash\\Desktop\\Business\\Wana\\_Code\\JobScraping\\outputs\\api-ready\\latest\\results_jobs_enriched.json";
const OUTPUT_DIR =
  "C:\\Users\\vyash\\Desktop\\Business\\Wana\\_Code\\JobScraping\\outputs\\api-ready\\latest";

const OUTPUT_JSON = path.join(OUTPUT_DIR, "results_jobs_api.cleaned.json");
const OUTPUT_CSV = path.join(OUTPUT_DIR, "results_jobs_api.cleaned.csv");
const OUTPUT_REPORT = path.join(OUTPUT_DIR, "results_jobs_quality_report.cleaned.json");

function escapeCsv(value: string): string {
  const s = String(value ?? "");
  if (s.includes('"') || s.includes("\n") || s.includes(",")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function jobToCsvRow(job: ApiCreateJobRequest): string {
  const loc = job.location;
  const sal = job.salary;
  const company = job.company;
  const parts = [
    escapeCsv(job.title ?? ""),
    escapeCsv(job.description ?? ""),
    job.jobType ?? "FULLTIME",
    job.deadline ?? "",
    (job.keywords ?? []).join("|"),
    (job.skills ?? []).join("|"),
    job.jobLink ?? "",
    (job.hiringTeam ?? []).join("|"),
    job.workType ?? "",
    job.workEmail ?? "",
    job.numberOfPositions ?? "",
    company?.name ?? "",
    company?.website ?? "",
    company?.logo ?? "",
    company?.email ?? "",
    loc?.name ?? "",
    loc?.formattedAddress ?? "",
    loc?.city ?? "",
    loc?.state ?? "",
    loc?.country ?? "",
    loc?.latitude ?? "",
    loc?.longitude ?? "",
    sal?.min ?? "",
    sal?.max ?? "",
    sal?.currency ?? "",
    sal?.period ?? "",
  ];
  return parts.join(",");
}

const CSV_HEADER =
  "title,description,jobType,deadline,keywords,skills,jobLink,hiringTeam,workType,workEmail,numberOfPositions,company,companyWebsite,companyLogo,companyEmail,locationName,formattedAddress,city,state,country,latitude,longitude,salaryMin,salaryMax,salaryCurrency,salaryPeriod";

async function loadInputs(): Promise<{
  jobs: ApiCreateJobRequest[];
  creativeScoreByLink: Map<string, number>;
}> {
  const [apiBuf, enrichedBuf] = await Promise.all([
    readFile(API_FILE, "utf-8"),
    readFile(ENRICHED_FILE, "utf-8"),
  ]);

  const jobs: ApiCreateJobRequest[] = JSON.parse(apiBuf);
  const enriched: EnrichedJobRecord[] = JSON.parse(enrichedBuf);

  const creativeScoreByLink = new Map<string, number>();
  for (const rec of enriched) {
    const link = rec.apiJob?.jobLink ?? "";
    if (link && rec.creativeScore !== undefined) {
      creativeScoreByLink.set(canonicalizeUrl(link).toLowerCase(), rec.creativeScore);
    }
  }

  return { jobs, creativeScoreByLink };
}

function runPipeline(
  jobs: ApiCreateJobRequest[],
  creativeScoreByLink: Map<string, number>,
  ctx: CleanContext
): ApiCreateJobRequest[] {
  let current: ApiCreateJobRequest[] = jobs;

  // Step A: Remove noise
  current = current.filter((j) => !stepARemoveNoise(j, ctx));

  // Step B: Remove high-confidence non-creative
  current = current.filter((j) => {
    const link = canonicalizeUrl(j.jobLink ?? "").toLowerCase();
    const score = creativeScoreByLink.get(link);
    return !stepBRemoveNonCreative(j, ctx, score);
  });

  // Step C, D, E: Normalize
  current = current.map((j) => {
    const title = stepCNormalizeTitle(j, ctx);
    const canonicalLink = canonicalizeUrl(j.jobLink ?? "");
    const effectiveLink = canonicalLink || (j.jobLink ?? "");
    const description = stepDNormalizeDescription(
      { ...j, title, description: j.description },
      ctx,
      effectiveLink
    );
    return stepENormalizeFields(
      {
        ...j,
        title,
        description,
        jobLink: effectiveLink,
      },
      effectiveLink
    );
  });

  // Ensure required fields - drop if missing
  current = current.filter((j) => {
    const ok =
      (j.title ?? "").trim() !== "" &&
      (j.description ?? "").trim() !== "" &&
      (j.jobLink ?? "").trim() !== "" &&
      (j.company?.name ?? "").trim() !== "";
    return ok;
  });

  // Step F: Dedupe
  current = stepFDedupe(current, ctx);

  return current;
}

export interface CleanedQualityReport {
  total_input: number;
  total_output: number;
  removed_noise_count: number;
  removed_noncreative_count: number;
  removed_duplicate_count: number;
  placeholder_description_count: number;
  mojibake_fixed_count: number;
  title_normalized_count: number;
  description_normalized_count: number;
  required_field_failures: number;
  reason_counts?: Record<string, number>;
  sample_removed_records: Array<{ title: string; jobLink: string; reason: string }>;
}

async function main(): Promise<void> {
  const { jobs, creativeScoreByLink } = await loadInputs();
  const ctx: CleanContext = {
    removedNoise: 0,
    removedNoncreative: 0,
    removedDuplicate: 0,
    placeholderDescription: 0,
    mojibakeFixed: 0,
    titleNormalized: 0,
    descriptionNormalized: 0,
    reasonCounts: {},
    sampleRemoved: [],
  };

  const cleaned = runPipeline(jobs, creativeScoreByLink, ctx);

  // Final checks
  const hasSkipTitle = cleaned.some(
    (j) => (j.title ?? "").toLowerCase() === "skip to main content"
  );
  const hasEmptyDesc = cleaned.some((j) => !(j.description ?? "").trim());
  if (hasSkipTitle || hasEmptyDesc) {
    throw new Error(
      `Final check failed: skipTitle=${hasSkipTitle} emptyDesc=${hasEmptyDesc}`
    );
  }

  const report: CleanedQualityReport = {
    total_input: jobs.length,
    total_output: cleaned.length,
    removed_noise_count: ctx.removedNoise,
    removed_noncreative_count: ctx.removedNoncreative,
    removed_duplicate_count: ctx.removedDuplicate,
    placeholder_description_count: ctx.placeholderDescription,
    mojibake_fixed_count: ctx.mojibakeFixed,
    title_normalized_count: ctx.titleNormalized,
    description_normalized_count: ctx.descriptionNormalized,
    required_field_failures: 0,
    reason_counts: Object.keys(ctx.reasonCounts).length ? ctx.reasonCounts : undefined,
    sample_removed_records: ctx.sampleRemoved.slice(0, 20).map((r) => ({
      title: r.title,
      jobLink: r.jobLink,
      reason: r.reason,
    })),
  };

  const csvRows = [CSV_HEADER, ...cleaned.map((j) => jobToCsvRow(j))];
  const csvContent = csvRows.join("\n");

  await writeFile(OUTPUT_JSON, JSON.stringify(cleaned, null, 2), "utf-8");
  try {
    await writeFile(OUTPUT_CSV, csvContent, "utf-8");
  } catch (err: unknown) {
    const fallbackCsv = path.join(
      OUTPUT_DIR,
      `results_jobs_api.cleaned.${Date.now()}.csv`
    );
    await writeFile(fallbackCsv, csvContent, "utf-8");
    console.warn(`CSV locked; wrote to ${fallbackCsv}`);
  }
  await writeFile(OUTPUT_REPORT, JSON.stringify(report, null, 2), "utf-8");

  console.log(`Cleaned ${jobs.length} -> ${cleaned.length} jobs`);
  console.log(`  Noise removed: ${ctx.removedNoise}`);
  console.log(`  Non-creative removed: ${ctx.removedNoncreative}`);
  console.log(`  Duplicates removed: ${ctx.removedDuplicate}`);
  console.log(`Outputs: ${OUTPUT_JSON}, ${OUTPUT_CSV}, ${OUTPUT_REPORT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
