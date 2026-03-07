/**
 * Deterministic data-cleaning agent for JobScraping API outputs.
 * Cleans and normalizes job records before feeding to api-server.
 */
import type {
  ApiCompany,
  ApiCreateJobRequest,
  ApiLocation,
  JobTypeValue,
  WorkTypeValue,
} from "../types.js";

// --- Step A: Noise / Non-jobs ---

const NOISE_TITLES = new Set(
  [
    "skip to main content",
    "skip to content",
    "home",
    "careers",
    "career",
    "apply now",
    "search jobs",
    "search job",
    "view all jobs",
    "view all",
    "current openings",
    "list of jobs",
    "join our team",
    "design your own",
    "web design london. web design agency.",
  ].map((s) => s.toLowerCase())
);

// Collection/category rows - not individual jobs
const COLLECTION_TITLE =
  /^jobs\s+in\s+(design|editorial|creative|ux|ui|graphic|motion|brand|content)(?:\s+design)?\s*$/i;
const COLLECTION_TITLE_ALT =
  /^(design|editorial\s+design|creative|ux\s*\/?\s*ui|graphic\s+design)\s+jobs\s*$/i;
const COLLECTION_TITLE_EXTRA = /\bexplore\s+jobs?\s+in\s+(design|creative|ux|ui|content|brand)\b/i;

// Agency service pages misrepresented as jobs
const AGENCY_SERVICE_TITLE =
  /(web\s+design\s+agency|startup\s+web\s+design\s+agency|design\s+agency|creative\s+agency|branding\s+agency)\s*$/i;

// Freelancer portfolio - "Name role, role freelance" (self-description, not hiring)
const PORTFOLIO_TITLE =
  /\b(web\s+designer|logo\s+designer|graphic\s+designer)\s*,\s*[\w\s]+\s+freelance\s*$/i;

// Awards, news, blog - not job postings
const AWARDS_NEWS_TITLE =
  /(design\s+awards?\s+\d{4}|shortlisted\s+for|another\s+win\s+for|what\s+.*\s+taught\s+me|insight[s]?\b|newsletter\b)/i;

// Exhibition/service page (when title is just the service name)
const EXHIBITION_SERVICE_TITLE = /^exhibition\s+stand\s+design\s*$/i;

