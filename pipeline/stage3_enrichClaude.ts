/**
 * Claude Haiku job enrichment pipeline (Stage 3).
 *
 * Reads the Stage 2 CSV and sends each row through Claude Haiku 4.5 via the
 * Claude Agent SDK in-process (billed to the Max plan, NOT an API key) to validate/fix:
 *   a) title        – clean (req-IDs, bilingual dupes, suffixes, emojis) + fix generic titles
 *   b) description  – strip noise, keep only job-relevant info, format into clean HTML
 *   c) jobType      – validate against allowed values, default FULLTIME
 *   d) workType     – validate against allowed values, fix or clear
 *   e) location     – validate/fix from the job description
 *   f) company      – fix when clearly wrong (ATS slug, "Careers", tenant code)
 *   g) keywords     – clean, comma-separated category tags
 *   h) skills       – clean phrase-like entries, comma-separated
 *
 * Pre-processing: URL dedup + cross-domain dedup + invalid-job prefilter +
 *   hardcoded gen-AI company blocklist (free pre-drop).
 * Drop a row when EITHER: (1) the title AND jobLink are both irrelevant to a real
 *   posting, OR (2) the company's core moat is building generative-AI models or
 *   collecting/labeling/selling training data for gen-AI. Companies that merely USE
 *   AI tools (Adobe, Canva, Figma, etc.) are kept.
 *
 * Auth: the Agent SDK uses the same subscription login as Claude Code — no ANTHROPIC_API_KEY.
 *   systemPrompt (string) replaces the default prompt; allowedTools:[]/strictMcpConfig/
 *   settingSources:[]/maxTurns:1 strip tool+MCP+config scaffolding for API-parity tokens.
 *
 * IMPORTANT - CSV / Excel safety:
 *   The description field is rendered as HTML in the web app via a RichTextRenderer.
 *   For CSV compatibility, the description MUST be a compact single-line HTML string —
 *   no raw newlines inside the HTML content. Enforced in the prompt and post-processing.
 *
 * Usage:
 *   npx tsx pipeline/stage3_enrichClaude.ts [options]
 *
 * Options:
 *   --input <path>         CSV input (default: outputs/api-ready/latest/results_enriched_api.csv)
 *   --output <path>        CSV output (default: outputs/api-ready/latest/results_enriched_api_claude.csv)
 *   --concurrency <n>      Parallel claude calls (default: 8)
 *   --maxJobs <n>          Process at most N jobs (use for smoke tests)
 *   --model <name>         Claude model (default: claude-haiku-4-5)
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { query } from "@anthropic-ai/claude-agent-sdk";

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
  createdAt: string;
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
    output: getArg("--output") ?? "outputs/api-ready/latest/results_enriched_api_claude.csv",
    // Default lowered 8→4 as a CLOUD proxy-pressure workaround; raise back to 8+
    // when running LOCALLY. See docs/JobsDrop2.1 "Cloud vs Local" section.
    concurrency: Number(getArg("--concurrency") ?? "4"),
    maxJobs: getArg("--maxJobs") ? Number(getArg("--maxJobs")) : null,
    model: getArg("--model") ?? "claude-haiku-4-5",
  };
}

// ─── CSV Parsing ──────────────────────────────────────────────────

const CSV_HEADERS: (keyof CsvJobRow)[] = [
  "title", "description", "jobType", "deadline", "keywords", "skills",
  "jobLink", "hiringTeam", "workType", "workEmail", "createdAt",
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

// ─── Gen-AI company blocklist (free pre-drop) ─────────────────────
// Distinctive name fragments of companies whose CORE moat is building
// generative-AI models OR collecting/labeling/selling training data for gen-AI.
// Substring match on the lowercased company name. Kept distinctive to avoid
// false positives (e.g. "scale ai", not bare "scale"). Haiku catches the rest.
const GENAI_COMPANY_BLOCKLIST = [
  "openai", "anthropic", "deepmind", "mistral ai", "cohere", "ai21",
  "stability ai", "midjourney", "runwayml", "runway ml", "higgsfield",
  "x.ai", "xai labs", "scale ai", "surge ai", "surgehq", "mercor",
  "labelbox", "snorkel ai", "hugging face", "perplexity ai",
  "character.ai", "character ai", "inflection ai", "adept ai",
  "together ai", "appen", "sama ai", "invisible technologies",
];

function isBlocklistedGenAiCompany(company: string): boolean {
  const n = (company ?? "").toLowerCase().trim();
  if (!n) return false;
  return GENAI_COMPANY_BLOCKLIST.some((token) => n.includes(token));
}

// ─── Deterministic title cleanup (conservative; Haiku does the rest) ──
function cleanJobTitle(raw: string): string {
  let t = (raw ?? "").trim();
  if (!t) return t;
  // strip surrounding quotes
  t = t.replace(/^["'“”]+|["'“”]+$/g, "").trim();
  // strip emoji / symbol blocks
  t = t.replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE00}-\u{FEFF}]/gu, " ");
  // remove requisition / job IDs: (#1234), REQ-1234, JR0012345, "- 123456"
  t = t.replace(/[#(]?\b(?:req|requisition|job|jr|r)\s*[-#]?\s*\d{3,}\b\)?/gi, " ");
  t = t.replace(/\(\s*#?\s*\d{3,}\s*\)/g, " ");
  t = t.replace(/\s[-–—]\s*\d{4,}\s*$/g, " ");
  // collapse whitespace + trim stray separators
  t = t.replace(/\s{2,}/g, " ").replace(/^[\s\-–—|•,]+|[\s\-–—|•,]+$/g, "").trim();
  return t || (raw ?? "").trim();
}

// ─── Claude CLI (Max-plan subscription, no API key) ───────────────

interface ClaudeUsage {
  inputTokens: number;
  outputTokens: number;
}

/**
 * Run one Haiku enrichment via the Claude Agent SDK (in-process — no per-row CLI
 * cold-start). Billed to the Max-plan subscription (no ANTHROPIC_API_KEY).
 * - systemPrompt (string) REPLACES the default Claude Code prompt → lean tokens
 * - allowedTools:[] + strictMcpConfig + settingSources:[] strip all tool/MCP/config
 *   scaffolding, so each call ≈ system prompt + row + output
 * - maxTurns:1 — a single transform, no agentic loop
 */
