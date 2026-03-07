/**
 * GPT-4.1 nano job enrichment pipeline.
 *
 * Reads the already-enriched CSV (results_enriched_api.csv), sends each row
 * through OpenAI GPT-4.1 nano to validate/fix:
 *   a) title        – fix generic/nonsensical titles
 *   b) description  – strip noise, keep only job-relevant info, format into clean HTML
 *   c) jobType      – validate against allowed values, default FULLTIME
 *   d) workType     – validate against allowed values, fix or clear
 *   e) location     – validate, fix or clear
 *   f) keywords     – clean and regenerate proper tags
 *   g) skills       – clean phrase-like entries, keep only real skills
 *   h) job_url      – read-only context
 *
 * Pre-processing: URL dedup + cross-domain dedup before GPT enrichment.
 * Drop a row ONLY when both the title AND job_url are irrelevant to a real job posting.
 *
 * IMPORTANT - CSV / Excel safety:
 *   The description field is rendered as HTML in the web app via a RichTextRenderer.
 *   For CSV compatibility (no cell overflow in Excel), the description MUST be a
 *   compact single-line HTML string — no raw newlines inside the HTML content.
 *   We enforce this both in the prompt and in post-processing.
 *
 * Usage:
 *   npx tsx pipeline/enrichFromCsvGpt.ts [options]
 *
 * Options:
 *   --input <path>         CSV input (default: outputs/api-ready/latest/results_enriched_api.csv)
 *   --output <path>        CSV output (default: outputs/api-ready/latest/results_enriched_api_gpt.csv)
 *   --concurrency <n>      Parallel GPT calls (default: 5)
 *   --maxJobs <n>          Process at most N jobs
 *   --model <name>         OpenAI model (default: gpt-4.1-nano)
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

// ─── CLI ──────────────────────────────────────────────────────────

interface CliOptions {
  input: string;
  output: string;
  concurrency: number;
  maxJobs: number | null;
  model: string;
  apiKey: string;
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
    input: getArg("--input") ?? "outputs/api-ready/latest/results_enriched_api.csv",
    output: getArg("--output") ?? "outputs/api-ready/latest/results_enriched_api_gpt.csv",
    concurrency: Number(getArg("--concurrency") ?? "5"),
    maxJobs: getArg("--maxJobs") ? Number(getArg("--maxJobs")) : null,
    model: getArg("--model") ?? "gpt-4.1-nano",
    apiKey,
  };
}

// ─── CSV Parsing ──────────────────────────────────────────────────

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

// ─── CSV Output ───────────────────────────────────────────────────

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

// ─── Pre-processing: Deduplication ───────────────────────────────

function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, "")}`.toLowerCase();
  } catch {
    return url.toLowerCase().replace(/\/+$/, "");
  }
}

function urlPriority(url: string): number {
  const lower = url.toLowerCase();
  if (/myworkdayjobs\.com|greenhouse\.io|lever\.co|smartrecruiters\.com|icims\.com|ashbyhq\.com|job-boards\./i.test(lower)) return 0;
  if (/careers?\./i.test(lower)) return 2;
  return 1;
}

function deduplicateRows(rows: CsvJobRow[]): { kept: CsvJobRow[]; urlDupes: number; crossDomainDupes: number } {
  // Step 1: URL dedup (strip query params)
  const urlSeen = new Map<string, number>();
  const urlDeduped: CsvJobRow[] = [];
  let urlDupes = 0;

  for (const row of rows) {
    const normalized = normalizeUrl(row.jobLink);
    if (urlSeen.has(normalized)) {
      urlDupes++;
    } else {
      urlSeen.set(normalized, urlDeduped.length);
      urlDeduped.push(row);
    }
  }

  // Step 2: Cross-domain dedup (same title+company)
  const groups = new Map<string, CsvJobRow[]>();
  for (const row of urlDeduped) {
    const key = `${row.title.toLowerCase().trim()}|||${row.company.toLowerCase().trim()}`;
    const existing = groups.get(key);
    if (existing) existing.push(row);
    else groups.set(key, [row]);
  }

  const kept: CsvJobRow[] = [];
  let crossDomainDupes = 0;

  for (const group of groups.values()) {
    if (group.length === 1) {
      kept.push(group[0]);
    } else {
      group.sort((a, b) => urlPriority(b.jobLink) - urlPriority(a.jobLink));
      kept.push(group[0]);
      crossDomainDupes += group.length - 1;
    }
  }

  return { kept, urlDupes, crossDomainDupes };
}

// ─── Pre-processing: Invalid job detection ───────────────────────

/** Titles that are clearly not job titles — always drop regardless of URL */
const ALWAYS_DROP_TITLES = new Set([
  "neria katz", "rui xu", "job not available",
]);

