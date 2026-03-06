/**
 * Ollama-based job enrichment pipeline.
 *
 * Reads the already-enriched CSV (results_enriched_api.csv), sends each row
 * through a local Ollama Qwen 3.5 model to validate/fix:
 *   a) title        – fix generic/nonsensical titles
 *   b) description  – strip noise, keep only job-relevant info, format into clean HTML
 *   c) jobType      – validate against allowed values, default FULLTIME
 *   d) workType     – validate against allowed values, fix or clear
 *   e) location     – validate, fix or clear
 *   f) job_url      – read-only context
 *
 * Drop a row ONLY when both the title AND job_url are irrelevant to a real job posting.
 *
 * Usage:
 *   npx tsx pipeline/enrichFromCsvOllama.ts [options]
 *
 * Options:
 *   --input <path>         CSV input (default: outputs/api-ready/latest/results_enriched_api.csv)
 *   --concurrency <n>      Parallel Ollama calls (default: 2)
 *   --maxJobs <n>          Process at most N jobs
 *   --ollamaUrl <url>      Ollama API base (default: http://localhost:11434)
 *   --model <name>         Ollama model name (default: qwen3.5)
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

// ─── Types (inline to keep standalone) ───────────────────────────

type JobTypeValue = "GIG" | "FULLTIME" | "PARTTIME" | "FREELANCE";
type WorkTypeValue = "ONSITE" | "HYBRID" | "REMOTE";

interface CsvJobRow {
  title: string;
  description: string;
  jobType: string;
  deadline: string;
  keywords: string;
  skills: string;
  jobLink: string;
  hiringTeam: string;
  workType: string;
  workEmail: string;
  allowEmailApplications: string;
  numberOfPositions: string;
  company: string;
  companyWebsite: string;
  companyLogo: string;
  companyEmail: string;
  locationName: string;
  formattedAddress: string;
  city: string;
  state: string;
  country: string;
  latitude: string;
  longitude: string;
  salaryMin: string;
  salaryMax: string;
  salaryCurrency: string;
  salaryPeriod: string;
}

// ─── CLI ─────────────────────────────────────────────────────────

interface CliOptions {
  input: string;
  concurrency: number;
  maxJobs: number | null;
  ollamaUrl: string;
  model: string;
}

function getArg(flag: string): string | null {
  const idx = process.argv.indexOf(flag);
  if (idx < 0) return null;
  const value = process.argv[idx + 1];
  return value && !value.startsWith("--") ? value : null;
}

function parseCliOptions(): CliOptions {
  return {
    input: getArg("--input") ?? "outputs/api-ready/latest/results_enriched_api.csv",
    concurrency: Number(getArg("--concurrency") ?? "2"),
    maxJobs: getArg("--maxJobs") ? Number(getArg("--maxJobs")) : null,
    ollamaUrl: getArg("--ollamaUrl") ?? "http://localhost:11434",
    model: getArg("--model") ?? "qwen3.5",
  };
}

// ─── CSV Parsing (handles quoted fields with commas/newlines) ────

const CSV_HEADERS: (keyof CsvJobRow)[] = [
  "title", "description", "jobType", "deadline", "keywords", "skills",
  "jobLink", "hiringTeam", "workType", "workEmail", "allowEmailApplications",
  "numberOfPositions", "company", "companyWebsite", "companyLogo", "companyEmail",
  "locationName", "formattedAddress", "city", "state", "country",
  "latitude", "longitude", "salaryMin", "salaryMax", "salaryCurrency", "salaryPeriod",
];

function parseCsvContent(content: string): CsvJobRow[] {
  const rows: CsvJobRow[] = [];
  const fields = parseCsvFields(content);

  // fields is a flat array; chunk by header count, skip first row (headers)
  const colCount = CSV_HEADERS.length;
  // Find actual header row end
  const headerEnd = colCount;

  for (let i = headerEnd; i + colCount <= fields.length; i += colCount) {
    const row: Record<string, string> = {};
    for (let c = 0; c < colCount; c++) {
      row[CSV_HEADERS[c]] = (fields[i + c] ?? "").trim();
    }
    rows.push(row as unknown as CsvJobRow);
  }

  return rows;
}

function parseCsvFields(content: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  let i = 0;

  while (i < content.length) {
    const char = content[i];

    if (inQuotes) {
      if (char === '"') {
        if (i + 1 < content.length && content[i + 1] === '"') {
          current += '"';
          i += 2;
        } else {
          inQuotes = false;
          i++;
        }
      } else {
        current += char;
        i++;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
        i++;
      } else if (char === ",") {
        fields.push(current);
        current = "";
        i++;
      } else if (char === "\n" || (char === "\r" && content[i + 1] === "\n")) {
        fields.push(current);
        current = "";
        if (char === "\r") i += 2;
        else i++;
      } else if (char === "\r") {
        fields.push(current);
        current = "";
        i++;
      } else {
        current += char;
        i++;
      }
    }
  }

  if (current || fields.length > 0) {
    fields.push(current);
  }

  return fields;
}

// ─── CSV Output ──────────────────────────────────────────────────

function csvEscape(value: string): string {
  if (value.includes(",") || value.includes("\n") || value.includes('"')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function rowToCsv(row: CsvJobRow): string {
  return CSV_HEADERS.map(h => csvEscape(row[h] ?? "")).join(",");
}

function allRowsToCsv(rows: CsvJobRow[]): string {
  const header = CSV_HEADERS.join(",");
  const dataRows = rows.map(r => rowToCsv(r));
  return [header, ...dataRows].join("\n");
}

// ─── Ollama API ──────────────────────────────────────────────────

interface OllamaMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface OllamaChatResponse {
  message?: { content?: string };
}

async function ollamaChat(
  baseUrl: string,
  model: string,
  messages: OllamaMessage[],
  timeoutMs = 120_000,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages, stream: false }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Ollama HTTP ${res.status}: ${text.slice(0, 200)}`);
    }

    const data = (await res.json()) as OllamaChatResponse;
    return data.message?.content ?? "";
  } finally {
    clearTimeout(timer);
  }
}

// ─── Validation helpers ──────────────────────────────────────────

const VALID_JOB_TYPES = new Set<string>(["GIG", "FULLTIME", "PARTTIME", "FREELANCE"]);
const VALID_WORK_TYPES = new Set<string>(["ONSITE", "HYBRID", "REMOTE"]);

const JOB_TYPE_MAP: Record<string, JobTypeValue> = {
  INTERNSHIP: "GIG", FIXEDTERM: "GIG", CONTRACT: "GIG", TEMPORARY: "GIG",
  "FULL-TIME": "FULLTIME", "FULL_TIME": "FULLTIME", "FULL TIME": "FULLTIME",
  "PART-TIME": "PARTTIME", "PART_TIME": "PARTTIME", "PART TIME": "PARTTIME",
  FREELANCER: "FREELANCE",
};

function normalizeJobType(raw: string): JobTypeValue {
  const upper = raw.trim().toUpperCase();
  if (VALID_JOB_TYPES.has(upper)) return upper as JobTypeValue;
  return JOB_TYPE_MAP[upper] ?? "FULLTIME";
}

function normalizeWorkType(raw: string): WorkTypeValue | "" {
  const upper = raw.trim().toUpperCase();
  if (VALID_WORK_TYPES.has(upper)) return upper as WorkTypeValue;
  if (/REMOTE|WORK\s*FROM\s*HOME|TELECOMMUTE/i.test(raw)) return "REMOTE";
  if (/HYBRID/i.test(raw)) return "HYBRID";
  if (/ON\s*-?\s*SITE|ONSITE|IN\s*OFFICE/i.test(raw)) return "ONSITE";
  return "";
}

// ─── AI enrichment prompt ────────────────────────────────────────

function buildEnrichmentPrompt(row: CsvJobRow): OllamaMessage[] {
  const systemPrompt = `You are a job listing data quality assistant. You will receive a job listing with its details. Your task is to review and fix the data fields.

RULES:
1. TITLE: If the title is a real job title, keep it. If it's a generic careers page heading (e.g. "Asana Careers", "Jobs at Company"), a cookie notice, 404 page, or otherwise not a real job title, try to infer the correct title from the description or URL. If you cannot determine a real title, set it to "INVALID".

2. DESCRIPTION: This is critical. You must:
   - Remove ALL noise: cookie banners, login prompts, navigation text, "apply now" buttons, social share links, company boilerplate unrelated to the job, benefits/perks sections that are generic company-wide, legal disclaimers, EEO statements, privacy notices, "submit application" forms, salary/compensation sections (salary data is stored separately).
   - Keep ONLY: job responsibilities, qualifications/requirements, "about the role" sections, required skills, what the candidate will do, team description relevant to the role.
   - Format the cleaned content as well-structured HTML using ONLY these tags: <h2>, <h3>, <p>, <ul>, <ol>, <li>, <strong>, <em>, <br>
   - If the description is one big paragraph, break it into logical sections with headings like <h2>About the Role</h2>, <h2>Responsibilities</h2>, <h2>Requirements</h2> etc.
   - The output description must be compact single-line HTML (no newlines within the HTML string).
   - If the description is too short or is just a placeholder like "For job details, click apply", keep it as-is.

3. JOBTYPE: Must be exactly one of: GIG, FULLTIME, PARTTIME, FREELANCE. If the current value is invalid or doesn't match the description, fix it. Default: FULLTIME.

4. WORKTYPE: Must be exactly one of: ONSITE, HYBRID, REMOTE, or empty. Infer from the description/title/location if not set or incorrect. If the description says "remote" but workType is "ONSITE", fix it.

5. LOCATION fields (locationName, formattedAddress, city, state, country): Validate they make sense. If location says "Remote" as a city, clear the location fields (workType should be REMOTE instead). Fix obvious errors. If location data seems fabricated or nonsensical, clear it.

6. DROP DECISION: Set "shouldDrop" to true ONLY if BOTH the title is not a real job title (and can't be fixed) AND the jobLink URL doesn't point to a real job posting (e.g., it's a careers listing page, homepage, or error page).

Respond with ONLY a valid JSON object (no markdown fences, no explanation) with these fields:
{
  "shouldDrop": false,
  "title": "...",
  "description": "...",
  "jobType": "FULLTIME",
  "workType": "REMOTE",
  "locationName": "...",
  "formattedAddress": "...",
  "city": "...",
  "state": "...",
  "country": ""
}`;

  const userPrompt = `Review this job listing:

TITLE: ${row.title}
JOB URL: ${row.jobLink}
CURRENT JOB TYPE: ${row.jobType}
CURRENT WORK TYPE: ${row.workType}
LOCATION: ${row.locationName} | ${row.formattedAddress} | ${row.city}, ${row.state}, ${row.country}
COMPANY: ${row.company}

DESCRIPTION (may contain HTML):
${row.description.slice(0, 6000)}`;

  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];
}

// ─── Parse AI response ───────────────────────────────────────────

interface AiEnrichResult {
  shouldDrop: boolean;
  title: string;
  description: string;
  jobType: string;
  workType: string;
  locationName: string;
  formattedAddress: string;
  city: string;
  state: string;
  country: string;
}

function parseAiResponse(raw: string): AiEnrichResult | null {
  // Strip markdown fences if present
  let cleaned = raw.trim();

  // Remove thinking tags if model outputs them
  cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/g, "").trim();

  // Remove markdown code fences
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

  // Try to find JSON object in the response
  const jsonStart = cleaned.indexOf("{");
  const jsonEnd = cleaned.lastIndexOf("}");
  if (jsonStart === -1 || jsonEnd === -1) return null;
  cleaned = cleaned.slice(jsonStart, jsonEnd + 1);

  try {
    const parsed = JSON.parse(cleaned);
    return {
      shouldDrop: Boolean(parsed.shouldDrop),
      title: String(parsed.title ?? ""),
      description: String(parsed.description ?? ""),
      jobType: String(parsed.jobType ?? "FULLTIME"),
      workType: String(parsed.workType ?? ""),
      locationName: String(parsed.locationName ?? ""),
      formattedAddress: String(parsed.formattedAddress ?? ""),
      city: String(parsed.city ?? ""),
      state: String(parsed.state ?? ""),
      country: String(parsed.country ?? ""),
    };
  } catch {
    return null;
  }
}

// ─── Apply AI result to row ──────────────────────────────────────

function applyEnrichment(row: CsvJobRow, ai: AiEnrichResult): CsvJobRow {
  const updated = { ...row };

  // Title
  if (ai.title && ai.title !== "INVALID") {
    updated.title = ai.title;
  }

  // Description — only update if AI returned meaningful content
  if (ai.description && ai.description.length > 30) {
    // Normalize to single-line HTML for CSV
    updated.description = ai.description
      .replace(/\r\n?/g, " ")
      .replace(/>\s+</g, "><")
      .replace(/\s{2,}/g, " ")
      .trim();
  }

  // JobType
  updated.jobType = normalizeJobType(ai.jobType || row.jobType);

  // WorkType
  const aiWorkType = normalizeWorkType(ai.workType);
  if (aiWorkType) {
    updated.workType = aiWorkType;
  } else {
    // Keep original if AI didn't provide one, but validate it
    updated.workType = normalizeWorkType(row.workType);
  }

  // Location
  updated.locationName = ai.locationName ?? row.locationName;
  updated.formattedAddress = ai.formattedAddress ?? row.formattedAddress;
  updated.city = ai.city ?? row.city;
  updated.state = ai.state ?? row.state;
  updated.country = ai.country ?? row.country;

  // If location is "Remote", clear location fields and ensure workType is REMOTE
  if (/^remote$/i.test(updated.city)) {
    updated.city = "";
    updated.locationName = "";
    updated.formattedAddress = "";
    updated.state = "";
    updated.country = "";
    updated.workType = "REMOTE";
  }

  return updated;
}

// ─── Concurrency helper ──────────────────────────────────────────

async function runConcurrent<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) break;
      results[i] = await worker(items[i], i);
    }
  });

  await Promise.all(workers);
  return results;
}

// ─── Main ────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const options = parseCliOptions();
  const inputPath = path.resolve(process.cwd(), options.input);
  const outputPath = path.resolve(
    process.cwd(),
    "outputs/api-ready/latest/results_enriched_api_ollama.csv",
  );

  console.log(`[INFO] Reading CSV: ${inputPath}`);
  const csvContent = await readFile(inputPath, "utf8");
  let rows = parseCsvContent(csvContent);
  console.log(`[INFO] Parsed ${rows.length} jobs from CSV`);

  if (options.maxJobs) {
    rows = rows.slice(0, options.maxJobs);
    console.log(`[INFO] Limited to ${rows.length} jobs (--maxJobs)`);
  }

  // Verify Ollama is reachable
  try {
    const res = await fetch(`${options.ollamaUrl}/api/tags`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    console.log(`[INFO] Ollama connected at ${options.ollamaUrl}, model: ${options.model}`);
  } catch (err) {
    console.error(`[ERROR] Cannot reach Ollama at ${options.ollamaUrl}. Is it running?`);
    process.exit(1);
  }

  const enrichedRows: CsvJobRow[] = [];
  let processed = 0;
  let dropped = 0;
  let aiFixed = 0;
  let aiFailed = 0;

  await runConcurrent(rows, options.concurrency, async (row, index) => {
    try {
      const messages = buildEnrichmentPrompt(row);
      const rawResponse = await ollamaChat(options.ollamaUrl, options.model, messages, 180_000);
      const aiResult = parseAiResponse(rawResponse);

      if (!aiResult) {
        // AI didn't return valid JSON — keep row as-is with basic validation
        console.log(`[WARN] Row ${index + 1} (${row.title.slice(0, 40)}): AI parse failed, keeping original`);
        aiFailed++;
        row.jobType = normalizeJobType(row.jobType);
        row.workType = normalizeWorkType(row.workType);
        enrichedRows.push(row);
        return;
      }

      if (aiResult.shouldDrop) {
        console.log(`[DROP] Row ${index + 1}: "${row.title.slice(0, 50)}" | ${row.jobLink.slice(0, 60)}`);
        dropped++;
        return;
      }

      const updated = applyEnrichment(row, aiResult);
      enrichedRows.push(updated);
      aiFixed++;
    } catch (err) {
      console.log(`[WARN] Row ${index + 1} (${row.title.slice(0, 40)}): Error - ${err instanceof Error ? err.message : err}`);
      aiFailed++;
      // Keep row with basic validation
      row.jobType = normalizeJobType(row.jobType);
      row.workType = normalizeWorkType(row.workType);
      enrichedRows.push(row);
    }

    processed = aiFixed + aiFailed;
    if (processed % 10 === 0) {
      console.log(`[INFO] Progress: ${processed + dropped}/${rows.length} (${aiFixed} enriched, ${dropped} dropped, ${aiFailed} fallback)`);
    }
  });

  console.log(`\n[INFO] Enrichment complete:`);
  console.log(`  Total input:  ${rows.length}`);
  console.log(`  Enriched:     ${aiFixed}`);
  console.log(`  AI failed:    ${aiFailed} (kept with basic validation)`);
  console.log(`  Dropped:      ${dropped}`);
  console.log(`  Final output: ${enrichedRows.length}`);

  // Write output
  const outputDir = path.dirname(outputPath);
  await mkdir(outputDir, { recursive: true });
  await writeFile(outputPath, allRowsToCsv(enrichedRows), "utf8");
  console.log(`[INFO] Written to: ${outputPath}`);
}

const directRunHref = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === directRunHref) {
  main().catch((error) => {
    console.error("[FATAL]", error);
    process.exit(1);
  });
}
