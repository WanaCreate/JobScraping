/**
 * Quality review for enriched job records.
 *
 * Two-tier approach:
 *   1. Heuristic checks (fast, free) — run on every job
 *   2. AI review (slow, costs tokens) — only for ambiguous cases heuristics can't judge
 *
 * Each job gets a verdict: "ok" | "fixed" | "dropped"
 * Fixed jobs are patched in-place; dropped jobs are removed from the output.
 */

import type {
  ApiCreateJobRequest,
  JobTypeValue,
  WorkTypeValue,
} from "../types.js";
import { logInfo, logWarn } from "./logger.js";

// ─── Types ───────────────────────────────────────────────────────

export type ReviewVerdict = "ok" | "fixed" | "dropped";

export interface ReviewIssue {
  field: string;
  problem: string;
  action: "ignored" | "fixed" | "dropped";
  before?: string;
  after?: string;
}

export interface ReviewResult {
  verdict: ReviewVerdict;
  issues: ReviewIssue[];
}

export interface ReviewStats {
  total: number;
  ok: number;
  fixed: number;
  dropped: number;
  issues: ReviewIssue[];
}

export interface PipelineInstruction {
  field: string;
  frequency: number;
  pattern: string;
  action: "ignored" | "fixed" | "dropped";
  instruction: string;
}

// ─── Constants ───────────────────────────────────────────────────

/** Titles that are clearly not job postings */
const TITLE_BLOCKLIST = [
  /^(cookie|privacy|terms|login|sign\s*in|sign\s*up|register|404|error|not\s*found|forbidden|access\s*denied)/i,
  /^(undefined|null|nan|true|false|object\s*object)$/i,
  /^(h[1-6]|div|span|p|li|a|td|tr|th|button|input|label|select|form|nav|header|footer)$/i,
  /^(home|about|contact|careers|jobs|apply|search|menu|back)$/i,
  /^(loading|please\s*wait|redirecting|page\s*not\s*found)$/i,
];

/** Company names that are generic/wrong — derived from URL subdomains or ATS platforms */
const GENERIC_COMPANY_NAMES = new Set([
  "careers", "career", "jobs", "job", "job-boards", "boards", "apply",
  "hire", "hiring", "work", "greenhouse", "lever", "workday",
  "smartrecruiters", "ashby", "icims", "jobvite", "taleo",
]);

/** Description patterns that indicate scraped wrong content */
const DESCRIPTION_BLOCKLIST = [
  /^(accept\s*(all\s*)?cookies|we\s*use\s*cookies|this\s*site\s*uses\s*cookies)/i,
  /^(please\s*(log\s*in|sign\s*in)|you\s*must\s*(log|sign)\s*in)/i,
  /^(page\s*not\s*found|404|error|access\s*denied|forbidden)/i,
  /^(javascript\s*(is\s*)?(required|must\s*be\s*enabled|disabled))/i,
];