// Mojibake: UTF-8 misinterpreted as Latin-1 (common CJK corruption indicators)
const MOJIBAKE_PATTERN = /ã[‚ƒ]|å[\d'´]|ç["¢£]|è¨­|ï¼Œ|æ³¨|é©—/;

// Breadcrumb noise at start: 'Home > Careers > UI/UX Designer Jr.' or similar
const BREADCRUMB_PREFIX = /^['"]?(?:home\s*>\s*)?(?:careers?|jobs?)(?:\s*>\s*[^'"]*)?['"]?\s*/i;

const JOB_LIKE_PATH =
  /\/(jobs?|job\/|opening|openings?|position|positions?|requisition|careers?(\/|$)|join-us|vacanc(y|ies)|apply|\d{5,})/i;
const NON_JOB_PATH =
  /\/(services?|blog|article|news|press|about|contact|pages\/|insights?|portfolio|projects?|case-studies?|work(\/|$)|collections?|products?)(\/|$)/i;
const WORDPRESS_NON_JOB = /\?page_id=|\?p=\d+/i;
const ROLE_HINT =
  /\b(designer|artist|writer|editor|producer|engineer|developer|manager|director|specialist|analyst|coordinator|illustrator|animator)\b/i;
const JOB_CONTEXT_HINT =
  /\b(job|role|position|opening|hiring|intern(ship)?|full[-\s]?time|part[-\s]?time|contract|freelance|vacancy|apply)\b/i;
const JOB_DETAIL_QUERY_KEY = /^(gh_jid|jobid|job_id|requisition|req(id)?|opening(id)?|posting(id)?|position(id)?|vacancy(id)?|id)$/i;

const NON_CREATIVE_ONLY =
  /\b(accountant|bookkeeper|auditor|tax\s+analyst|legal\s+counsel|paralegal|warehouse|logistics|driver|call\s+center|salesforce\s+admin|nurse|rn\s+|clinical|mechanical\s+technician|hr\s+coordinator|payroll)\b/i;

const CREATIVE_HINTS =
  /\b(design|ux|ui|creative|brand|content|copy|motion|animation|video|audio|music|fashion|game\s+art|visual|illustrat)\b/i;

export type RemovalReason =
  | "noise_title"
  | "missing_link"
  | "invalid_link"
  | "non_job_url"
  | "service_or_content_path"
  | "non_creative"
  | "duplicate"
  | "collection_row"
  | "agency_service_page"
  | "portfolio_or_service"
  | "awards_or_news"
  | "mojibake_title";

export interface CleanContext {
  removedNoise: number;
  removedNoncreative: number;
  removedDuplicate: number;
  placeholderDescription: number;
  mojibakeFixed: number;
  titleNormalized: number;
  descriptionNormalized: number;
  reasonCounts: Record<string, number>;
  sampleRemoved: Array<{ title: string; jobLink: string; reason: RemovalReason }>;
}

function isNoiseTitle(title: string): boolean {
  const t = title.trim().toLowerCase();
  if (NOISE_TITLES.has(t)) return true;
  if (/^skip to\b/i.test(t)) return true;
  return false;
}

function isValidJobLink(link: string | null | undefined): boolean {
  if (!link || typeof link !== "string") return false;
  const s = link.trim();
  return s.startsWith("http://") || s.startsWith("https://");
}

function isJobLikeUrl(url: string, title: string): boolean {
  try {
    const u = new URL(url);
    const path = u.pathname.toLowerCase();
    const hasJobPath = JOB_LIKE_PATH.test(path);
    if (hasJobPath) return true;
    if (NON_JOB_PATH.test(path)) return false;
    if (WORDPRESS_NON_JOB.test(u.search)) return false;
    const roleHint = ROLE_HINT.test(title);
    const jobContext = JOB_CONTEXT_HINT.test(title);
    if (roleHint && (jobContext || /\/(careers?|join|hiring|openings?)(\/|$)/i.test(path))) return true;
    return false;
  } catch {
    return false;
  }
}

function isServiceOrContentPath(url: string): boolean {
  try {
    const u = new URL(url);
    const path = u.pathname.toLowerCase();
    if (/\/services?\/|\/blog\/|\/article\/|\/pages\/|\/news\//.test(path)) return true;
    if (WORDPRESS_NON_JOB.test(u.search)) return true;
    return false;
  } catch {
    return false;
  }
}

function isCollectionRow(title: string): boolean {
  const t = title.trim();
  return COLLECTION_TITLE.test(t) || COLLECTION_TITLE_ALT.test(t) || COLLECTION_TITLE_EXTRA.test(t);
}

function isListingIndexUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const path = u.pathname.toLowerCase().replace(/\/+$/, "");
    if (
      path === "/careers" ||
      path === "/career" ||
      path === "/jobs" ||
      path === "/job" ||
      path === "/about/careers" ||
      path === "/about/career" ||
      path === "/en/work-with-us/jobs" ||
      path === "/careers/open-positions"
    ) {
      const hasDetailParam = Array.from(u.searchParams.keys()).some((k) =>
        JOB_DETAIL_QUERY_KEY.test(k.toLowerCase())
      );
      return !hasDetailParam;
    }
    return false;
  } catch {
    return false;
  }
}

function isAgencyServiceTitle(title: string): boolean {
  const t = title.trim();
  return AGENCY_SERVICE_TITLE.test(t);
}

function isPortfolioTitle(title: string): boolean {
  const t = title.trim();
  return PORTFOLIO_TITLE.test(t);
}

function isAwardsOrNewsTitle(title: string): boolean {
  return AWARDS_NEWS_TITLE.test(title);
}

function isExhibitionServiceTitle(title: string): boolean {
  return EXHIBITION_SERVICE_TITLE.test(title.trim());
}

function hasMojibakeInTitle(title: string): boolean {
  return MOJIBAKE_PATTERN.test(title);
}

function pushRemoved(
  ctx: CleanContext,
  job: ApiCreateJobRequest,
  reason: RemovalReason
): void {
  ctx.removedNoise++;
  ctx.reasonCounts[reason] = (ctx.reasonCounts[reason] ?? 0) + 1;
  if (ctx.sampleRemoved.length < 20) {
    ctx.sampleRemoved.push({
      title: job.title ?? "",
      jobLink: job.jobLink ?? "",
      reason,
    });
  }
}

