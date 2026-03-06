/**
 * Ollama-based job enrichment pipeline.
 *
 * Reads an enriched CSV, fetches each job page via browser (Playwright), and sends
 * the live page content to a local Ollama model for extraction and validation.
 * Outputs jobs.csv in the exact format expected by api-server's POST /api/v1/jobs/upload.
 *
 * For each row:
 *   1. Fetches the job URL in a browser (handles JS-rendered ATS pages)
 *   2. Extracts page content and sends to Ollama
 *   3. Ollama extracts/validates: title, description, jobType, workType, location, salary
 *
 * Use --skipFetch to skip browser fetching (uses existing row data only).
 *
 * Usage:
 *   npx tsx pipeline/enrichFromCsvOllama.ts [options]
 *
 * Options:
 *   --input <path>         CSV input (default: outputs/api-ready/latest/results_enriched_api.csv)
 *   --output <path>        CSV output (default: outputs/api-ready/latest/jobs.csv)
 *   --concurrency <n>      Parallel workers (default: 1, use 2+ only if Ollama has enough VRAM)
 *   --maxJobs <n>          Process at most N jobs
 *   --skipFetch            Skip browser fetch; use existing row data only
 *   --ollamaUrl <url>      Ollama API base (default: http://localhost:8000)
 *   --model <name>         Ollama model name (default: qwen3.5:35b-a3b)
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { load } from "cheerio";
import { fetchJobPage, closeBrowser } from "../utils/pageFetcher.js";

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
  output: string;
  concurrency: number;
  maxJobs: number | null;
  skipFetch: boolean;
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
    output: getArg("--output") ?? "outputs/api-ready/latest/jobs.csv",
    concurrency: Number(getArg("--concurrency") ?? "1"),
    maxJobs: getArg("--maxJobs") ? Number(getArg("--maxJobs")) : null,
    skipFetch: process.argv.includes("--skipFetch"),
    ollamaUrl: getArg("--ollamaUrl") ?? "http://localhost:8000",
    model: getArg("--model") ?? "qwen3.5:latest",
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
  const fields = parseCsvFields(content);
  const colCount = CSV_HEADERS.length;
  if (fields.length < colCount) return [];

  const rows: CsvJobRow[] = [];
  for (let i = colCount; i + colCount <= fields.length; i += colCount) {
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

// ─── CSV Output (api-server bulk upload schema) ────────────────────
// Schema matches POST /api/v1/jobs/upload expectations exactly.
// See api-server JobService.uploadJobsFromCSV and parseLocationField.

const API_OUTPUT_HEADERS = [
  "title", "description", "deadline", "keywords", "skills",
  "jobType", "workType", "jobLink", "hiringTeam", "workEmail",
  "numberOfPositions", "allowEmailApplications", "screeningQuestions",
  "company", "companyWebsite", "companyLogo", "companyEmail",
  "location", "minSalary", "maxSalary", "currency", "salaryPeriod",
] as const;

function csvEscape(value: string): string {
  if (value.includes(",") || value.includes("\n") || value.includes('"')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** Build location as JSON string for api-server parseLocationField. */
function buildLocationColumn(row: CsvJobRow): string {
  const name = [row.locationName, row.formattedAddress].filter(Boolean).join(" — ") || [row.city, row.state, row.country].filter(Boolean).join(", ");
  const lat = parseFloat(row.latitude);
  const lng = parseFloat(row.longitude);
  const loc = {
    name: name || [row.city, row.state].filter(Boolean).join(", "),
    formattedAddress: row.formattedAddress || [row.city, row.state, row.country].filter(Boolean).join(", "),
    latitude: Number.isFinite(lat) ? lat : 0,
    longitude: Number.isFinite(lng) ? lng : 0,
    city: row.city,
    state: row.state,
    country: row.country,
  };
  return JSON.stringify(loc);
}

function rowToApiCsv(row: CsvJobRow): string {
  const location = buildLocationColumn(row);
  const allow = /^(true|1)$/i.test(row.allowEmailApplications ?? "");
  const values = [
    row.title, row.description, row.deadline, row.keywords, row.skills,
    row.jobType, row.workType, row.jobLink, row.hiringTeam, row.workEmail,
    row.numberOfPositions, allow ? "true" : "false", "",
    row.company, row.companyWebsite, row.companyLogo, row.companyEmail,
    location,
    row.salaryMin || "", row.salaryMax || "",
    row.salaryCurrency || "USD", row.salaryPeriod || "",
  ];
  return values.map(v => csvEscape(String(v ?? ""))).join(",");
}