/** Suffixes to strip from titles */
const TITLE_STRIP_SUFFIXES = [
  /\s*[-–|@]\s*(apply\s*(now|here|today)|lever|greenhouse|workday|ashby|smartrecruiters|indeed|linkedin|glassdoor|careers?)\s*$/i,
  /\s*[-–|]\s*[A-Za-z0-9\s&.']+careers?\s*$/i,
  /\s*\|\s*linkedin\s*$/i,
];

/** Junk patterns in location fields */
const LOCATION_JUNK = [
  /^(n\/?a|none|not\s*specified|undefined|null|tbd|various|multiple|anywhere)$/i,
];

// ─── Heuristic Checks ───────────────────────────────────────────

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function reviewTitle(job: ApiCreateJobRequest, issues: ReviewIssue[]): ReviewVerdict | null {
  const title = job.title.trim();

  // Empty or too short
  if (!title || title.length < 3) {
    issues.push({ field: "title", problem: "Empty or too short", action: "dropped" });
    return "dropped";
  }

  // Too long (likely scraped wrong element)
  if (title.length > 200) {
    issues.push({ field: "title", problem: "Title too long (>200 chars), likely scraped wrong element", action: "dropped" });
    return "dropped";
  }

  // Blocklisted
  for (const pattern of TITLE_BLOCKLIST) {
    if (pattern.test(title)) {
      issues.push({ field: "title", problem: `Title matches blocklist: "${title}"`, action: "dropped" });
      return "dropped";
    }
  }

  // Strip junk suffixes
  let cleaned = title;
  for (const suffix of TITLE_STRIP_SUFFIXES) {
    cleaned = cleaned.replace(suffix, "");
  }
  if (cleaned !== title && cleaned.length >= 3) {
    issues.push({ field: "title", problem: "Title had junk suffix", action: "fixed", before: title, after: cleaned });
    job.title = cleaned;
    return "fixed";
  }

  return null;
}

function reviewDescription(job: ApiCreateJobRequest, issues: ReviewIssue[]): ReviewVerdict | null {
  const plainDesc = stripHtml(job.description);

  // Empty or placeholder
  if (!plainDesc || plainDesc.length < 30) {
    issues.push({ field: "description", problem: "Description too short or empty", action: "dropped" });
    return "dropped";
  }

  // Placeholder text
  if (/^for job details/i.test(plainDesc) || /^see job details/i.test(plainDesc)) {
    issues.push({ field: "description", problem: "Placeholder description", action: "dropped" });
    return "dropped";
  }

  // Blocklisted content (scraped cookies banner, login wall, etc.)
  for (const pattern of DESCRIPTION_BLOCKLIST) {
    if (pattern.test(plainDesc)) {
      issues.push({ field: "description", problem: `Description matches blocklist (scraped wrong content): "${plainDesc.slice(0, 80)}..."`, action: "dropped" });
      return "dropped";
    }
  }

  // Description is suspiciously short (30-80 chars) — flag but keep
  if (plainDesc.length < 80) {
    issues.push({ field: "description", problem: `Description is very short (${plainDesc.length} chars)`, action: "ignored" });
  }

  return null;
}

function reviewJobType(job: ApiCreateJobRequest, issues: ReviewIssue[]): ReviewVerdict | null {
  const validTypes = new Set(["GIG", "FULLTIME", "PARTTIME", "FREELANCE"]);
  if (!validTypes.has(job.jobType)) {
    issues.push({ field: "jobType", problem: `Invalid jobType: "${job.jobType}"`, action: "fixed", before: job.jobType, after: "FULLTIME" });
    job.jobType = "FULLTIME";
    return "fixed";
  }

  // Cross-check jobType against title+description keywords
  const combined = `${job.title} ${stripHtml(job.description)}`.toLowerCase();
  const inferred = inferJobTypeFromText(combined);

  if (inferred && inferred !== job.jobType) {
    // Only override if current is default FULLTIME and we have strong signal
    if (job.jobType === "FULLTIME" && inferred !== "FULLTIME") {
      issues.push({ field: "jobType", problem: `jobType was FULLTIME but text strongly suggests ${inferred}`, action: "fixed", before: job.jobType, after: inferred });
      job.jobType = inferred;
      return "fixed";
    }
  }

  return null;
}

function inferJobTypeFromText(text: string): JobTypeValue | null {
  // Strong signal patterns (word boundaries to avoid false matches)
  if (/\b(internship|intern\b)/i.test(text)) return "GIG";
  if (/\b(contract|contractor|fixed[- ]?term|temporary)\b/i.test(text)) return "GIG";
  if (/\bpart[- ]?time\b/i.test(text)) return "PARTTIME";
  if (/\bfreelance\b/i.test(text)) return "FREELANCE";
  if (/\bfull[- ]?time\b/i.test(text)) return "FULLTIME";
  return null;
}

function reviewLocationAndWorkType(job: ApiCreateJobRequest, issues: ReviewIssue[]): ReviewVerdict | null {
  let wasFixed = false;

  // ── Location cleanup ──
  if (job.location) {
    const loc = job.location;

    // Check if location is junk
    const locStr = [loc.city, loc.state, loc.country, loc.name, loc.formattedAddress].join(" ").trim();
    const isJunk = LOCATION_JUNK.some(p => p.test(locStr)) || !locStr;
    if (isJunk) {
      issues.push({ field: "location", problem: `Location is junk/empty: "${locStr}"`, action: "fixed", before: locStr, after: "null" });
      job.location = null;
      wasFixed = true;
    }

    // "Remote" as location → set workType=REMOTE, clear location
    if (loc.city && /^remote$/i.test(loc.city.trim()) && !loc.state && !loc.country) {
      issues.push({ field: "location", problem: `Location is just "Remote", moving to workType`, action: "fixed", before: loc.city, after: "workType=REMOTE, location=null" });
      job.workType = "REMOTE";
      job.location = null;
      wasFixed = true;
    }

    // "Remote" in city with a country → keep country, set workType
    if (loc.city && /^remote$/i.test(loc.city.trim()) && (loc.state || loc.country)) {
      issues.push({ field: "location", problem: `City is "Remote" with country context`, action: "fixed", before: loc.city, after: "workType=REMOTE, city cleared" });
      job.workType = "REMOTE";
      loc.city = "";
      loc.name = [loc.state, loc.country].filter(Boolean).join(", ");
      loc.formattedAddress = [loc.state, loc.country].filter(Boolean).join(", ");
      wasFixed = true;
    }
  }

  // ── WorkType inference from description ──
  const combined = `${job.title} ${stripHtml(job.description)}`.toLowerCase();
  const validWorkTypes = new Set(["ONSITE", "HYBRID", "REMOTE"]);

  if (job.workType && !validWorkTypes.has(job.workType)) {
    issues.push({ field: "workType", problem: `Invalid workType: "${job.workType}"`, action: "fixed", before: job.workType, after: "null" });
    job.workType = null;
    wasFixed = true;
  }

  // Detect contradictions: workType says ONSITE but text says remote
  if (job.workType === "ONSITE" && /\b(fully\s+remote|100%\s+remote|remote\s+only)\b/.test(combined)) {
    issues.push({ field: "workType", problem: "workType=ONSITE but description says fully remote", action: "fixed", before: "ONSITE", after: "REMOTE" });
    job.workType = "REMOTE";
    wasFixed = true;
  }
  if (job.workType === "REMOTE" && /\b(on[- ]?site\s+only|must\s+be\s+in[- ]office|in[- ]person\s+required)\b/.test(combined)) {
    issues.push({ field: "workType", problem: "workType=REMOTE but description says on-site only", action: "fixed", before: "REMOTE", after: "ONSITE" });
    job.workType = "ONSITE";
    wasFixed = true;
  }

  // Infer workType if missing
  if (!job.workType) {
    const inferred = inferWorkTypeFromText(combined);
    if (inferred) {
      issues.push({ field: "workType", problem: `workType was null, inferred from text`, action: "fixed", before: "null", after: inferred });
      job.workType = inferred;
      wasFixed = true;
    }
  }

  return wasFixed ? "fixed" : null;
}

function inferWorkTypeFromText(text: string): WorkTypeValue | null {
  if (/\b(remote|work\s*from\s*home|distributed|anywhere)\b/i.test(text)) return "REMOTE";
  if (/\b(hybrid|flexible\s*office)\b/i.test(text)) return "HYBRID";
  if (/\b(on[- ]?site|onsite|in[- ]office|in[- ]person|studio[- ]based)\b/i.test(text)) return "ONSITE";
  return null;
}

function reviewCompanyName(job: ApiCreateJobRequest, issues: ReviewIssue[]): ReviewVerdict | null {
  if (!job.company?.name) return null;

  const name = job.company.name.trim();
  let wasFixed = false;

  // Check for generic/wrong names (derived from URL subdomains)
  if (GENERIC_COMPANY_NAMES.has(name.toLowerCase())) {
    // Try to extract real company from jobLink
    const fixed = extractCompanyFromJobLink(job.jobLink ?? "");
    if (fixed) {
      issues.push({ field: "company", problem: `Generic company name "${name}", derived from URL`, action: "fixed", before: name, after: fixed });
      job.company.name = fixed;
      wasFixed = true;
    } else {
      issues.push({ field: "company", problem: `Generic company name "${name}", needs AI review`, action: "ignored", before: name });
    }
  }

  // Strip entity prefixes: "ADUS-Adobe Inc." → "Adobe Inc."
  if (!wasFixed && /^[A-Z]{2,6}-/.test(name)) {
    const cleaned = name.replace(/^[A-Z]{2,6}-/, "").trim();
    if (cleaned.length >= 2) {
      issues.push({ field: "company", problem: `Company has entity prefix`, action: "fixed", before: name, after: cleaned });
      job.company.name = cleaned;
      wasFixed = true;
    }
  }

  // Split joined words: "Foxfuelcreative" → flag for AI (heuristic splitting is unreliable)
  if (!wasFixed && name.length > 10 && !/\s/.test(name) && !/[A-Z].*[A-Z]/.test(name.slice(1))) {
    issues.push({ field: "company", problem: `Company name may be joined words: "${name}"`, action: "ignored", before: name });
  }

  return wasFixed ? "fixed" : null;
}

/** Try to extract a real company name from the job URL (for careers.X.com patterns) */
function extractCompanyFromJobLink(url: string): string | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./i, "");
    const parts = host.split(".");

    // careers.duolingo.com → "Duolingo"
    if (parts.length >= 3) {
      const subdomain = parts[0].toLowerCase();
      if (GENERIC_COMPANY_NAMES.has(subdomain)) {
        const companyPart = parts[1];
        if (companyPart && companyPart.length >= 2) {
          return companyPart.charAt(0).toUpperCase() + companyPart.slice(1);
        }
      }
    }

    // job-boards.eu.greenhouse.io/bitly → "Bitly"
    const atsHosts = ["greenhouse.io", "lever.co", "myworkdayjobs.com"];
    const baseDomain = parts.slice(-2).join(".");
    if (atsHosts.includes(baseDomain)) {
      const pathParts = parsed.pathname.split("/").filter(Boolean);
      if (pathParts.length > 0) {
        const candidate = pathParts[0];
        if (!GENERIC_COMPANY_NAMES.has(candidate.toLowerCase())) {
          return candidate.charAt(0).toUpperCase() + candidate.slice(1);
        }
      }
    }
  } catch { /* no-op */ }
  return null;
}