const INVALID_TITLE_PATTERNS = [
  /^page not found$/i,
  /^404$/i,
  /^error$/i,
  /^select which cookies/i,
  /^cookie/i,
  /^current openings at/i,
  /^careers at/i,
  /^open roles$/i,
  /^design team$/i,
  /^jobs in /i,
  /^opportunities by /i,
  /^great website design/i,
];

function titleFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").filter(Boolean);
    for (let i = segments.length - 1; i >= 0; i--) {
      const seg = segments[i];
      if (/^\d+$/.test(seg) || seg.length < 5) continue;
      const slug = seg.replace(/^\d+-/, "").replace(/[-_]/g, " ").trim();
      if (slug.length >= 5 && /[a-z]/.test(slug)) {
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

function preFilterInvalidJobs(rows: CsvJobRow[]): { kept: CsvJobRow[]; removed: number } {
  const kept: CsvJobRow[] = [];
  let removed = 0;

  for (const row of rows) {
    const titleLower = row.title.toLowerCase().trim();

    if (ALWAYS_DROP_TITLES.has(titleLower)) {
      removed++;
      console.log(`[PRE-DROP] "${row.title}" | ${row.company}`);
      continue;
    }

    const titleIsBad = INVALID_TITLE_PATTERNS.some(p => p.test(titleLower));
    if (titleIsBad) {
      if (isSpecificJobUrl(row.jobLink)) {
        const fixedTitle = titleFromUrl(row.jobLink);
        if (fixedTitle) {
          row.title = fixedTitle;
          kept.push(row);
        } else {
          removed++;
          console.log(`[PRE-DROP] "${row.title}" | ${row.company}`);
        }
      } else {
        removed++;
        console.log(`[PRE-DROP] "${row.title}" | ${row.company}`);
      }
    } else {
      kept.push(row);
    }
  }

  return { kept, removed };
}

// ─── OpenAI API ───────────────────────────────────────────────────

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
        "Authorization": `Bearer ${apiKey}`,
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

    const data = await res.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return data.choices?.[0]?.message?.content ?? "";
  } finally {
    clearTimeout(timer);
  }
}

// ─── Validation helpers ───────────────────────────────────────────

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

// ─── Keywords & Skills post-processing ───────────────────────────

/** Strip HTML, sentence fragments, and overly long entries from keywords */
function cleanKeywords(keywords: string): string {
  if (!keywords) return "";
  return keywords.split("|").map(k => k.trim()).filter(k => {
    if (!k) return false;
    if (/<[^>]+>/.test(k)) return false;
    if (k.length > 50) return false;
    if (/^(or |and |such as |with |including |ideally |preferably )/.test(k.toLowerCase())) return false;
    return true;
  }).join("|");
}

/** Check if a skill entry is a sentence fragment rather than a real skill */
function isPhraseLikeSkill(s: string): boolean {
  if (s.length > 50) return true;
  if (/^(the_|a_|of_|with_|and_|or_|in_|for_|is_|are_|as_|at_|to_|that_|this_|ability_|while_|along_|including_|ideally_|preferably_|contributing_|dealing_|bachelor_|experience_)/.test(s)) return true;
  if (/(_the_|_a_|_is_|_are_|_that_|_this_)/.test(s)) return true;
  if (/(_to_|_for_|_with_|_and_|_or_|_in_|_at_|_of_)/.test(s)) return true;
  if (/^-_/.test(s)) return true;
  if (/degr|_why_/.test(s)) return true;
  return false;
}

/** Clean skills by removing phrase-like entries */
function cleanSkills(skills: string): string {
  if (!skills) return "";
  return skills.split("|").map(s => s.trim()).filter(s => {
    if (!s) return false;
    return !isPhraseLikeSkill(s);
  }).join("|");
}

// ─── Prompt ───────────────────────────────────────────────────────

const VALID_TAG_VOCABULARY = [
  "design", "creative", "brand", "content", "visual", "motion", "ui", "ux",
  "video", "product design", "graphic design", "animation", "art direction",
  "copywriting", "ux writing", "research", "illustration", "typography",
  "branding & identity", "digital design", "digital marketing", "interaction design",
  "industrial design", "accessibility", "2d animation", "ai animation",
  "content design", "strategy", "technology", "html", "sketch", "prototypes",
];

