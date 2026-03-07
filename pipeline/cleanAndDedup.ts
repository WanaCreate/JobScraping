/**
 * One-time cleanup & deduplication script for the enriched CSV.
 *
 * Steps:
 *   1. URL dedup — normalize URLs (strip query params, trailing slashes), drop dupes
 *   2. Cross-domain dedup — group by (title_lower, company_lower), keep canonical URL
 *   3. Invalid job removal — drop rows with garbage titles AND non-job URLs
 *   4. Fix keywords — strip HTML, drop entries >50 chars
 *   5. Fix skills — GPT-nano call to clean phrase-like skills
 *   6. Regenerate keywords for rows with bad/empty keywords — GPT-nano call
 *
 * Usage:
 *   npx tsx pipeline/cleanAndDedup.ts [options]
 *
 * Options:
 *   --input <path>       CSV input (default: outputs/api-ready/latest/results_enriched_api_gpt.csv)
 *   --output <path>      CSV output (default: outputs/api-ready/latest/results_cleaned.csv)
 *   --concurrency <n>    Parallel GPT calls (default: 5)
 *   --model <name>       OpenAI model (default: gpt-4.1-nano)
 *   --apiKey <key>       OpenAI API key (or set OPENAI_API_KEY env var)
 *   --dryRun             Print what would be done without writing output
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

// ─── Load .env ────────────────────────────────────────────────────
async function loadEnv(): Promise<void> {
  try {
    const envPath = path.resolve(process.cwd(), ".env");
    const content = await readFile(envPath, "utf8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx < 0) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      if (!process.env[key]) process.env[key] = val;
    }
  } catch {
    // .env not found, that's fine
  }
}

// ─── Types ────────────────────────────────────────────────────────

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

// ─── CLI ──────────────────────────────────────────────────────────

interface CliOptions {
  input: string;
  output: string;
  concurrency: number;
  model: string;
  apiKey: string;
  dryRun: boolean;
}

function getArg(flag: string): string | null {
  const idx = process.argv.indexOf(flag);
  if (idx < 0) return null;
  const value = process.argv[idx + 1];
  return value && !value.startsWith("--") ? value : null;
}

function parseCliOptions(): CliOptions {
  const apiKey = getArg("--apiKey") ?? process.env.OPENAI_API_KEY ?? "";
  if (!apiKey) {
    console.error("[ERROR] OpenAI API key required. Set OPENAI_API_KEY env var or pass --apiKey <key>");
    process.exit(1);
  }
  return {
    input: getArg("--input") ?? "outputs/api-ready/latest/results_enriched_api_gpt.csv",
    output: getArg("--output") ?? "outputs/api-ready/latest/results_cleaned.csv",
    concurrency: Number(getArg("--concurrency") ?? "5"),
    model: getArg("--model") ?? "gpt-4.1-nano",
    apiKey,
    dryRun: process.argv.includes("--dryRun"),
  };
}

// ─── CSV Parsing (reused from enrichFromCsvGpt.ts) ───────────────

const CSV_HEADERS: (keyof CsvJobRow)[] = [
  "title", "description", "jobType", "deadline", "keywords", "skills",
  "jobLink", "hiringTeam", "workType", "workEmail", "allowEmailApplications",
  "numberOfPositions", "company", "companyWebsite", "companyLogo", "companyEmail",
  "locationName", "formattedAddress", "city", "state", "country",
  "latitude", "longitude", "salaryMin", "salaryMax", "salaryCurrency", "salaryPeriod",
];

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

function parseCsvContent(content: string): CsvJobRow[] {
  const rows: CsvJobRow[] = [];
  const fields = parseCsvFields(content);
  const colCount = CSV_HEADERS.length;

  for (let i = colCount; i + colCount <= fields.length; i += colCount) {
    const row: Record<string, string> = {};
    for (let c = 0; c < colCount; c++) {
      row[CSV_HEADERS[c]] = (fields[i + c] ?? "").trim();
    }
    rows.push(row as unknown as CsvJobRow);
  }
  return rows;
}

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
  return [header, ...rows.map(r => rowToCsv(r))].join("\n");
}

// ─── OpenAI API ──────────────────────────────────────────────────

interface OpenAiMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

async function gptChat(
  apiKey: string,
  model: string,
  messages: OpenAiMessage[],
  timeoutMs = 60_000,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.1,
        response_format: { type: "json_object" },
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`OpenAI HTTP ${res.status}: ${text.slice(0, 300)}`);
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return data.choices?.[0]?.message?.content ?? "";
  } finally {
    clearTimeout(timer);
  }
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

// ─── Step 1: URL Dedup ───────────────────────────────────────────

function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    // Strip query params and fragments
    return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, "")}`.toLowerCase();
  } catch {
    return url.toLowerCase().replace(/\/+$/, "");
  }
}

function deduplicateByUrl(rows: CsvJobRow[]): { kept: CsvJobRow[]; removed: number } {
  const seen = new Map<string, number>();
  const kept: CsvJobRow[] = [];
  let removed = 0;

  for (const row of rows) {
    const normalized = normalizeUrl(row.jobLink);
    if (seen.has(normalized)) {
      removed++;
    } else {
      seen.set(normalized, kept.length);
      kept.push(row);
    }
  }

  return { kept, removed };
}

// ─── Step 2: Cross-Domain Dedup ──────────────────────────────────

/** Prefer company careers page over ATS domains */
function urlPriority(url: string): number {
  const lower = url.toLowerCase();
  // ATS / third-party domains get lower priority
  if (/myworkdayjobs\.com/i.test(lower)) return 0;
  if (/greenhouse\.io/i.test(lower)) return 0;
  if (/lever\.co/i.test(lower)) return 0;
  if (/smartrecruiters\.com/i.test(lower)) return 0;
  if (/icims\.com/i.test(lower)) return 0;
  if (/ashbyhq\.com/i.test(lower)) return 0;
  if (/job-boards\./i.test(lower)) return 0;
  // Company careers pages get higher priority
  if (/careers?\./i.test(lower)) return 2;
  return 1;
}