function reviewDescriptionFormatting(job: ApiCreateJobRequest, issues: ReviewIssue[]): ReviewVerdict | null {
  let wasFixed = false;
  const desc = job.description;

  // Strip page chrome (breadcrumbs, nav text) from start
  const chromePatterns = [
    /^(?:Home|Main)\s*[>/»]\s*(?:Careers?|Jobs?)\s*[>/»]\s*[^.]{3,60}\s*/i,
    /^(?:CAREERS|JOBS)\s*(?=[A-Z])/,
    /^(?:Skip to (?:content|main)|Menu|Navigation)\s*/i,
  ];

  let cleaned = desc;
  for (const pat of chromePatterns) {
    const before = cleaned;
    cleaned = cleaned.replace(pat, "");
    if (cleaned !== before) {
      issues.push({ field: "description", problem: "Description starts with page chrome (nav/breadcrumbs)", action: "fixed", before: before.slice(0, 80), after: cleaned.slice(0, 80) });
      wasFixed = true;
    }
  }
  if (wasFixed) {
    job.description = cleaned.trim();
  }

  // Flag unformatted blob descriptions (long, no HTML, no line breaks)
  const hasHtml = /<[^>]+>/.test(job.description);
  const hasNewlines = /\n/.test(job.description);
  const plainLen = stripHtml(job.description).length;
  if (!hasHtml && !hasNewlines && plainLen > 500) {
    issues.push({ field: "description", problem: `Unformatted blob description (${plainLen} chars, no formatting) — needs AI review`, action: "ignored" });
  }

  return wasFixed ? "fixed" : null;
}