function buildEnrichmentPrompt(row: CsvJobRow): OpenAiMessage[] {
  const systemPrompt = `You are a job listing data quality assistant. Review and fix the provided job listing fields.

RULES:

1. TITLE: Keep if it's a real job title. If it's a generic careers-page heading (e.g. "Asana Careers"), cookie notice, 404 page, person name, or otherwise not a real job title, infer the correct title from the description or URL. If you cannot determine a real title, set it to "INVALID".

2. DESCRIPTION: Clean and reformat the job description.
   REMOVE completely:
   - Cookie banners, login prompts, navigation text, breadcrumbs
   - "Apply now" / "Submit application" buttons and form elements (First Name, Last Name, Resume/CV fields)
   - Social share links, EEO/diversity statements, legal disclaimers, privacy notices
   - Generic company-wide benefits/perks boilerplate unrelated to the specific role
   - Salary/compensation sections (salary data is stored in separate CSV fields)

   KEEP only:
   - Job responsibilities / "What you'll do"
   - Qualifications / requirements / "What we're looking for"
   - "About the role" or "About the team" sections relevant to the position
   - Required and preferred skills
   - Role-specific context

   FORMAT rules (CRITICAL for CSV/Excel compatibility):
   - Use ONLY these HTML tags: <p>, <ul>, <ol>, <li>, <strong>, <em>, <br>
   - Do NOT use heading tags (<h1>, <h2>, <h3>, etc.). Instead, use <p><strong>Section Title</strong></p> for section headings.
   - <strong> must ONLY be used for section heading labels (e.g. "About the Role", "Responsibilities", "Requirements"). Do NOT bold regular body text, list items, or sub-labels.
   - Every block of text MUST be wrapped in a <p> tag. Never leave bare text between sections or lists.
   - Wrap each section's intro/body text in <p> tags for proper spacing.
   - IMPORTANT: Each new paragraph or section MUST be in its own <p> tag to ensure proper line spacing between paragraphs. Do NOT combine multiple paragraphs into a single <p> tag.
   - Remove all emojis from the output. Do not include emoji characters anywhere in the description.
   - Structure example: <p><strong>About the Role</strong></p><p>We are looking for a skilled engineer...</p><p><strong>Responsibilities</strong></p><ul><li>Lead design projects</li><li>Collaborate with teams</li></ul><p><strong>Requirements</strong></p><ul><li>5+ years experience</li><li>Strong portfolio</li></ul>
   - Output MUST be a single-line HTML string with NO literal newline characters inside the HTML.
   - Do NOT use \\n or any escape sequences for newlines. Concatenate tags directly with no whitespace between them.
   - If the description is already short or a placeholder like "For job details, click apply", keep it as-is.

3. JOBTYPE: Must be exactly one of: GIG, FULLTIME, PARTTIME, FREELANCE. Fix if invalid. Default: FULLTIME.

4. WORKTYPE: Must be exactly one of: ONSITE, HYBRID, REMOTE, or empty string "". Infer from description/title/location if missing or wrong.
   IMPORTANT: If there is any physical location associated with the job (locationName, city, state, or country are non-empty), then workType can ONLY be "ONSITE" or "HYBRID". When unsure, default to "ONSITE". Only set "REMOTE" if the location fields are all empty/cleared OR the description explicitly states the role is fully remote.

5. LOCATION fields (locationName, formattedAddress, city, state, country):
   - If city is "Remote", clear all location fields (workType should be REMOTE). Fix obvious errors. Clear if nonsensical.
   - IMPORTANT: Carefully read the job description to identify any location mentioned. Only change the existing location fields if the description explicitly mentions a DIFFERENT/CONFLICTING location. If the description does not mention any specific location, leave the existing location fields exactly as they are — do NOT clear or modify them.
   - When returning location fields, if you are not changing them, return them with their original values.

6. SALARY: If salaryMin or salaryMax is "0", set it to "" (empty). Never output 0 for salary fields. If you cannot determine a correct salary number from the description, leave salary fields empty (""). Only set salary to a specific number if you can confidently extract it from the job description.

7. DROP: Set "shouldDrop" to true ONLY if BOTH conditions are met:
   - The title is NOT a real job title and cannot be fixed from context
   - The jobLink URL does NOT look like a real job posting URL (e.g. it's a careers listing page, homepage, or error page)
   If EITHER the title looks like a real job title OR the URL looks like a specific job posting URL, do NOT drop — keep the row.
   Examples of real job URLs: contains /job/, /careers/specific-role, /position/, job ID in path, etc.
   Example: title="Design Engineer" + url="https://company.com/careers/design-engineer-x3mbzomt96" → do NOT drop, this is clearly a real job.

8. DESCRIPTION FALLBACK: If you cannot extract meaningful job description content (the source is mostly noise, a login wall, or a redirect page), set description to exactly: "For more details, click apply"
   Do NOT drop a row just because the description is poor — only drop based on rule 7 above.

9. KEYWORDS (tags): Return cleaned keywords as pipe-delimited short category labels.
   - Pick 3-7 relevant tags from this vocabulary: ${VALID_TAG_VOCABULARY.join(", ")}
   - You may add 1-2 tags outside the vocabulary if highly relevant, but keep them short (1-3 words max)
   - Remove any HTML, sentence fragments, or entries longer than 50 characters
   - If the current keywords are already good, return them unchanged

10. SKILLS: Return cleaned skills as pipe-delimited lowercase_underscore entries.
   - A valid skill is a tool, technology, methodology, or concrete competency that could appear on a resume (e.g. "figma", "design_systems", "ux_research", "prototyping", "adobe_creative_suite", "motion_graphics", "html", "css", "javascript", "typography", "branding")
   - REMOVE anything that is:
     - A sentence fragment or phrase (e.g. "as_well_as_research", "align_with_our_needs", "the_future_of_creative", "execution_at_an_agency", "ability_to_track_metrics", "interaction_models_for_chatbots", "metrics_to_determine", "to_build_models")
     - A degree or qualification (e.g. "bachelor_s_degree", "master_s_degree")
     - A truncated/broken string (e.g. "-_speak", "-_j", "a_amp")
     - A generic soft trait (e.g. "self-motivated", "attention_to_detail", "are_a_fit", "to_grow")
     - A protected class or legal phrase (e.g. "without_regard_to_race", "disability")
   - Keep 3-10 valid skills. If few valid skills remain after cleaning, that's fine — don't invent skills
   - If the current skills are already clean, return them unchanged

Respond with ONLY a valid JSON object (no markdown fences, no explanation):
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
  "country": "",
  "salaryMin": "",
  "salaryMax": "",
  "salaryCurrency": "",
  "salaryPeriod": "",
  "keywords": "design|ux|product design",
  "skills": "figma|prototyping|design_systems"
}`;

  const userPrompt = `Review this job listing:

TITLE: ${row.title}
JOB URL: ${row.jobLink}
CURRENT JOB TYPE: ${row.jobType}
CURRENT WORK TYPE: ${row.workType}
LOCATION: ${row.locationName} | ${row.formattedAddress} | ${row.city}, ${row.state}, ${row.country}
COMPANY: ${row.company}
SALARY: min=${row.salaryMin} max=${row.salaryMax} currency=${row.salaryCurrency} period=${row.salaryPeriod}
CURRENT KEYWORDS: ${row.keywords}
CURRENT SKILLS: ${row.skills}

DESCRIPTION (may contain HTML):
${decodeHtmlEntities(row.description).slice(0, 8000)}`;

  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];
}