async function claudeEnrich(
  systemPrompt: string,
  userPrompt: string,
  model: string,
  timeoutMs = 60_000,
): Promise<{ text: string; usage: ClaudeUsage }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    let result: any = null;
    const msgTypes: string[] = [];
    let assistantChars = 0;
    let lastAssistantText = "";
    try {
      for await (const msg of query({
        prompt: userPrompt,
        options: {
          systemPrompt,
          model,
          maxTurns: 2,
          allowedTools: [],
          strictMcpConfig: true,
          mcpServers: {},
          settingSources: [],
          thinking: { type: "disabled" },
          abortController: ac,
        },
      })) {
        const m = msg as any;
        msgTypes.push(m.type);
        if (m.type === "assistant" && Array.isArray(m.message?.content)) {
          for (const b of m.message.content) {
            if (b?.type === "text" && typeof b.text === "string") {
              assistantChars += b.text.length;
              lastAssistantText = b.text;
            }
          }
        }
        if (m.type === "result") result = m;
      }
    } catch (err) {
      if (process.env.STAGE3_DEBUG) {
        const assistantTurns = msgTypes.filter((t) => t === "assistant").length;
        console.error(`[DEBUG-THROW] ${err instanceof Error ? err.message : String(err)} | assistantTurns=${assistantTurns} types=[${msgTypes.join(",")}] assistantChars=${assistantChars} tail=${JSON.stringify(lastAssistantText.slice(-200))}`);
      }
      throw err;
    }
    if (!result) throw new Error("claude SDK: no result message returned");
    if (result.is_error || result.subtype !== "success") {
      if (process.env.STAGE3_DEBUG) {
        console.error(`[DEBUG-FAIL] subtype=${result.subtype} num_turns=${result.num_turns} stop_reason=${result.stop_reason} assistantChars=${assistantChars} types=[${msgTypes.join(",")}] tail=${JSON.stringify(lastAssistantText.slice(-160))}`);
      }
      const detail = Array.isArray(result.errors) ? result.errors.join("; ") : result.subtype;
      throw new Error(`claude SDK error: ${detail}`.slice(0, 200));
    }
    return {
      text: result.result ?? "",
      usage: {
        inputTokens: result.usage?.input_tokens ?? 0,
        outputTokens: result.usage?.output_tokens ?? 0,
      },
    };
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
  return fixMojibake(keywords).split(/[,|]/).map(k => k.trim()).filter(k => {
    if (!k) return false;
    if (/<[^>]+>/.test(k)) return false;
    if (k.length > 50) return false;
    if (/^(or |and |such as |with |including |ideally |preferably )/.test(k.toLowerCase())) return false;
    return true;
  }).join(", ");
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
  return fixMojibake(skills).split(/[,|]/).map(s => s.trim()).filter(s => {
    if (!s) return false;
    return !isPhraseLikeSkill(s);
  }).join(", ");
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