function reviewTitleContent(job: ApiCreateJobRequest, issues: ReviewIssue[]): ReviewVerdict | null {
  const title = job.title.trim();

  // Detect "company careers" pattern: "asana careers", "figma jobs"
  if (/^.{2,30}\s+(careers?|jobs?|openings?|opportunities)$/i.test(title)) {
    issues.push({ field: "title", problem: `Title is a careers-page heading, not a job title: "${title}"`, action: "ignored", before: title });
    // Can't fix heuristically — needs AI
    return null;
  }

  return null;
}

// ─── AI Review (for ambiguous cases) ─────────────────────────────

interface AiReviewInput {
  title: string;
  descriptionSnippet: string;
  jobType: string;
  workType: string | null;
  locationStr: string | null;
  companyName: string | null;
  jobLink: string | null;
}

interface AiReviewResult {
  isValidJob: boolean;
  titleOk: boolean;
  fixedTitle?: string;
  descriptionRelevant: boolean;
  jobTypeSuggestion?: JobTypeValue;
  workTypeSuggestion?: WorkTypeValue | null;
  companyNameSuggestion?: string | null;
  reason?: string;
}

function buildReviewPrompt(input: AiReviewInput): string {
  return `You are a job listing quality reviewer. Review this scraped job posting data and check if it's valid and accurate.

Title: ${input.title}
Company: ${input.companyName ?? "not specified"}
Job URL: ${input.jobLink ?? "not specified"}
Job Type: ${input.jobType}
Work Type: ${input.workType ?? "not specified"}
Location: ${input.locationStr ?? "not specified"}

Description snippet (first 1500 chars):
${input.descriptionSnippet}

Answer these questions as JSON:
{
  "isValidJob": boolean - Is this actually a job posting? (false if it's a 404 page, about page, login page, cookie notice, etc.)
  "titleOk": boolean - Does the title look like a real job title? false if it's a careers-page heading like "Asana Careers" or generic text.
  "fixedTitle": string|null - If titleOk is false, extract the actual job title from the description. Otherwise null.
  "descriptionRelevant": boolean - Does the description contain actual job details (responsibilities, qualifications, etc.)? false if it's generic company info, navigation text, or unrelated content.
  "jobTypeSuggestion": "GIG"|"FULLTIME"|"PARTTIME"|"FREELANCE"|null - Only set if the current jobType seems wrong based on description. null means current is fine.
  "workTypeSuggestion": "ONSITE"|"HYBRID"|"REMOTE"|null - Only set if you can clearly determine work type from the description. null means can't tell or current is fine.
  "companyNameSuggestion": string|null - If the company name looks wrong (generic like "Careers", "Job-boards", or is clearly not the hiring company), provide the correct company name from the description/URL. null means current is fine.
  "reason": string - Brief explanation of any issues found
}

Return ONLY the JSON object, no markdown fences.`;
}

function parseAiReviewResponse(raw: string): AiReviewResult | null {
  let text = raw.trim();
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) text = fenceMatch[1].trim();

  try {
    const parsed = JSON.parse(text);
    return {
      isValidJob: parsed.isValidJob !== false,
      titleOk: parsed.titleOk !== false,
      fixedTitle: typeof parsed.fixedTitle === "string" ? parsed.fixedTitle.trim() || undefined : undefined,
      descriptionRelevant: parsed.descriptionRelevant !== false,
      jobTypeSuggestion: parsed.jobTypeSuggestion ?? undefined,
      workTypeSuggestion: parsed.workTypeSuggestion ?? undefined,
      companyNameSuggestion: typeof parsed.companyNameSuggestion === "string" ? parsed.companyNameSuggestion.trim() || undefined : undefined,
      reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
    };
  } catch {
    return null;
  }
}