export function stepARemoveNoise(
  job: ApiCreateJobRequest,
  ctx: CleanContext
): boolean {
  const title = (job.title ?? "").trim();
  const link = job.jobLink ?? "";
  const description = (job.description ?? "").trim();

  if (isNoiseTitle(title)) {
    pushRemoved(ctx, job, "noise_title");
    return true;
  }

  if (isCollectionRow(title)) {
    pushRemoved(ctx, job, "collection_row");
    return true;
  }

  if (isAgencyServiceTitle(title)) {
    pushRemoved(ctx, job, "agency_service_page");
    return true;
  }

  if (isPortfolioTitle(title)) {
    pushRemoved(ctx, job, "portfolio_or_service");
    return true;
  }

  if (isAwardsOrNewsTitle(title)) {
    pushRemoved(ctx, job, "awards_or_news");
    return true;
  }

  if (isExhibitionServiceTitle(title)) {
    pushRemoved(ctx, job, "portfolio_or_service");
    return true;
  }

  if (hasMojibakeInTitle(title)) {
    pushRemoved(ctx, job, "mojibake_title");
    return true;
  }

  if (!isValidJobLink(link)) {
    pushRemoved(ctx, job, "missing_link");
    return true;
  }

  if (
    isListingIndexUrl(link) &&
    (!JOB_CONTEXT_HINT.test(title) ||
      /take\s*20%\s*off any new website plan|joinour team|our team locations inclusion/i.test(description))
  ) {
    pushRemoved(ctx, job, "non_job_url");
    return true;
  }

  if (isServiceOrContentPath(link) && !isJobLikeUrl(link, title)) {
    pushRemoved(ctx, job, "service_or_content_path");
    return true;
  }

  if (!isJobLikeUrl(link, title)) {
    pushRemoved(ctx, job, "non_job_url");
    return true;
  }

  return false;
}

export function stepBRemoveNonCreative(
  job: ApiCreateJobRequest,
  ctx: CleanContext,
  creativeScore?: number
): boolean {
  const title = (job.title ?? "").trim();
  const desc = (job.description ?? "").trim();
  const combined = `${title} ${desc}`.toLowerCase();

  const hasCreative = CREATIVE_HINTS.test(combined);
  const isNonCreativeOnly = NON_CREATIVE_ONLY.test(combined) && !hasCreative;

  // Remove only high-confidence non-creative (spec: "If mixed/uncertain, keep")
  if (isNonCreativeOnly) {
    ctx.removedNoncreative++;
    ctx.reasonCounts["non_creative"] = (ctx.reasonCounts["non_creative"] ?? 0) + 1;
    if (ctx.sampleRemoved.length < 20) {
      ctx.sampleRemoved.push({
        title: job.title ?? "",
        jobLink: job.jobLink ?? "",
        reason: "non_creative",
      });
    }
    return true;
  }

  // Strong negative signal from enrichment when no creative hints
  if (creativeScore !== undefined && creativeScore < 0 && !hasCreative) {
    ctx.removedNoncreative++;
    ctx.reasonCounts["non_creative"] = (ctx.reasonCounts["non_creative"] ?? 0) + 1;
    if (ctx.sampleRemoved.length < 20) {
      ctx.sampleRemoved.push({
        title: job.title ?? "",
        jobLink: job.jobLink ?? "",
        reason: "non_creative",
      });
    }
    return true;
  }

  return false;
}

// --- Step C: Normalize title ---
const TITLE_BOILERPLATE = /^(apply\s+now\s*[-–—:|]*\s*|job\s+id\s+only\s*[-–—:|]*\s*)/i;

export function stepCNormalizeTitle(job: ApiCreateJobRequest, ctx: CleanContext): string {
  let t = (job.title ?? "").trim();
  if (!t) return t;
  const orig = t;
  t = t.replace(/\s+/g, " ").trim();
  t = t.replace(TITLE_BOILERPLATE, "");
  t = t.replace(BREADCRUMB_PREFIX, "").trim();
  t = t.replace(/\s*[-–—:|]\s*$/g, "").trim();
  if (t !== orig) ctx.titleNormalized++;
  return t;
}

// --- Step D: Normalize description ---
const PLACEHOLDER_DESC = "For job details, click apply.";
const HTML_ENTITY = /&#x([0-9a-fA-F]+);|&#(\d+);|&amp;|&lt;|&gt;|&quot;|&#39;|&apos;/g;

function decodeHtmlEntities(s: string): string {
  return s.replace(HTML_ENTITY, (m, hex?: string, dec?: string) => {
    if (hex) return String.fromCodePoint(parseInt(hex, 16));
    if (dec) return String.fromCodePoint(parseInt(dec, 10));
    const map: Record<string, string> = {
      "&amp;": "&",
      "&lt;": "<",
      "&gt;": ">",
      "&quot;": '"',
      "&#39;": "'",
      "&apos;": "'",
    };
    return map[m] ?? m;
  });
}