// ─── Parse AI response ────────────────────────────────────────────

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
  keywords: string;
  skills: string;
}

function parseAiResponse(raw: string): AiEnrichResult | null {
  let cleaned = raw.trim();
  // Remove markdown fences just in case (response_format should prevent this)
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
      salaryCurrency: String(parsed.salaryCurrency ?? ""),
      salaryPeriod: String(parsed.salaryPeriod ?? ""),
      keywords: String(parsed.keywords ?? ""),
      skills: String(parsed.skills ?? ""),
    };
  } catch {
    return null;
  }
}

// ─── HTML entity decoder ──────────────────────────────────────────

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'");
}

// Strip emojis and other non-printable / multi-byte symbol characters
function stripEmojis(str: string): string {
  return str
    .replace(/[\u{1F000}-\u{1FFFF}]/gu, "")   // emoji blocks
    .replace(/[\u{2600}-\u{27BF}]/gu, "")      // misc symbols & dingbats
    .replace(/[\u{FE00}-\u{FEFF}]/gu, "")      // variation selectors / BOM
    .replace(/\s{2,}/g, " ")
    .trim();
}

// ─── Apply AI result to row ───────────────────────────────────────

function toSingleLineHtml(html: string): string {
  return html
    .replace(/\r\n?/g, " ")   // CR/LF -> space
    .replace(/\n/g, " ")       // any remaining LF -> space
    .replace(/>\s+</g, "><")   // collapse whitespace between tags
    .replace(/\s{2,}/g, " ")   // collapse multiple spaces
    .trim();
}