function buildSystemPrompt(): string {
  return `You are a job listing data quality assistant. Review and fix the provided job listing fields.

RULES:

1. TITLE: Keep if it's a real job title. If it's a generic careers-page heading (e.g. "Asana Careers"), cookie notice, 404 page, person name, or otherwise not a real job title, infer the correct title from the description or URL. If you cannot determine a real title, set it to "INVALID".
   Also CLEAN the title: remove requisition/job IDs (e.g. "#12345", "REQ-1234", "JR0012345"), remove trailing location or contract-type suffixes (e.g. "(Remote)", "- 12 month FTC", "(m/f/d)"), collapse duplicated bilingual halves into one language (e.g. "Animateur Lead Mocap/Lead Mocap Animator" → "Lead Mocap Animator"), and remove any emojis. Keep the core role title only.

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
   - A brief "About Company" summary of what the company does — drawn ONLY from the job description (do not invent facts; if the description has no company background, omit this section)

   FORMAT rules (CRITICAL for CSV/Excel compatibility):
   - Use ONLY these HTML tags: <p>, <ul>, <ol>, <li>, <strong>, <em>, <br>
   - Do NOT use heading tags (<h1>, <h2>, <h3>, etc.). Instead, use <p><strong>Section Title</strong></p> for section headings.
   - Put a <br> immediately before EVERY section heading EXCEPT the first, for visual spacing: <p><br><strong>Responsibilities</strong></p>. The first section heading has no leading <br>.
   - <strong> must ONLY be used for section heading labels (e.g. "About the Role", "Responsibilities", "Requirements"). Do NOT bold regular body text, list items, or sub-labels.
   - Every block of text MUST be wrapped in a <p> tag. Never leave bare text between sections or lists.
   - Wrap each section's intro/body text in <p> tags for proper spacing.
   - IMPORTANT: Each new paragraph or section MUST be in its own <p> tag to ensure proper line spacing between paragraphs. Do NOT combine multiple paragraphs into a single <p> tag.
   - Remove all emojis from the output. Do not include emoji characters anywhere in the description.
   - Fix or remove any garbled "mojibake" characters caused by bad encoding (e.g. "â€"", "â€™", "â€œ", "Â"). Replace with the correct punctuation ("-", "'", double-quote) or delete them.
   - Section order: About Company FIRST, then About the Role, Responsibilities, Requirements. (If there is no company background in the description, omit About Company and start with About the Role.)
   - Structure example: <p><strong>About Company</strong></p><p>Acme builds developer tools used by millions...</p><p><br><strong>About the Role</strong></p><p>We are looking for a skilled engineer...</p><p><br><strong>Responsibilities</strong></p><ul><li>Lead design projects</li><li>Collaborate with teams</li></ul><p><br><strong>Requirements</strong></p><ul><li>5+ years experience</li><li>Strong portfolio</li></ul>
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

7. DROP: set "shouldDrop" to true and set "dropReason" in EITHER of these cases:
   (a) "INVALID": the title is NOT a real job title AND cannot be fixed from context, AND the jobLink does NOT look like a real job posting URL (careers listing page, homepage, or error page). If EITHER the title looks like a real job title OR the URL looks like a specific job posting URL, do NOT drop for this reason.
       Examples of real job URLs: contains /job/, /careers/specific-role, /position/, or a job ID in the path.
       Example: title="Design Engineer" + url="https://company.com/careers/design-engineer-x3mbzomt96" → do NOT drop, this is clearly a real job.
   (b) "GENAI_COMPANY": drop ONLY when ONE of these is clearly true:
       - the hiring company's CORE business is building generative-AI foundation models (AI research labs / foundation-model / image-or-video-gen-model companies — e.g. OpenAI, Anthropic, Mistral, Ideogram, Higgsfield), OR
       - the company's CORE business is collecting / labeling / selling training data for gen-AI (e.g. Scale AI, Surge AI, Mercor), OR
       - the ROLE itself is an AI-training / data-labeling role for gen-AI (e.g. titles containing "AI Trainer", "AI Data Annotator", "RLHF", "data labeling").
     Do NOT drop a company just because it uses AI, ships an AI feature, has an "AI" team or product line, or builds AI hardware/chips/infrastructure. KEEP these:
       - Normal product/creative companies with AI features (Adobe, Canva, Figma, Notion)
       - Defense, hardware, robotics, semiconductor/chip companies (building chips or hardware is NOT building gen-AI models — e.g. an RTL/test-equipment engineering role)
       - Recruiting/career, sales, marketing, fintech, or other SaaS platforms that merely have an AI product line
     When uncertain, KEEP the row (do not drop).
   If neither applies, set "shouldDrop": false and "dropReason": "".

8. DESCRIPTION FALLBACK: If you cannot extract meaningful job description content (the source is mostly noise, a login wall, or a redirect page), set description to exactly: "For more details, click apply"
   Do NOT drop a row just because the description is poor — only drop based on rule 7 above.

9. KEYWORDS (tags): Return cleaned keywords as a COMMA-SEPARATED list of short category labels.
   - Pick 3-7 relevant tags from this vocabulary: ${VALID_TAG_VOCABULARY.join(", ")}
   - You may add 1-2 tags outside the vocabulary if highly relevant, but keep them short (1-3 words max)
   - Remove any HTML, sentence fragments, or entries longer than 50 characters
   - If the current keywords are already good, return them unchanged

10. SKILLS: Return cleaned skills as a COMMA-SEPARATED list of lowercase_underscore entries.
   - A valid skill is a tool, technology, methodology, or concrete competency that could appear on a resume (e.g. "figma", "design_systems", "ux_research", "prototyping", "adobe_creative_suite", "motion_graphics", "html", "css", "javascript", "typography", "branding")
   - REMOVE anything that is:
     - A sentence fragment or phrase (e.g. "as_well_as_research", "align_with_our_needs", "the_future_of_creative", "execution_at_an_agency", "ability_to_track_metrics", "interaction_models_for_chatbots", "metrics_to_determine", "to_build_models")
     - A degree or qualification (e.g. "bachelor_s_degree", "master_s_degree")
     - A truncated/broken string (e.g. "-_speak", "-_j", "a_amp")
     - A generic soft trait (e.g. "self-motivated", "attention_to_detail", "are_a_fit", "to_grow")
     - A protected class or legal phrase (e.g. "without_regard_to_race", "disability")
   - Keep 3-10 valid skills. If few valid skills remain after cleaning, that's fine — don't invent skills
   - If the current skills are already clean, return them unchanged

11. COMPANY: Review the company name. If it is clearly wrong — an ATS slug, a tenant code, "Careers"/"Jobs", or empty — and the job description clearly names the employer, set "company" to the correct name. Otherwise return the company unchanged.

Respond with ONLY a valid JSON object (no markdown fences, no explanation):
{
  "shouldDrop": false,
  "dropReason": "",
  "title": "...",
  "description": "...",
  "jobType": "FULLTIME",
  "workType": "REMOTE",
  "company": "...",
  "locationName": "...",
  "formattedAddress": "...",
  "city": "...",
  "state": "...",
  "country": "",
  "salaryMin": "",
  "salaryMax": "",
  "salaryCurrency": "",
  "salaryPeriod": "",
  "keywords": "design, ux, product design",
  "skills": "figma, prototyping, design_systems"
}`;
}