function stripScriptsAndStyles(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, " ");
}

function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const EEOC_PATTERN =
  /(equal\s+opportunity|EEOC|affirmative\s+action|we\s+are\s+an?\s+equal\s+opportunity\s+employer)[\s\S]{0,200}/gi;
const COOKIE_BANNER = /(cookie\s+policy|accept\s+cookies|privacy\s+preferences)[\s\S]{0,150}/gi;
const NAV_GARBAGE =
  /(skip to (main )?content|you are here|breadcrumb|home\s*>\s*|my profile|account security|settings|sign out|main menu)/gi;
const LEADING_NAV_PREFIX =
  /^\s*(?:now\s*)?(?:back\s*to\s*jobs?|back\s*to\s*search\s*results?|back\s*to\s*(?:careers?|results?)|[◀<‹«]+\s*search\s*results?|search\s*results?|home\s+work\s+about\s+news\s+join\s+us\s+contact)\s*[:|>\-–—]*\s*/i;
const INLINE_NAV_GARBAGE = /(back\s*to\s*jobs?|back\s*to\s*search\s*results?|[◀<‹«]+\s*search\s*results?)/gi;
const PROMO_GARBAGE =
  /(take\s*20%\s*off any new website plan|use code at checkout|offer termsclose|discount applies to the first payment|cannot be used on previous purchases|payments through in-app pay)/i;
const FRAUD_WARNING_PREFIX =
  /we have recently become aware[\s\S]{0,1200}?(?:view all jobs|open positions)\s*/i;

function hasMojibakeInText(text: string): boolean {
  return MOJIBAKE_PATTERN.test(text);
}

export function stepDNormalizeDescription(
  job: ApiCreateJobRequest,
  ctx: CleanContext,
  jobLink: string
): string {
  let desc = (job.description ?? "").trim();
  const validUrl = isValidJobLink(jobLink);

  if (!desc && validUrl) {
    ctx.placeholderDescription++;
    return PLACEHOLDER_DESC;
  }

  if (desc.length < 40 && validUrl) {
    ctx.placeholderDescription++;
    return PLACEHOLDER_DESC;
  }

  // Mojibake/corrupt text -> use placeholder
  if (hasMojibakeInText(desc) && validUrl) {
    ctx.placeholderDescription++;
    ctx.mojibakeFixed++;
    return PLACEHOLDER_DESC;
  }

  if (PROMO_GARBAGE.test(desc) && validUrl) {
    ctx.placeholderDescription++;
    return PLACEHOLDER_DESC;
  }

  const orig = desc;
  desc = decodeHtmlEntities(desc);
  if (desc !== orig) ctx.mojibakeFixed++;
  desc = stripScriptsAndStyles(desc);
  desc = htmlToText(desc);
  desc = desc.replace(FRAUD_WARNING_PREFIX, " ");
  desc = desc.replace(LEADING_NAV_PREFIX, " ").trim();
  desc = desc.replace(LEADING_NAV_PREFIX, " ").trim();
  desc = desc.replace(INLINE_NAV_GARBAGE, " ");
  desc = desc.replace(BREADCRUMB_PREFIX, " ").trim();
  desc = desc.replace(EEOC_PATTERN, " ").replace(COOKIE_BANNER, " ").replace(NAV_GARBAGE, " ");
  const normalizedTitle = (job.title ?? "").trim().toLowerCase();
  if (normalizedTitle && desc.toLowerCase().startsWith(normalizedTitle)) {
    desc = desc.slice((job.title ?? "").trim().length).trim();
  }
  desc = desc.replace(/\s+/g, " ").trim();
  if (desc !== orig) ctx.descriptionNormalized++;

  if (!desc && validUrl) return PLACEHOLDER_DESC;
  return desc || PLACEHOLDER_DESC;
}

// --- Step E: Normalize other fields ---

export function canonicalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    const params = new URLSearchParams(u.search);
    for (const key of Array.from(params.keys())) {
      const k = key.toLowerCase();
      if (k.startsWith("utm_") || k === "ref" || k === "source" || k === "trk") {
        params.delete(key);
      }
    }
    u.search = params.toString();
    u.hash = "";
    return u.toString();
  } catch {
    return url;
  }
}

const VALID_JOB_TYPES: JobTypeValue[] = ["GIG", "FULLTIME", "PARTTIME", "FREELANCE"];
const VALID_WORK_TYPES: (WorkTypeValue | null)[] = ["ONSITE", "HYBRID", "REMOTE", null];