function deduplicateCrossDomain(rows: CsvJobRow[]): { kept: CsvJobRow[]; removed: number } {
  const groups = new Map<string, CsvJobRow[]>();

  for (const row of rows) {
    const key = `${row.title.toLowerCase().trim()}|||${row.company.toLowerCase().trim()}`;
    const existing = groups.get(key);
    if (existing) {
      existing.push(row);
    } else {
      groups.set(key, [row]);
    }
  }

  const kept: CsvJobRow[] = [];
  let removed = 0;

  for (const group of groups.values()) {
    if (group.length === 1) {
      kept.push(group[0]);
      continue;
    }
    // Sort by URL priority (higher = better), keep the best one
    group.sort((a, b) => urlPriority(b.jobLink) - urlPriority(a.jobLink));
    kept.push(group[0]);
    removed += group.length - 1;
  }

  return { kept, removed };
}

// ─── Step 3: Invalid Job Removal ─────────────────────────────────

const INVALID_TITLE_PATTERNS = [
  /^job not available$/i,
  /^page not found$/i,
  /^404$/i,
  /^error$/i,
  /^select which cookies/i,
  /^cookie/i,
  /^current openings at/i,
  /^careers at/i,
  /^figma careers$/i,
  /^open roles$/i,
  /^design team$/i,
  /^jobs in /i,
  /^opportunities by /i,
  /^great website design/i,
];

/** Names that were scraped as titles — clearly person names, not job titles */
/** Titles that are clearly not job titles — always drop regardless of URL */
const ALWAYS_DROP_TITLES = new Set([
  "neria katz",
  "rui xu",
  "job not available",
]);

/** Try to extract a job title from a URL path like /jobs/7206620-design-director */
function titleFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").filter(Boolean);
    // Look for a segment that contains a slug with words (not just an ID)
    for (let i = segments.length - 1; i >= 0; i--) {
      const seg = segments[i];
      // Skip pure numeric IDs or very short segments
      if (/^\d+$/.test(seg) || seg.length < 5) continue;
      // Strip leading numeric ID prefix (e.g. "7206620-design-director" -> "design-director")
      const slug = seg.replace(/^\d+-/, "").replace(/[-_]/g, " ").trim();
      if (slug.length >= 5 && /[a-z]/.test(slug)) {
        // Title-case the slug
        return slug.replace(/\b\w/g, c => c.toUpperCase());
      }
    }
  } catch {}
  return null;
}

function isSpecificJobUrl(url: string): boolean {
  return /\/(job|position|career|opening|role|vacancy)s?\//i.test(url) ||
    /\/careers\/[a-z0-9]+-[a-z0-9]/i.test(url) ||
    /\/jobs\/\d+/i.test(url) ||
    /[?&]gh_jid=/i.test(url);
}