function allRowsToApiCsv(rows: CsvJobRow[]): string {
  const header = API_OUTPUT_HEADERS.join(",");
  const dataRows = rows.map(rowToApiCsv);
  return [header, ...dataRows].join("\n");
}

// ─── Page fetch & extraction ──────────────────────────────────────

const PAGE_CONTENT_MAX_CHARS = 6_000;

/** Extract readable text from job page HTML for Ollama. */
function extractPageText(html: string): string {
  const $ = load(html);
  $("script, style, noscript, nav, header, footer, [role='navigation']").remove();
  const body = $("body");
  if (body.length === 0) return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, PAGE_CONTENT_MAX_CHARS);

  const text = body
    .text()
    .replace(/\s+/g, " ")
    .replace(/\s*\.\s*/g, ". ")
    .trim();
  return text.slice(0, PAGE_CONTENT_MAX_CHARS);
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

function buildEnrichmentPrompt(row: CsvJobRow, pageContent?: string): OllamaMessage[] {
  const systemPrompt = `You are a precise job data extractor. Your output will be used directly in a database. You MUST return 100% accurate, deterministic data.

CRITICAL: Output ONLY the JSON object. No markdown fences, no explanation, no preamble. Start with { and end with }. Every field must be present.

CONFIDENCE RULE: Include ONLY data you can directly confirm from the source. If unsure, use empty string "". Never guess, infer, or hallucinate.

FIELD RULES (follow exactly):

1. TITLE
   - Extract the exact job title as written (e.g. "Senior Product Designer", "Software Engineer").
   - If the page shows only a generic label ("Careers", "Jobs", "Search Results"), set "INVALID".
   - Must be a real role name. Do not use company names, page titles, or navigation text as title.

2. DESCRIPTION
   - Extract ONLY: responsibilities, requirements, qualifications, "about the role".
   - REMOVE: cookie banners, nav menus, "apply now" buttons, EEO/disclaimer text, social links, login prompts.
   - Format as single-line HTML using ONLY: <h2>, <h3>, <p>, <ul>, <ol>, <li>, <strong>, <em>, <br>.
   - If content is too short or placeholder (< 100 chars), keep it as-is.
   - Must be at least 30 characters. No empty descriptions.

3. JOBTYPE (exactly one)
   - FULLTIME: full-time, full time, permanent, employee
   - PARTTIME: part-time, part time
   - FREELANCE: freelance, contractor (independent)
   - GIG: internship, contract, temporary, fixed-term
   - Default when unknown: "FULLTIME"

4. WORKTYPE (exactly one or "")
   - REMOTE: remote, work from home, telecommute, distributed
   - HYBRID: hybrid, flexible
   - ONSITE: onsite, on-site, in-office
   - Empty "" when not stated

5. LOCATION
   - Extract city, state, country only if explicitly stated.
   - If "Remote" appears as location, use empty strings for city/state/country and workType "REMOTE".
   - formattedAddress: full address string if present, else "".
   - Use "" for any field not found. No invented addresses.

6. SALARY
   - salaryMin, salaryMax: numeric values only (e.g. "80000"), or "" if not stated.
   - salaryCurrency: "USD" if US dollars, else the stated currency code. Default "USD".
   - salaryPeriod: HOURLY | DAILY | WEEKLY | MONTHLY | ANNUAL | ONE_TIME, or "".
   - If no salary mentioned: salaryMin="", salaryMax="", salaryPeriod="".

7. shouldDrop
   - true ONLY when BOTH: (a) no real job title exists AND (b) page is not a job posting (careers index, 404, homepage, category page).
   - false for any actual job listing.

OUTPUT FORMAT (copy this structure exactly):
{"shouldDrop":false,"title":"","description":"","jobType":"FULLTIME","workType":"","locationName":"","formattedAddress":"","city":"","state":"","country":"","salaryMin":"","salaryMax":"","salaryCurrency":"USD","salaryPeriod":""}`;

  const hasLivePage = pageContent && pageContent.length > 200;
  const contextBlock = hasLivePage
    ? `SOURCE: Live page content fetched from job URL.\n\n${pageContent}`
    : `SOURCE: Existing row data (page not fetched).\n\nTITLE: ${row.title}\nJOB URL: ${row.jobLink}\nJOB TYPE: ${row.jobType}\nWORK TYPE: ${row.workType}\nLOCATION: ${row.locationName} | ${row.formattedAddress} | ${row.city}, ${row.state}, ${row.country}\nCOMPANY: ${row.company}\nDESCRIPTION:\n${row.description.slice(0, 6000)}`;

  const userPrompt = `Extract job data from the source below. Output ONLY valid JSON. No other text.\n\n${contextBlock}`;

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
  salaryMin: string;
  salaryMax: string;
  salaryCurrency: string;
  salaryPeriod: string;
}