function buildUserPrompt(row: CsvJobRow): string {
  return `Review this job listing:

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
${fixMojibake(decodeHtmlEntities(row.description)).slice(0, 8000)}`;
}

// ─── Parse AI response ────────────────────────────────────────────

interface AiEnrichResult {
  shouldDrop: boolean;
  dropReason: string;
  title: string;
  description: string;
  jobType: string;
  workType: string;
  company: string;
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
  // Remove markdown fences (Claude often wraps JSON in ```json ... ```)
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

  const jsonStart = cleaned.indexOf("{");
  const jsonEnd = cleaned.lastIndexOf("}");
  if (jsonStart === -1 || jsonEnd === -1) return null;
  cleaned = cleaned.slice(jsonStart, jsonEnd + 1);

  try {
    const parsed = JSON.parse(cleaned);
    return {
      shouldDrop: Boolean(parsed.shouldDrop),
      dropReason: String(parsed.dropReason ?? ""),
      title: String(parsed.title ?? ""),
      description: String(parsed.description ?? ""),
      jobType: String(parsed.jobType ?? "FULLTIME"),
      workType: String(parsed.workType ?? ""),
      company: String(parsed.company ?? ""),
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

// Fix UTF-8-as-Latin-1 mojibake (e.g. "â€“"->"–", "â€™"->"'") then normalize
// smart punctuation to ASCII. Mirrors the Stage 2 cleaner; leaves accented
// letters (é, ñ, …) untouched so French/Spanish names survive.
function fixMojibake(str: string): string {
  return str
    .replace(/â€™/g, "’")
    .replace(/â€˜/g, "‘")
    .replace(/â€œ/g, "“")
    .replace(/â€/g, "”")
    .replace(/â€”/g, "—")
    .replace(/â€“/g, "–")
    .replace(/â€¦/g, "…")
    .replace(/Â /g, " ")
    .replace(/Â·/g, "·")
    .replace(/â€​/g, "")
    .replace(/â[-]/g, "-")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...");
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
    updated.title = fixMojibake(ai.title);
  }

  // Company: overwrite only when AI returns a non-empty, different value
  if (ai.company && ai.company.trim()) {
    const aiCompany = fixMojibake(ai.company.trim());
    if (aiCompany.toLowerCase() !== (row.company ?? "").trim().toLowerCase()) {
      updated.company = aiCompany;
    }
  }

  if (ai.description && ai.description.length > 30) {
    updated.description = fixMojibake(ensureParagraphSpacing(toSingleLineHtml(stripEmojis(ai.description))));
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

  // ── Pre-processing: gen-AI company blocklist (free pre-drop) ──
  const droppedRows: { title: string; company: string; jobLink: string; reason: string }[] = [];
  const afterBlocklist: CsvJobRow[] = [];
  for (const row of rows) {
    if (isBlocklistedGenAiCompany(row.company)) {
      droppedRows.push({ title: row.title, company: row.company, jobLink: row.jobLink, reason: "GENAI_COMPANY (blocklist)" });
    } else {
      afterBlocklist.push(row);
    }
  }
  rows = afterBlocklist;
  console.log(`[INFO] Gen-AI blocklist pre-drops: ${droppedRows.length}`);
  console.log(`[INFO] Rows after blocklist: ${rows.length}`);

  if (options.maxJobs) {
    rows = rows.slice(0, options.maxJobs);
    console.log(`[INFO] Limited to ${rows.length} jobs (--maxJobs)`);
  }

  const enrichedRows: CsvJobRow[] = [];
  let aiFixed = 0;
  let dropped = 0;
  let aiFailed = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  // The system prompt is static — build once, reuse for every SDK call.
  const systemPrompt = buildSystemPrompt();

  // ── Checkpoint/resume (CLOUD survivability) ──
  // Haiku enrichment is the expensive step; through a rotating proxy a multi-hour
  // run would die and re-burn tokens from zero. Persist each finalised row
  // (kept = enriched CsvJobRow, dropped = null) keyed by jobLink, flush every 200,
  // and resume by skipping rows already in the cache.
  const cachePath = `${outputPath}.cache.json`;
  const keyOf = (r: CsvJobRow): string => (r.jobLink ?? "").trim().toLowerCase() || `${r.title}|${r.company}`.toLowerCase();
  const cache = new Map<string, CsvJobRow | null>();
  try {
    const rawCache: unknown = JSON.parse(await readFile(cachePath, "utf8"));
    if (Array.isArray(rawCache)) {
      for (const e of rawCache) {
        if (e && typeof e.key === "string") cache.set(e.key, (e.row as CsvJobRow) ?? null);
      }
    }
  } catch { /* no cache yet */ }
  if (cache.size > 0) {
    for (const v of cache.values()) if (v) enrichedRows.push(v);
    console.log(`[INFO] Stage 3 resuming from cache: ${cache.size} done (${enrichedRows.length} kept)`);
  }

  let sinceFlush = 0;
  let flushing = false;
  const flushCache = async (): Promise<void> => {
    if (flushing) return;
    flushing = true;
    try {
      await mkdir(path.dirname(cachePath), { recursive: true });
      const arr = [...cache.entries()].map(([key, row]) => ({ key, row }));
      const tmp = `${cachePath}.tmp`;
      await writeFile(tmp, JSON.stringify(arr), "utf8");
      await rename(tmp, cachePath);
    } finally {
      flushing = false;
    }
  };
  const maybeFlush = async () => { if (++sinceFlush >= 25) { sinceFlush = 0; await flushCache(); } };
  const keep = async (r: CsvJobRow) => { enrichedRows.push(r); cache.set(keyOf(r), r); await maybeFlush(); };
  const drop = async (r: CsvJobRow) => { cache.set(keyOf(r), null); await maybeFlush(); };

  const todo = rows.filter((r) => !cache.has(keyOf(r)));
  console.log(`[INFO] Stage 3 enrichment plan: ${rows.length} total, ${rows.length - todo.length} cached, ${todo.length} to enrich`);

  // Circuit breaker: when the egress proxy rotates, every SDK call fails. Count
  // consecutive network failures; once too many, the proxy is dead — flush and
  // exit(2) so the supervisor restarts with a fresh proxy. We do NOT cache these
  // failed rows as fallback (that would poison the cache with uncleaned jobs);
  // they stay in `todo` and get a real Haiku pass on the next run.
  let consecutiveNetFails = 0;
  const NET_FAIL_LIMIT = 12;

  {
    await runConcurrent(todo, options.concurrency, async (row, index) => {
      // Deterministic title cleanup before sending to the model
      row.title = cleanJobTitle(row.title);

      // Helper: apply deterministic normalisation when AI is unavailable.
      // Better than raw passthrough — at least the structured fields are clean.
      const applyFallback = async () => {
        row.jobType = normalizeJobType(row.jobType);
        row.workType = normalizeWorkType(row.workType);
        row.keywords = cleanKeywords(row.keywords);
        row.skills = cleanSkills(row.skills);
        if (row.salaryMin === "0") row.salaryMin = "";
        if (row.salaryMax === "0") row.salaryMax = "";
        if (!row.description || row.description.trim().length < 20) {
          row.description = "For more details, click apply";
        }
        await keep(row);
      };

      try {
        const userPrompt = buildUserPrompt(row);
        let text: string | null = null;
        let usage: ClaudeUsage = { inputTokens: 0, outputTokens: 0 };

        // One retry with a 3 s back-off for transient network / timeout errors.
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            const result = await claudeEnrich(systemPrompt, userPrompt, options.model);
            text = result.text;
            usage = result.usage;
            break;
          } catch (err) {
            if (attempt === 2) throw err;
            const msg = err instanceof Error ? err.message : String(err);
            console.log(`[WARN] Row ${index + 1} attempt ${attempt} failed (${msg.slice(0, 80)}), retrying in 3 s…`);
            await new Promise((r) => setTimeout(r, 3_000));
          }
        }

        consecutiveNetFails = 0; // a response came back — proxy is alive
        totalInputTokens += usage.inputTokens;
        totalOutputTokens += usage.outputTokens;
        const aiResult = text ? parseAiResponse(text) : null;

        if (!aiResult) {
          console.log(`[WARN] Row ${index + 1} (${row.title.slice(0, 40)}): AI parse failed, applying deterministic fallback`);
          aiFailed++;
          await applyFallback();
          return;
        }

        if (aiResult.shouldDrop) {
          // Gen-AI company drops are always honored (never overridden).
          if (aiResult.dropReason === "GENAI_COMPANY") {
            console.log(`[DROP gen-AI] Row ${index + 1}: "${row.title.slice(0, 50)}" | ${row.company}`);
            droppedRows.push({ title: row.title, company: row.company, jobLink: row.jobLink, reason: "GENAI_COMPANY (haiku)" });
            dropped++;
            await drop(row);
            return;
          }
          // INVALID drops: safety net — keep if title or URL clearly looks real.
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
            console.log(`[DROP invalid] Row ${index + 1}: "${row.title.slice(0, 50)}" | ${row.jobLink.slice(0, 60)}`);
            droppedRows.push({ title: row.title, company: row.company, jobLink: row.jobLink, reason: "INVALID" });
            dropped++;
            await drop(row);
            return;
          }
        }

        const updated = applyEnrichment(row, aiResult);
        await keep(updated);
        aiFixed++;

        const processed = aiFixed + aiFailed;
        if (processed % 10 === 0) {
          console.log(`[INFO] Progress: ${processed + dropped}/${rows.length} (${aiFixed} enriched, ${dropped} dropped, ${aiFailed} fallback)`);
        }
      } catch (err) {
        // Reached only when both attempts threw → treat as a network/proxy failure.
        // Do NOT cache (no poisoning); leave the row in todo for the next run.
        consecutiveNetFails++;
        console.log(`[WARN] Row ${index + 1} (${row.title.slice(0, 40)}): network error (${consecutiveNetFails}/${NET_FAIL_LIMIT}) - ${err instanceof Error ? err.message.slice(0, 60) : err}`);
        if (consecutiveNetFails >= NET_FAIL_LIMIT) {
          console.error(`[FATAL] ${NET_FAIL_LIMIT} consecutive network failures — proxy likely rotated. Flushing and exiting for supervisor restart.`);
          await flushCache();
          process.exit(2);
        }
      }
    });
  }