function removeInvalidJobs(rows: CsvJobRow[]): { kept: CsvJobRow[]; removed: CsvJobRow[] } {
  const kept: CsvJobRow[] = [];
  const removed: CsvJobRow[] = [];

  for (const row of rows) {
    const titleLower = row.title.toLowerCase().trim();

    // Always drop titles that are clearly not jobs (person names, "job not available")
    if (ALWAYS_DROP_TITLES.has(titleLower)) {
      removed.push(row);
      continue;
    }

    const titleIsBad = INVALID_TITLE_PATTERNS.some(p => p.test(titleLower));

    if (titleIsBad) {
      if (isSpecificJobUrl(row.jobLink)) {
        // Title is bad but URL is a real job — try to fix title from URL
        const fixedTitle = titleFromUrl(row.jobLink);
        if (fixedTitle) {
          row.title = fixedTitle;
          kept.push(row);
        } else {
          removed.push(row);
        }
      } else {
        removed.push(row);
      }
    } else {
      kept.push(row);
    }
  }

  return { kept, removed };
}

// ─── Step 4: Fix Keywords (deterministic) ────────────────────────

function cleanKeywords(keywords: string): string {
  if (!keywords) return "";
  const parts = keywords.split("|").map(k => k.trim()).filter(k => {
    if (!k) return false;
    // Drop anything containing HTML tags
    if (/<[^>]+>/.test(k)) return false;
    // Drop anything >50 chars (sentence fragments)
    if (k.length > 50) return false;
    // Drop obvious non-tag fragments
    if (/^(or |and |such as |with |including |ideally |preferably )/.test(k.toLowerCase())) return false;
    return true;
  });
  return parts.join("|");
}

// ─── Step 5 & 6: Fix Skills & Regenerate Keywords via GPT ────────

/** All rows get GPT cleanup for skills/keywords — GPT is better than regex at judging validity */

const VALID_TAG_VOCABULARY = [
  "design", "creative", "brand", "content", "visual", "motion", "ui", "ux",
  "video", "product design", "graphic design", "animation", "art direction",
  "copywriting", "ux writing", "research", "illustration", "typography",
  "branding & identity", "digital design", "digital marketing", "interaction design",
  "industrial design", "accessibility", "2d animation", "ai animation",
  "content design", "strategy", "technology", "html", "sketch", "prototypes",
];

function buildSkillsKeywordsPrompt(row: CsvJobRow): OpenAiMessage[] {
  const systemPrompt = `You are a job data quality assistant. Given a job's title, company, current keywords (tags), and current skills, return cleaned versions.

RULES FOR KEYWORDS (tags):
- Keywords are short category labels shown as tags on a job board (e.g. "design", "ux", "brand", "motion", "video")
- Pick 3-7 relevant tags from this vocabulary: ${VALID_TAG_VOCABULARY.join(", ")}
- You may suggest 1-2 tags outside the vocabulary if highly relevant, but keep them short (1-3 words max)
- Remove any HTML, sentence fragments, or long phrases

RULES FOR SKILLS:
- Skills should be real, recognizable professional skills or tools in lowercase_underscore format
- A valid skill is a tool, technology, methodology, or concrete competency that could appear on a resume (e.g. "figma", "design_systems", "ux_research", "prototyping", "adobe_creative_suite", "motion_graphics", "html", "css", "javascript", "typography", "branding")
- REMOVE anything that is:
  - A sentence fragment or phrase extracted from a job description (e.g. "as_well_as_research", "align_with_our_needs", "the_future_of_creative", "execution_at_an_agency", "ability_to_track_metrics", "interaction_models_for_chatbots", "contributing_to_project_playbooks", "while_interacting_with_agents", "metrics_to_determine", "to_build_models", "to_support_two_directors", "system_verification_for_production", "and_experience_second-guess_themselves")
  - A degree or qualification (e.g. "bachelor_s_degree", "master_s_degree", "bachelor_of_arts_degr")
  - A truncated/broken string (e.g. "-_speak", "-_j", "a_amp", "examples_of_wo", "dealing_with_multip")
  - A generic soft trait rather than a concrete skill (e.g. "self-motivated", "strong_organizational_skills", "attention_to_detail", "are_a_fit", "to_grow")
  - A protected class or legal phrase (e.g. "without_regard_to_race", "disability", "other_legally_protected_status")
- Keep 3-10 valid skills. If very few valid skills remain after cleaning, that's fine — don't invent skills.

Respond with ONLY a valid JSON object:
{
  "keywords": "tag1|tag2|tag3",
  "skills": "skill_one|skill_two|skill_three"
}`;

  const userPrompt = `TITLE: ${row.title}
COMPANY: ${row.company}
CURRENT KEYWORDS: ${row.keywords}
CURRENT SKILLS: ${row.skills}`;

  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];
}

function parseSkillsKeywordsResponse(raw: string): { keywords: string; skills: string } | null {
  let cleaned = raw.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const jsonStart = cleaned.indexOf("{");
  const jsonEnd = cleaned.lastIndexOf("}");
  if (jsonStart === -1 || jsonEnd === -1) return null;
  cleaned = cleaned.slice(jsonStart, jsonEnd + 1);

  try {
    const parsed = JSON.parse(cleaned);
    return {
      keywords: String(parsed.keywords ?? ""),
      skills: String(parsed.skills ?? ""),
    };
  } catch {
    return null;
  }
}