async function callAiReview(apiKey: string, input: AiReviewInput): Promise<AiReviewResult | null> {
  const prompt = buildReviewPrompt(input);

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 512,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Anthropic API ${response.status}: ${errorText.slice(0, 200)}`);
  }

  const data = (await response.json()) as {
    content?: Array<{ type: string; text?: string }>;
  };

  const textBlock = data.content?.find((b) => b.type === "text");
  if (!textBlock?.text) return null;

  return parseAiReviewResponse(textBlock.text);
}

// ─── Decide if a job needs AI review ─────────────────────────────

function needsAiReview(job: ApiCreateJobRequest): boolean {
  const plainDesc = stripHtml(job.description);

  // Short but not empty descriptions — can't tell if relevant without AI
  if (plainDesc.length >= 30 && plainDesc.length < 200) return true;

  // Title looks suspicious (all caps, contains weird chars, very generic)
  if (/^[A-Z\s]{10,}$/.test(job.title)) return true;
  if (/^(job|position|role|opening|vacancy|opportunity)\s*$/i.test(job.title)) return true;

  // Title is a careers-page heading — AI should extract real title from description
  if (/^.{2,30}\s+(careers?|jobs?|openings?|opportunities)$/i.test(job.title)) return true;

  // Company name is generic — AI may be able to find the real name
  if (job.company?.name && GENERIC_COMPANY_NAMES.has(job.company.name.toLowerCase())) return true;

  // Unformatted blob description — AI can help restructure
  const hasHtml = /<[^>]+>/.test(job.description);
  const hasNewlines = /\n/.test(job.description);
  if (!hasHtml && !hasNewlines && plainDesc.length > 500) return true;

  // Description doesn't seem job-related (no typical job words)
  const jobKeywords = /\b(responsibilities|qualifications|requirements|experience|apply|salary|benefits|team|role|position|candidate|skills)\b/i;
  if (plainDesc.length >= 200 && !jobKeywords.test(plainDesc)) return true;

  return false;
}

// ─── Main Review Function ────────────────────────────────────────

export async function reviewJobs(
  jobs: ApiCreateJobRequest[],
  options: { aiConcurrency?: number; skipAiReview?: boolean } = {},
): Promise<{ reviewed: ApiCreateJobRequest[]; stats: ReviewStats; instructions: ReturnType<typeof generatePipelineInstructions> }> {
  const apiKey = process.env.ANTHROPIC_API_KEY ?? null;
  const skipAi = options.skipAiReview || !apiKey;
  const stats: ReviewStats = { total: jobs.length, ok: 0, fixed: 0, dropped: 0, issues: [] };

  const reviewed: ApiCreateJobRequest[] = [];
  const needsAiJobs: Array<{ index: number; job: ApiCreateJobRequest }> = [];

  // ── Pass 1: Heuristic review ──
  for (const job of jobs) {
    const issues: ReviewIssue[] = [];
    let verdict: ReviewVerdict = "ok";

    // Run checks in order of severity (drop-worthy first)
    const titleResult = reviewTitle(job, issues);
    if (titleResult === "dropped") {
      verdict = "dropped";
    } else {
      const descResult = reviewDescription(job, issues);
      if (descResult === "dropped") {
        verdict = "dropped";
      } else {
        const jobTypeResult = reviewJobType(job, issues);
        const locResult = reviewLocationAndWorkType(job, issues);
        const companyResult = reviewCompanyName(job, issues);
        const descFmtResult = reviewDescriptionFormatting(job, issues);
        const titleContentResult = reviewTitleContent(job, issues);

        if (titleResult === "fixed" || descResult === "fixed" || jobTypeResult === "fixed"
          || locResult === "fixed" || companyResult === "fixed" || descFmtResult === "fixed"
          || titleContentResult === "fixed") {
          verdict = "fixed";
        }
      }
    }

    if (verdict === "dropped") {
      stats.dropped++;
      stats.issues.push(...issues);
      logWarn(`[REVIEW] DROPPED: "${job.title}" — ${issues.map(i => i.problem).join("; ")}`, { jobLink: job.jobLink });
      continue;
    }

    if (verdict === "fixed") {
      stats.issues.push(...issues);
      for (const issue of issues.filter(i => i.action === "fixed")) {
        logInfo(`[REVIEW] FIXED: "${job.title}" — ${issue.field}: ${issue.problem}`, { before: issue.before, after: issue.after });
      }
    }

    // Check if AI review is needed
    if (!skipAi && needsAiReview(job)) {
      needsAiJobs.push({ index: reviewed.length, job });
    }

    reviewed.push(job);
    if (verdict === "fixed") {
      stats.fixed++;
    } else {
      stats.ok++;
    }
  }

  // ── Pass 2: AI review for ambiguous cases ──
  if (needsAiJobs.length > 0 && !skipAi) {
    logInfo(`[REVIEW] AI review needed for ${needsAiJobs.length} ambiguous jobs`);

    const concurrency = options.aiConcurrency ?? 4;
    let aiReviewed = 0;
    let aiDropped = 0;
    let aiFixed = 0;

    // Simple concurrency pool
    let cursor = 0;
    const workers = Array.from({ length: Math.min(concurrency, needsAiJobs.length) }, async () => {
      while (true) {
        const i = cursor++;
        if (i >= needsAiJobs.length) break;

        const { index, job } = needsAiJobs[i];
        const plainDesc = stripHtml(job.description);
        const locStr = job.location
          ? [job.location.city, job.location.state, job.location.country].filter(Boolean).join(", ")
          : null;

        try {
          const result = await callAiReview(apiKey!, {
            title: job.title,
            descriptionSnippet: plainDesc.slice(0, 1500),
            jobType: job.jobType,
            workType: job.workType ?? null,
            locationStr: locStr,
            companyName: job.company?.name ?? null,
            jobLink: job.jobLink ?? null,
          });

          if (!result) {
            aiReviewed++;
            continue;
          }

          // Not a valid job → drop
          if (!result.isValidJob) {
            stats.dropped++;
            stats.ok--; // Was counted as ok in pass 1
            reviewed[index] = null as any; // Mark for removal
            aiDropped++;
            const issue: ReviewIssue = { field: "all", problem: `AI: not a valid job posting — ${result.reason ?? "no reason"}`, action: "dropped" };
            stats.issues.push(issue);
            logWarn(`[REVIEW-AI] DROPPED: "${job.title}" — ${result.reason}`, { jobLink: job.jobLink });
            continue;
          }

          // Description not relevant → drop
          if (!result.descriptionRelevant) {
            stats.dropped++;
            stats.ok--;
            reviewed[index] = null as any;
            aiDropped++;
            const issue: ReviewIssue = { field: "description", problem: `AI: description not relevant to job — ${result.reason ?? ""}`, action: "dropped" };
            stats.issues.push(issue);
            logWarn(`[REVIEW-AI] DROPPED: "${job.title}" — description not relevant`, { jobLink: job.jobLink });
            continue;
          }

          let wasFixed = false;

          // Title fix
          if (!result.titleOk && result.fixedTitle && result.fixedTitle.length >= 3) {
            const issue: ReviewIssue = { field: "title", problem: "AI: title doesn't match description", action: "fixed", before: job.title, after: result.fixedTitle };
            stats.issues.push(issue);
            job.title = result.fixedTitle;
            wasFixed = true;
            logInfo(`[REVIEW-AI] FIXED title: "${issue.before}" → "${issue.after}"`, { jobLink: job.jobLink });
          }

          // JobType fix
          if (result.jobTypeSuggestion && result.jobTypeSuggestion !== job.jobType) {
            const issue: ReviewIssue = { field: "jobType", problem: "AI: jobType mismatch", action: "fixed", before: job.jobType, after: result.jobTypeSuggestion };
            stats.issues.push(issue);
            job.jobType = result.jobTypeSuggestion;
            wasFixed = true;
          }

          // WorkType fix
          if (result.workTypeSuggestion !== undefined && result.workTypeSuggestion !== job.workType) {
            const issue: ReviewIssue = { field: "workType", problem: "AI: workType mismatch", action: "fixed", before: job.workType ?? "null", after: result.workTypeSuggestion ?? "null" };
            stats.issues.push(issue);
            job.workType = result.workTypeSuggestion;
            wasFixed = true;
          }

          // Company name fix
          if (result.companyNameSuggestion && result.companyNameSuggestion !== job.company?.name) {
            const issue: ReviewIssue = { field: "company", problem: "AI: company name incorrect", action: "fixed", before: job.company?.name ?? "null", after: result.companyNameSuggestion };
            stats.issues.push(issue);
            if (!job.company) {
              job.company = { name: result.companyNameSuggestion, website: null, logo: null, email: null };
            } else {
              job.company.name = result.companyNameSuggestion;
            }
            wasFixed = true;
            logInfo(`[REVIEW-AI] FIXED company: "${issue.before}" → "${issue.after}"`, { jobLink: job.jobLink });
          }

          if (wasFixed) {
            aiFixed++;
            // Update stats: was ok → now fixed
            stats.ok--;
            stats.fixed++;
          }

          aiReviewed++;
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          logWarn(`[REVIEW-AI] Error reviewing "${job.title}": ${reason}`);
          aiReviewed++;
        }
      }
    });

    await Promise.all(workers);

    // Remove dropped jobs (marked as null)
    const filtered = reviewed.filter((j): j is ApiCreateJobRequest => j !== null);

    logInfo(`[REVIEW] AI review complete`, { reviewed: aiReviewed, fixed: aiFixed, dropped: aiDropped });

    const instructions = generatePipelineInstructions(stats);
    return { reviewed: filtered, stats, instructions };
  }

  const instructions = generatePipelineInstructions(stats);
  return { reviewed, stats, instructions };
}

// ─── Pipeline Instructions Generator ─────────────────────────────

/**
 * Analyzes review issues from a run and produces compact, actionable instructions
 * for an agent to improve enrichFromCsv.ts heuristic extraction next time.
 *
 * Groups issues by field + problem pattern, ranks by frequency, and outputs:
 *   - A JSON array of instructions (machine-readable)
 *   - A plain-text summary (human/agent readable)
 */
export function generatePipelineInstructions(stats: ReviewStats): {
  instructions: PipelineInstruction[];
  summary: string;
} {
  if (stats.issues.length === 0) {
    return { instructions: [], summary: "No issues found. Extraction quality looks good." };
  }

  // Group issues by field + normalized problem
  const grouped = new Map<string, { field: string; action: ReviewIssue["action"]; count: number; examples: string[] }>();

  for (const issue of stats.issues) {
    // Normalize problem to a pattern key (strip variable parts like quoted values, counts)
    const patternKey = `${issue.field}::${normalizePattern(issue.problem)}`;
    const existing = grouped.get(patternKey);
    if (existing) {
      existing.count++;
      if (existing.examples.length < 3 && issue.before) {
        existing.examples.push(issue.before);
      }
    } else {
      grouped.set(patternKey, {
        field: issue.field,
        action: issue.action,
        count: 1,
        examples: issue.before ? [issue.before] : [],
      });
    }
  }

  // Sort by frequency descending
  const sorted = [...grouped.entries()].sort((a, b) => b[1].count - a[1].count);

  const instructions: PipelineInstruction[] = sorted.map(([key, data]) => {
    const patternLabel = key.split("::")[1];
    return {
      field: data.field,
      frequency: data.count,
      pattern: patternLabel,
      action: data.action,
      instruction: buildInstruction(data.field, patternLabel, data.action, data.count, data.examples),
    };
  });

  const droppedInstructions = instructions.filter(i => i.action === "dropped");
  const fixedInstructions = instructions.filter(i => i.action === "fixed");
  const ignoredInstructions = instructions.filter(i => i.action === "ignored");

  const lines: string[] = [
    "═══════════════════════════════════════════════════════════════",
    "  PIPELINE IMPROVEMENT INSTRUCTIONS",
    "  Update enrichFromCsv.ts to catch these issues at extraction time",
    `  (Based on ${stats.total} jobs reviewed: ${stats.dropped} dropped, ${stats.fixed} fixed, ${stats.ok} ok)`,
    "═══════════════════════════════════════════════════════════════",
    "",
  ];

  if (droppedInstructions.length > 0) {
    lines.push("── DROPPED (fix extraction to avoid scraping these) ──");
    for (const inst of droppedInstructions) {
      lines.push(`  [${inst.field.toUpperCase()}] ×${inst.frequency} occurrences`);
      lines.push(`  ${inst.instruction}`);
      lines.push("");
    }
  }

  if (fixedInstructions.length > 0) {
    lines.push("── FIXED (extraction produced bad data that review had to patch) ──");
    for (const inst of fixedInstructions) {
      lines.push(`  [${inst.field.toUpperCase()}] ×${inst.frequency} occurrences`);
      lines.push(`  ${inst.instruction}`);
      lines.push("");
    }
  }

  if (ignoredInstructions.length > 0) {
    lines.push("── WARNINGS (monitor these, no action taken) ──");
    for (const inst of ignoredInstructions) {
      lines.push(`  [${inst.field.toUpperCase()}] ×${inst.frequency} occurrences`);
      lines.push(`  ${inst.instruction}`);
      lines.push("");
    }
  }

  lines.push("═══════════════════════════════════════════════════════════════");

  return { instructions, summary: lines.join("\n") };
}

function normalizePattern(problem: string): string {
  return problem
    .replace(/"[^"]*"/g, "<value>")        // strip quoted values
    .replace(/\d+ chars?/g, "N chars")     // strip char counts
    .replace(/\d+/g, "N")                  // strip other numbers
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function buildInstruction(
  field: string,
  pattern: string,
  action: ReviewIssue["action"],
  count: number,
  examples: string[],
): string {
  const exStr = examples.length > 0 ? ` Examples: ${examples.slice(0, 2).map(e => `"${e.slice(0, 60)}"`).join(", ")}` : "";

  // Field-specific instructions
  if (field === "title") {
    if (pattern.includes("too short") || pattern.includes("empty")) {
      return `Title extraction is returning empty/short strings. In extractTitleFromPage(), tighten the h1 minimum length check or expand selector coverage.${exStr}`;
    }
    if (pattern.includes("too long") || pattern.includes(">200")) {
      return `Title extraction is grabbing too much text (likely wrong selector). In extractTitleFromPage(), add a max-length guard of 150 chars before using h1.${exStr}`;
    }
    if (pattern.includes("blocklist") || pattern.includes("cookie") || pattern.includes("login")) {
      return `Scraper is landing on non-job pages (login walls, cookie pages). In fetchJobPage(), detect redirect to auth/cookie pages and return null early.${exStr}`;
    }
    if (pattern.includes("junk suffix") || pattern.includes("suffix")) {
      return `Titles contain platform suffixes (e.g. "@ Lever", "| LinkedIn"). Add these patterns to TITLE_STRIP_SUFFIXES in qualityReview.ts, or strip in extractTitleFromPage() before returning.${exStr}`;
    }
    if (pattern.includes("blocklist") || pattern.includes("html tag")) {
      return `Title is an HTML tag name — extractTitleFromPage() is grabbing the wrong element. Add a regex guard to reject single-word HTML tag names.${exStr}`;
    }
  }

  if (field === "description") {
    if (pattern.includes("placeholder") || pattern.includes("for job details")) {
      return `Description fell back to placeholder. In extractDescriptionFromHtml(), expand selector coverage: try [data-testid*='description'], .job-details, [class*='description'], and increase the fallback min-length threshold.${exStr}`;
    }
    if (pattern.includes("too short") || pattern.includes("short")) {
      return `Description is too short — likely wrong selector or page requires JS rendering. Consider expanding selectors or ensuring pageFetcher.ts waits for content to load.${exStr}`;
    }
    if (pattern.includes("blocklist") || pattern.includes("cookie") || pattern.includes("scraped wrong")) {
      return `Scraper captured cookie/login content as description. In extractDescriptionFromHtml(), add a content sanity check: reject if text starts with known bad patterns (cookies, login).${exStr}`;
    }
    if (pattern.includes("not relevant")) {
      return `Description contains company/about-page text instead of job details. In extractDescriptionHtml(), prefer selectors scoped to job-specific containers and deprioritize generic article/main tags.${exStr}`;
    }
  }

  if (field === "jobType") {
    if (pattern.includes("invalid")) {
      return `jobType received an invalid value — check inferJobTypeFromJsonLd() mapping covers all employmentType strings from JSON-LD. Add defensive fallback to "FULLTIME".${exStr}`;
    }
    if (pattern.includes("fulltime") || pattern.includes("mismatch") || pattern.includes("strongly suggests")) {
      return `jobType defaulted to FULLTIME but text signals otherwise. In inferJobTypeFromJsonLd() and the heuristic fallback, add keyword scan of title+description before defaulting.${exStr}`;
    }
  }

  if (field === "location") {
    if (pattern.includes("junk") || pattern.includes("n/a") || pattern.includes("undefined")) {
      return `Location extraction returned junk values. In extractLocationFromJsonLd(), validate each field is non-empty and not a sentinel value before building the ApiLocation object.${exStr}`;
    }
    if (pattern.includes("remote") || pattern.includes("city is remote")) {
      return `"Remote" is being stored as a city. In extractLocationFromJsonLd() and AI parseAiResponse(), detect "Remote" in city field and convert to workType=REMOTE with location=null.${exStr}`;
    }
  }

  if (field === "workType") {
    if (pattern.includes("invalid")) {
      return `workType received an invalid value. In mergeWithAi() and buildJobFromHeuristics(), validate workType is one of ONSITE|HYBRID|REMOTE before assigning.${exStr}`;
    }
    if (pattern.includes("contradiction") || pattern.includes("onsite but") || pattern.includes("remote but")) {
      return `workType contradicts description text. In inferWorkType(), check description more thoroughly for override signals like "fully remote" or "must be onsite".${exStr}`;
    }
    if (pattern.includes("inferred from text")) {
      return `workType was null but determinable from text. In inferWorkType() in enrichFromCsv.ts, expand keyword patterns to catch more signals — currently missing some phrases.${exStr}`;
    }
  }

  if (field === "company") {
    if (pattern.includes("generic")) {
      return `Company name was derived from URL subdomain ("Careers", "Job-boards", etc.). In extractCompanyFromJsonLd(), skip generic subdomains and use the second-level domain or ATS path segment instead.${exStr}`;
    }
    if (pattern.includes("entity prefix")) {
      return `Company name has a subsidiary/entity prefix (e.g. "ADUS-Adobe Inc."). In extractCompanyFromJsonLd(), strip leading [A-Z]{2,6}- prefixes from hiringOrganization.name.${exStr}`;
    }
    if (pattern.includes("joined words")) {
      return `Company name appears to be joined words with no spaces. Flag for AI review or attempt camelCase splitting in extractCompanyFromJsonLd().${exStr}`;
    }
    if (pattern.includes("ai: company")) {
      return `AI had to fix the company name. Improve heuristic extraction in extractCompanyFromJsonLd() to get it right the first time.${exStr}`;
    }
  }

  if (field === "all") {
    return `AI flagged this as not a valid job posting. In fetchJobPage(), add detection for non-job pages: check page title, meta tags, or URL patterns to skip these before scraping.${exStr}`;
  }

  // Generic fallback
  return `[${field}] ${pattern} occurred ${count} time(s). Review extraction logic in enrichFromCsv.ts for this field.${exStr}`;
}