  await flushCache(); // persist final state

  console.log(`\n[INFO] Enrichment complete:`);
  console.log(`  Enriched:     ${aiFixed}`);
  console.log(`  AI failed:    ${aiFailed} (kept with basic validation)`);
  console.log(`  Dropped total: ${droppedRows.length} (gen-AI + invalid)`);
  console.log(`  Final output: ${enrichedRows.length}`);
  console.log(`  Tokens:       ${totalInputTokens} in / ${totalOutputTokens} out (billed to Max-plan subscription)`);

  const outputDir = path.dirname(outputPath);
  await mkdir(outputDir, { recursive: true });
  await writeFile(outputPath, allRowsToCsv(enrichedRows), "utf8");
  console.log(`[INFO] Written to: ${outputPath}`);

  // Write a dropped-rows audit alongside the output
  if (droppedRows.length > 0) {
    const dropPath = outputPath.replace(/\.csv$/i, "_dropped.csv");
    const dropCsv = ["title,company,jobLink,reason",
      ...droppedRows.map(d => [d.title, d.company, d.jobLink, d.reason].map(csvEscape).join(","))].join("\n");
    await writeFile(dropPath, dropCsv, "utf8");
    console.log(`[INFO] Dropped audit (${droppedRows.length}) written to: ${dropPath}`);
  }
}

const directRunHref = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === directRunHref) {
  main().catch((error) => {
    console.error("[FATAL]", error);
    process.exit(1);
  });
}