function parseAiResponse(raw: string): AiEnrichResult | null {
  let cleaned = raw.trim();
  cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

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
      salaryMin: String(parsed.salaryMin ?? ""),
      salaryMax: String(parsed.salaryMax ?? ""),
      salaryCurrency: String(parsed.salaryCurrency ?? "USD"),
      salaryPeriod: String(parsed.salaryPeriod ?? ""),
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

  // Salary — use AI values when present
  if (ai.salaryMin || ai.salaryMax) {
    updated.salaryMin = ai.salaryMin;
    updated.salaryMax = ai.salaryMax;
    if (ai.salaryCurrency) updated.salaryCurrency = ai.salaryCurrency;
    if (ai.salaryPeriod) updated.salaryPeriod = ai.salaryPeriod;
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

type EnrichResult = { row: CsvJobRow } | { dropped: true };

async function main(): Promise<void> {
  const options = parseCliOptions();
  const inputPath = path.resolve(process.cwd(), options.input);
  const outputPath = path.resolve(process.cwd(), options.output);

  console.log(`[INFO] Reading CSV: ${inputPath}`);
  const csvContent = await readFile(inputPath, "utf8");
  let rows = parseCsvContent(csvContent);
  console.log(`[INFO] Parsed ${rows.length} jobs from CSV`);

  if (options.maxJobs) {
    rows = rows.slice(0, options.maxJobs);
    console.log(`[INFO] Limited to ${rows.length} jobs (--maxJobs)`);
  }

  try {
    const res = await fetch(`${options.ollamaUrl}/api/tags`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    console.log(`[INFO] Ollama at ${options.ollamaUrl}, model: ${options.model}`);
  } catch {
    console.error(`[ERROR] Cannot reach Ollama at ${options.ollamaUrl}. Is it running?`);
    process.exit(1);
  }

  if (!options.skipFetch) {
    console.log(`[INFO] Browser fetch enabled: will load each job URL to extract live content`);
  }

  let results: EnrichResult[];
  try {
    results = await runConcurrent(rows, options.concurrency, async (row, index) => {
      try {
        let pageContent: string | undefined;
        if (!options.skipFetch && row.jobLink && /^https?:\/\//i.test(row.jobLink)) {
          const fetchResult = await fetchJobPage(row.jobLink);
          if (fetchResult?.html) {
            pageContent = extractPageText(fetchResult.html);
          }
        }

        const messages = buildEnrichmentPrompt(row, pageContent);
        const rawResponse = await ollamaChat(options.ollamaUrl, options.model, messages, 1_800_000);
        const aiResult = parseAiResponse(rawResponse);

        if (!aiResult) {
          console.log(`[WARN] Row ${index + 1} (${row.title.slice(0, 40)}): AI parse failed, keeping original`);
          const fallback = { ...row };
          fallback.jobType = normalizeJobType(row.jobType);
          fallback.workType = normalizeWorkType(row.workType);
          return { row: fallback };
        }

        if (aiResult.shouldDrop) {
          console.log(`[DROP] Row ${index + 1}: "${row.title.slice(0, 50)}" | ${row.jobLink.slice(0, 60)}`);
          return { dropped: true };
        }

        return { row: applyEnrichment(row, aiResult) };
      } catch (err) {
        console.log(`[WARN] Row ${index + 1} (${row.title.slice(0, 40)}): ${err instanceof Error ? err.message : err}`);
        const fallback = { ...row };
        fallback.jobType = normalizeJobType(row.jobType);
        fallback.workType = normalizeWorkType(row.workType);
        return { row: fallback };
      }
    });
  } finally {
    await closeBrowser();
  }

  const enrichedRows = results
    .filter((r): r is { row: CsvJobRow } => "row" in r)
    .map(r => r.row);
  const dropped = results.filter((r): r is { dropped: true } => "dropped" in r).length;

  console.log(`\n[INFO] Enrichment complete:`);
  console.log(`  Total input:  ${rows.length}`);
  console.log(`  Output:       ${enrichedRows.length}`);
  console.log(`  Dropped:      ${dropped}`);

  const outputDir = path.dirname(outputPath);
  await mkdir(outputDir, { recursive: true });
  await writeFile(outputPath, allRowsToApiCsv(enrichedRows), "utf8");
  console.log(`[INFO] Written to: ${outputPath}`);
}

const directRunHref = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === directRunHref) {
  main().catch((error) => {
    console.error("[FATAL]", error);
    process.exit(1);
  });
}