function ensureParagraphSpacing(html: string): string {
  let result = html;
  result = result.replace(/<br\s*\/?>\s*<br\s*\/?>/gi, "</p><p>");
  return result;
}

function hasNonEmptyLocation(row: CsvJobRow): boolean {
  return !!(row.locationName || row.city || row.state || row.country);
}

function applyEnrichment(row: CsvJobRow, ai: AiEnrichResult): CsvJobRow {
  const updated = { ...row };

  if (ai.title && ai.title !== "INVALID") {
    updated.title = ai.title;
  }

  if (ai.description && ai.description.length > 30) {
    updated.description = ensureParagraphSpacing(toSingleLineHtml(stripEmojis(ai.description)));
  } else if (!updated.description || updated.description.length < 30) {
    updated.description = "For more details, click apply";
  }

  updated.jobType = normalizeJobType(ai.jobType || row.jobType);

  // --- Location: only override if AI returned a different (conflicting) location ---
  const aiHasLocation = !!(ai.city || ai.state || ai.country || ai.locationName);

  if (aiHasLocation) {
    const locationChanged =
      (ai.city && ai.city.toLowerCase() !== (row.city || "").toLowerCase()) ||
      (ai.state && ai.state.toLowerCase() !== (row.state || "").toLowerCase()) ||
      (ai.country && ai.country.toLowerCase() !== (row.country || "").toLowerCase());

    if (locationChanged) {
      updated.locationName = ai.locationName || row.locationName;
      updated.formattedAddress = ai.formattedAddress || row.formattedAddress;
      updated.city = ai.city || row.city;
      updated.state = ai.state || row.state;
      updated.country = ai.country || row.country;
    }
  }

  // --- WorkType ---
  const aiWorkType = normalizeWorkType(ai.workType);
  if (aiWorkType) {
    updated.workType = aiWorkType;
  } else {
    updated.workType = normalizeWorkType(row.workType);
  }

  // "Remote" as city -> clear location, force REMOTE
  if (/^remote$/i.test(updated.city)) {
    updated.city = "";
    updated.locationName = "";
    updated.formattedAddress = "";
    updated.state = "";
    updated.country = "";
    updated.workType = "REMOTE";
  }

  // If location exists, workType can only be ONSITE or HYBRID (default ONSITE)
  if (hasNonEmptyLocation(updated) && updated.workType === "REMOTE") {
    updated.workType = "ONSITE";
  }
  if (hasNonEmptyLocation(updated) && !updated.workType) {
    updated.workType = "ONSITE";
  }

  // --- Salary: never set to 0, leave blank instead ---
  if (ai.salaryMin && ai.salaryMin !== "0") {
    updated.salaryMin = ai.salaryMin;
  } else if (updated.salaryMin === "0") {
    updated.salaryMin = "";
  }
  if (ai.salaryMax && ai.salaryMax !== "0") {
    updated.salaryMax = ai.salaryMax;
  } else if (updated.salaryMax === "0") {
    updated.salaryMax = "";
  }
  if (ai.salaryCurrency) {
    updated.salaryCurrency = ai.salaryCurrency;
  }
  if (ai.salaryPeriod) {
    updated.salaryPeriod = ai.salaryPeriod;
  }

  // --- Keywords: use AI result, then deterministic cleanup as safety net ---
  if (ai.keywords) {
    updated.keywords = cleanKeywords(ai.keywords);
  } else {
    updated.keywords = cleanKeywords(row.keywords);
  }

  // --- Skills: use AI result, then deterministic cleanup as safety net ---
  if (ai.skills) {
    updated.skills = cleanSkills(ai.skills);
  } else {
    updated.skills = cleanSkills(row.skills);
  }

  return updated;
}

// ─── Concurrency helper ───────────────────────────────────────────

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

// ─── Main ─────────────────────────────────────────────────────────