function normalizeJobType(v: unknown): JobTypeValue {
  if (typeof v === "string" && VALID_JOB_TYPES.includes(v as JobTypeValue)) {
    return v as JobTypeValue;
  }
  const s = String(v ?? "").toUpperCase();
  if (s.includes("PART") || s.includes("PART-TIME")) return "PARTTIME";
  if (s.includes("FREELANCE") || s.includes("CONTRACT") || s.includes("GIG")) return "FREELANCE";
  if (s.includes("FULL") || s.includes("FULL-TIME")) return "FULLTIME";
  return "FULLTIME";
}

function normalizeWorkType(v: unknown): WorkTypeValue | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string" && VALID_WORK_TYPES.includes(v as WorkTypeValue)) {
    return v as WorkTypeValue;
  }
  const s = String(v).toUpperCase();
  if (s.includes("REMOTE")) return "REMOTE";
  if (s.includes("HYBRID")) return "HYBRID";
  if (s.includes("ON-SITE") || s.includes("ONSITE") || s.includes("OFFICE")) return "ONSITE";
  return null;
}

function ensureLocation(loc: ApiLocation | null | undefined): ApiLocation {
  if (loc && typeof loc === "object") {
    return {
      placeId: String(loc.placeId ?? ""),
      name: String(loc.name ?? ""),
      formattedAddress: String(loc.formattedAddress ?? ""),
      latitude: typeof loc.latitude === "number" ? loc.latitude : 0,
      longitude: typeof loc.longitude === "number" ? loc.longitude : 0,
      city: String(loc.city ?? ""),
      state: String(loc.state ?? ""),
      country: String(loc.country ?? ""),
    };
  }
  return {
    placeId: "",
    name: "",
    formattedAddress: "",
    latitude: 0,
    longitude: 0,
    city: "",
    state: "",
    country: "",
  };
}

function deriveCompanyName(url: string, company?: ApiCompany | null): string {
  if (company?.name && String(company.name).trim()) return String(company.name).trim();
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return host.split(".")[0] ?? "unknown";
  } catch {
    return "unknown";
  }
}

function dedupeArray(arr: string[] | null | undefined, max: number): string[] {
  if (!Array.isArray(arr)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of arr) {
    const t = String(s).toLowerCase().trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

export function stepENormalizeFields(
  job: ApiCreateJobRequest,
  jobLink: string
): ApiCreateJobRequest {
  const companyName = deriveCompanyName(jobLink, job.company);
  const company: ApiCompany = {
    name: companyName,
    website: job.company?.website ?? null,
    logo: job.company?.logo ?? null,
    email: job.company?.email ?? null,
  };

  return {
    ...job,
    title: job.title ?? "",
    description: job.description ?? "",
    jobLink: jobLink,
    location: ensureLocation(job.location),
    jobType: normalizeJobType(job.jobType),
    workType: normalizeWorkType(job.workType),
    company,
    skills: dedupeArray(job.skills, 30),
    keywords: dedupeArray(job.keywords, 40),
  };
}

// --- Step F: Dedupe ---

export function stepFDedupe(jobs: ApiCreateJobRequest[], ctx: CleanContext): ApiCreateJobRequest[] {
  const seenLinks = new Set<string>();
  const seenFallback = new Set<string>();
  const out: ApiCreateJobRequest[] = [];
  let dupes = 0;

  for (const job of jobs) {
    const link = canonicalizeUrl(job.jobLink ?? "").toLowerCase().trim();
    const fallback = `${(job.title ?? "").toLowerCase().replace(/\s+/g, " ")}|${(job.company?.name ?? "").toLowerCase()}|${(job.location?.city ?? "").toLowerCase()}|${(job.location?.state ?? "").toLowerCase()}|${(job.location?.country ?? "").toLowerCase()}`;

    if (link) {
      if (seenLinks.has(link)) {
        dupes++;
        ctx.reasonCounts["duplicate"] = (ctx.reasonCounts["duplicate"] ?? 0) + 1;
        if (ctx.sampleRemoved.length < 20) {
          ctx.sampleRemoved.push({
            title: job.title ?? "",
            jobLink: job.jobLink ?? "",
            reason: "duplicate",
          });
        }
        continue;
      }
      seenLinks.add(link);
    } else {
      if (seenFallback.has(fallback)) {
        dupes++;
        ctx.reasonCounts["duplicate"] = (ctx.reasonCounts["duplicate"] ?? 0) + 1;
        continue;
      }
      seenFallback.add(fallback);
    }
    out.push(job);
  }

  ctx.removedDuplicate = dupes;
  return out;
}