// ─── Main ─────────────────────────────────────────────────────────

async function main(): Promise<void> {
  await loadEnv();
  const options = parseCliOptions();
  const inputPath = path.resolve(process.cwd(), options.input);
  const outputPath = path.resolve(process.cwd(), options.output);

  console.log(`[INFO] Reading CSV: ${inputPath}`);
  const csvContent = await readFile(inputPath, "utf8");
  let rows = parseCsvContent(csvContent);
  console.log(`[INFO] Parsed ${rows.length} jobs from CSV`);

  // ── Step 1: URL Dedup ──
  console.log("\n=== Step 1: URL Deduplication ===");
  const urlDedup = deduplicateByUrl(rows);
  console.log(`  Removed ${urlDedup.removed} URL duplicates (same URL, different query params)`);
  rows = urlDedup.kept;

  // ── Step 2: Cross-Domain Dedup ──
  console.log("\n=== Step 2: Cross-Domain Deduplication ===");
  const crossDedup = deduplicateCrossDomain(rows);
  console.log(`  Removed ${crossDedup.removed} cross-domain duplicates (same title+company, different domains)`);
  rows = crossDedup.kept;

  // ── Step 3: Invalid Job Removal ──
  console.log("\n=== Step 3: Invalid Job Removal ===");
  const invalidResult = removeInvalidJobs(rows);
  console.log(`  Removed ${invalidResult.removed.length} invalid jobs:`);
  for (const r of invalidResult.removed) {
    console.log(`    [DROP] "${r.title}" | ${r.company} | ${r.jobLink.slice(0, 70)}`);
  }
  rows = invalidResult.kept;

  // ── Step 4: Fix Keywords (deterministic) ──
  console.log("\n=== Step 4: Deterministic Keyword Cleanup ===");
  let kwFixed = 0;
  for (const row of rows) {
    const cleaned = cleanKeywords(row.keywords);
    if (cleaned !== row.keywords) {
      kwFixed++;
      row.keywords = cleaned;
    }
  }
  console.log(`  Fixed keywords on ${kwFixed} rows (stripped HTML, sentence fragments)`);

  // ── Step 5 & 6: GPT-based Skills & Keywords Cleanup (all rows) ──
  console.log("\n=== Step 5 & 6: GPT Skills & Keywords Cleanup ===");
  console.log(`  Processing all ${rows.length} rows through GPT for skills/keywords cleanup`);

  if (rows.length > 0 && !options.dryRun) {
    let gptFixed = 0;
    let gptFailed = 0;

    await runConcurrent(rows, options.concurrency, async (row) => {
      try {
        const messages = buildSkillsKeywordsPrompt(row);
        const rawResponse = await gptChat(options.apiKey, options.model, messages, 30_000);
        const result = parseSkillsKeywordsResponse(rawResponse);

        if (!result) {
          gptFailed++;
          return;
        }

        if (result.keywords) row.keywords = result.keywords;
        if (result.skills) row.skills = result.skills;
        gptFixed++;

        if ((gptFixed + gptFailed) % 50 === 0) {
          console.log(`  [INFO] Progress: ${gptFixed + gptFailed}/${rows.length}`);
        }
      } catch (err) {
        gptFailed++;
        console.log(`  [WARN] Row "${row.title.slice(0, 40)}": ${err instanceof Error ? err.message : err}`);
      }
    });

    console.log(`  GPT cleanup: ${gptFixed} fixed, ${gptFailed} failed`);
  }

  // ── Summary ──
  console.log("\n=== Summary ===");
  console.log(`  URL dupes removed:          ${urlDedup.removed}`);
  console.log(`  Cross-domain dupes removed:  ${crossDedup.removed}`);
  console.log(`  Invalid jobs removed:        ${invalidResult.removed.length}`);
  console.log(`  Keywords deterministically fixed: ${kwFixed}`);
  console.log(`  Final row count:             ${rows.length}`);

  if (options.dryRun) {
    console.log("\n[DRY RUN] No output file written.");
    return;
  }

  const outputDir = path.dirname(outputPath);
  await mkdir(outputDir, { recursive: true });
  await writeFile(outputPath, allRowsToCsv(rows), "utf8");
  console.log(`\n[INFO] Written to: ${outputPath}`);
}

const directRunHref = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === directRunHref) {
  main().catch((error) => {
    console.error("[FATAL]", error);
    process.exit(1);
  });
}