async function main(): Promise<void> {
  await loadEnv();
  const options = parseCliOptions();
  const inputPath = path.resolve(process.cwd(), options.input);
  const outputPath = path.resolve(process.cwd(), options.output);

  console.log(`[INFO] Model: ${options.model}`);
  console.log(`[INFO] Reading CSV: ${inputPath}`);
  const csvContent = await readFile(inputPath, "utf8");
  let rows = parseCsvContent(csvContent);
  console.log(`[INFO] Parsed ${rows.length} jobs from CSV`);

  // ── Pre-processing: Deduplication ──
  console.log(`\n[INFO] === Pre-processing: Deduplication ===`);
  const dedupResult = deduplicateRows(rows);
  rows = dedupResult.kept;
  console.log(`[INFO] URL dupes removed: ${dedupResult.urlDupes}`);
  console.log(`[INFO] Cross-domain dupes removed: ${dedupResult.crossDomainDupes}`);
  console.log(`[INFO] Rows after dedup: ${rows.length}`);

  // ── Pre-processing: Invalid job removal ──
  console.log(`\n[INFO] === Pre-processing: Invalid Job Removal ===`);
  const filterResult = preFilterInvalidJobs(rows);
  rows = filterResult.kept;
  console.log(`[INFO] Invalid jobs removed: ${filterResult.removed}`);
  console.log(`[INFO] Rows after filtering: ${rows.length}`);

  if (options.maxJobs) {
    rows = rows.slice(0, options.maxJobs);
    console.log(`[INFO] Limited to ${rows.length} jobs (--maxJobs)`);
  }

  const enrichedRows: CsvJobRow[] = [];
  let aiFixed = 0;
  let dropped = 0;
  let aiFailed = 0;

  await runConcurrent(rows, options.concurrency, async (row, index) => {
    try {
      const messages = buildEnrichmentPrompt(row);
      const rawResponse = await gptChat(options.apiKey, options.model, messages, 60_000);
      const aiResult = parseAiResponse(rawResponse);

      if (!aiResult) {
        console.log(`[WARN] Row ${index + 1} (${row.title.slice(0, 40)}): AI parse failed, keeping original`);
        aiFailed++;
        row.jobType = normalizeJobType(row.jobType);
        row.workType = normalizeWorkType(row.workType);
        row.keywords = cleanKeywords(row.keywords);
        row.skills = cleanSkills(row.skills);
        if (row.salaryMin === "0") row.salaryMin = "";
        if (row.salaryMax === "0") row.salaryMax = "";
        enrichedRows.push(row);
        return;
      }

      if (aiResult.shouldDrop) {
        // Safety net: if the title looks like a real job title or the URL looks
        // like a specific job posting, override the drop and keep with fallback desc
        const titleLooksReal = row.title.length > 3 &&
          !/^(careers|jobs|home|404|error|cookie|login|select|current openings|open roles)/i.test(row.title.trim()) &&
          !ALWAYS_DROP_TITLES.has(row.title.toLowerCase().trim());
        const urlLooksReal = isSpecificJobUrl(row.jobLink);

        if (titleLooksReal || urlLooksReal) {
          console.log(`[KEEP] Row ${index + 1}: "${row.title.slice(0, 50)}" — AI wanted to drop but title/URL look legit, using fallback desc`);
          aiResult.shouldDrop = false;
          if (!aiResult.description || aiResult.description.length < 30) {
            aiResult.description = "For more details, click apply";
          }
        } else {
          console.log(`[DROP] Row ${index + 1}: "${row.title.slice(0, 50)}" | ${row.jobLink.slice(0, 60)}`);
          dropped++;
          return;
        }
      }

      const updated = applyEnrichment(row, aiResult);
      enrichedRows.push(updated);
      aiFixed++;

      const processed = aiFixed + aiFailed;
      if (processed % 10 === 0) {
        console.log(`[INFO] Progress: ${processed + dropped}/${rows.length} (${aiFixed} enriched, ${dropped} dropped, ${aiFailed} fallback)`);
      }
    } catch (err) {
      console.log(`[WARN] Row ${index + 1} (${row.title.slice(0, 40)}): Error - ${err instanceof Error ? err.message : err}`);
      aiFailed++;
      row.jobType = normalizeJobType(row.jobType);
      row.workType = normalizeWorkType(row.workType);
      row.keywords = cleanKeywords(row.keywords);
      row.skills = cleanSkills(row.skills);
      if (row.salaryMin === "0") row.salaryMin = "";
      if (row.salaryMax === "0") row.salaryMax = "";
      enrichedRows.push(row);
    }
  });

  console.log(`\n[INFO] Enrichment complete:`);
  console.log(`  Total input:  ${rows.length}`);
  console.log(`  Enriched:     ${aiFixed}`);
  console.log(`  AI failed:    ${aiFailed} (kept with basic validation)`);
  console.log(`  Dropped:      ${dropped}`);
  console.log(`  Final output: ${enrichedRows.length}`);

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
