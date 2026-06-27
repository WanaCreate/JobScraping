import { load } from "cheerio";
import { chromium } from "playwright";
import type {
  ApiCompany,
  ApiCreateJobRequest,
  ApiLocation,
  ApiSalary,
  ATS,
  EnrichedJobRecord,
  JobTypeValue,
  NormalizedJob,
  SalaryPeriodValue,
  WorkTypeValue
} from "../types.js";
import { isCreativeTitleStrict, passesCreativeGate, scoreCreativeText } from "./creativeClassifier.js";
import { extractDiscoveredDomains, recordDiscoveredDomains } from "./discoverCompanies.js";
import { fetchPageWithRetry } from "./http.js";

const DESCRIPTION_SELECTORS = [
  "[data-automation-id='jobPostingDescription']",
  "[data-automation-id='job-posting-description']",
  "[data-automation-id='jobDescription']",
  ".css-kyg8or",
  "#job-detail-body",
  "[id*='job-detail-body']",
  "[id*='job-description']",
  "[data-qa='job-description']",
  "[data-testid*='description']",
  "[data-test*='description']",
  "[class*='JobDescription']",
  ".posting-description",
  ".job-description",
  ".job-details",
  ".iCIMS_InfoMsg_Job",
  "#content .content",
  "#content",
  "[class*='description']",
  ".description",
  ".section",
  "article",
  "main"
];

const DESCRIPTION_CUTOFF_MARKERS = [
  "Apply for this job",
  "Create a Job Alert",
  "Voluntary Self-Identification",
  "Autofill with",
  "Accepted file types"
];

const KEYWORD_TERMS = [
  "design",
  "creative",
  "brand",
  "content",
  "visual",
  "motion",
  "animation",
  "ux",
  "ui",
  "product design",
  "graphic design",
  "art direction",
  "copywriting",
  "video",
  "music",
  "fashion"
];

const KEYWORD_BLOCKLIST = new Set([
  "other", "not specified", "other / not specified", "other/not specified",
  "n/a", "na", "none", "unspecified", "unknown", "general",
  "miscellaneous", "misc", "various", "all", "any", "tbd",
  "see description", "see below", "not applicable", "other category",
]);

const SKILL_TAXONOMY: Record<string, string[]> = {
  figma: ["figma"],
  sketch: ["sketch app", "sketch"],
  adobe_creative_suite: [
    "adobe creative suite",
    "creative suite",
    "adobe cc",
    "adobe suite"
  ],
  photoshop: ["photoshop", "adobe photoshop"],
  illustrator: ["illustrator", "adobe illustrator"],
  indesign: ["indesign", "adobe indesign"],
  after_effects: ["after effects", "adobe after effects"],
  premiere_pro: ["premiere pro", "adobe premiere"],
  davinci_resolve: ["davinci resolve"],
  final_cut_pro: ["final cut", "final cut pro", "fcp"],
  blender: ["blender"],
  cinema4d: ["cinema 4d", "c4d"],
  maya: ["maya", "autodesk maya"],
  houdini: ["houdini"],
  zbrush: ["zbrush"],
  unity: ["unity"],
  unreal_engine: ["unreal", "unreal engine"],
  protopie: ["protopie"],
  framer: ["framer"],
  webflow: ["webflow"],
  typography: ["typography", "type design"],
  storyboarding: ["storyboard", "storyboarding"],
  motion_graphics: ["motion graphics", "motion design"],
  video_editing: ["video editing", "video production", "post-production"],
  color_grading: ["color grading"],
  ux_research: ["ux research", "user research", "qualitative research"],
  wireframing: ["wireframing", "wireframe"],
  prototyping: ["prototyping", "prototype"],
  design_systems: ["design systems", "design tokens"],
  interaction_design: ["interaction design", "ixd"],
  information_architecture: ["information architecture"],
  branding: ["branding", "brand identity", "visual identity"],
  copywriting: ["copywriting", "copy writer"],
  content_strategy: ["content strategy", "editorial strategy"],
  social_media: ["social media", "social content"],
  seo: ["seo", "search engine optimization"],
  email_marketing: ["email marketing"],
  art_direction: ["art direction", "art director"],
  creative_direction: ["creative direction", "creative director"],
  sound_design: ["sound design", "audio editing", "sound editing"],
  music_production: ["music production", "composition"],
  fashion_styling: ["fashion styling", "styling"],
  pattern_making: ["pattern making", "pattern cutting"],
  technical_design: ["technical design", "tech pack"]
};

const SKILL_STOP_WORDS = new Set([
  "and",
  "or",
  "with",
  "in",
  "of",
  "to",
  "the",
  "a",
  "an",
  "experience",
  "proficiency",
  "knowledge",
  "ability",
  "skills",
  "skill"
]);

const COUNTRY_CODE_MAP: Record<string, string> = {
  US: "United States",
  UK: "United Kingdom",
  GB: "United Kingdom",
  CA: "Canada",
  AU: "Australia",
  NZ: "New Zealand",
  IN: "India",
  SG: "Singapore",
  AE: "United Arab Emirates",
  UAE: "United Arab Emirates",
  DE: "Germany",
  FR: "France",
  ES: "Spain",
  IT: "Italy",
  NL: "Netherlands",
  BE: "Belgium",
  PT: "Portugal",
  CH: "Switzerland",
  AT: "Austria",
  IE: "Ireland",
  SE: "Sweden",
  NO: "Norway",
  FI: "Finland",
  DK: "Denmark",
  PL: "Poland",
  CZ: "Czech Republic",
  HU: "Hungary",
  RO: "Romania",
  GR: "Greece",
  TR: "Turkey",
  IL: "Israel",
  JP: "Japan",
  KR: "South Korea",
  CN: "China",
  HK: "Hong Kong",
  TW: "Taiwan",
  TH: "Thailand",
  VN: "Vietnam",
  MY: "Malaysia",
  ID: "Indonesia",
  PH: "Philippines",
  BR: "Brazil",
  MX: "Mexico",
  AR: "Argentina",
  CL: "Chile",
  CO: "Colombia",
  PE: "Peru",
  ZA: "South Africa",
  NG: "Nigeria",
  EG: "Egypt"
};

const US_STATES = new Set([
  "AL",
  "AK",
  "AZ",
  "AR",
  "CA",
  "CO",
  "CT",
  "DE",
  "FL",
  "GA",
  "HI",
  "ID",
  "IL",
  "IN",
  "IA",
  "KS",
  "KY",
  "LA",
  "ME",
  "MD",
  "MA",
  "MI",
  "MN",
  "MS",
  "MO",
  "MT",
  "NE",
  "NV",
  "NH",
  "NJ",
  "NM",
  "NY",
  "NC",
  "ND",
  "OH",
  "OK",
  "OR",
  "PA",
  "RI",
  "SC",
  "SD",
  "TN",
  "TX",
  "UT",
  "VT",
  "VA",
  "WA",
  "WV",
  "WI",
  "WY",
  "DC"
]);

const CA_PROVINCES = new Set([
  "AB",
  "BC",
  "MB",
  "NB",
  "NL",
  "NS",
  "NT",
  "NU",
  "ON",
  "PE",
  "QC",
  "SK",
  "YT"
]);

const LOCATION_NOISE_PATTERN =
  /\b(responsibilit|qualification|benefit|apply for this job|job alert|equal opportunity|privacy notice|what you'll|you will|our team|interview|voluntary self|screening question|portfolio|resume|autofill)\b/i;

let playwrightActiveFetches = 0;
const PLAYWRIGHT_MAX_PARALLEL_FETCHES = 2;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeJobUrlForRetry(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    parsed.hash = "";

    for (const key of [...parsed.searchParams.keys()]) {
      if (/^utm_/i.test(key) || /^(ref|source|src|trk|tracking)$/i.test(key)) {
        parsed.searchParams.delete(key);
      }
    }

    return parsed.toString().replace(/\/$/, "");
  } catch {
    return rawUrl;
  }
}

function isKnownAtsHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return /(greenhouse\.io|lever\.co|smartrecruiters\.com|myworkdayjobs\.com|icims\.com|ashbyhq\.com|phenompeople\.com|workdayjobs\.com)/i.test(
      host
    );
  } catch {
    return false;
  }
}

function buildCandidateUrls(rawUrl: string): string[] {
  const candidates = new Set<string>();
  const normalized = normalizeJobUrlForRetry(rawUrl);
  candidates.add(normalized);

  try {
    const parsed = new URL(normalized);

    if (/\/apply\/?$/i.test(parsed.pathname)) {
      const noApply = new URL(parsed.toString());
      noApply.pathname = noApply.pathname.replace(/\/apply\/?$/i, "");
      candidates.add(noApply.toString());
    }

    if (/job-boards\.greenhouse\.io$/i.test(parsed.hostname)) {
      const boardsVariant = new URL(parsed.toString());
      boardsVariant.hostname = parsed.hostname.replace("job-boards.greenhouse.io", "boards.greenhouse.io");
      candidates.add(boardsVariant.toString());
    }

    if (/boards\.greenhouse\.io$/i.test(parsed.hostname)) {
      const jobBoardsVariant = new URL(parsed.toString());
      jobBoardsVariant.hostname = parsed.hostname.replace("boards.greenhouse.io", "job-boards.greenhouse.io");
      candidates.add(jobBoardsVariant.toString());
    }

    if (/myworkdayjobs\.com$/i.test(parsed.hostname) && /\/job\//i.test(parsed.pathname)) {
      const wday = new URL(parsed.toString());
      wday.pathname = wday.pathname.replace(/\/apply\/?$/i, "");
      candidates.add(wday.toString());
    }

    if (/jobs\.lever\.co$/i.test(parsed.hostname)) {
      const cleanLever = new URL(parsed.toString());
      cleanLever.searchParams.delete("lever-source");
      cleanLever.searchParams.delete("lever-via");
      candidates.add(cleanLever.toString());
    }
  } catch {
    // no-op
  }

  return Array.from(candidates);
}

async function fetchViaPlaywright(url: string): Promise<{ html: string; finalUrl: string } | null> {
  while (playwrightActiveFetches >= PLAYWRIGHT_MAX_PARALLEL_FETCHES) {
    await delay(300);
  }

  playwrightActiveFetches += 1;

  try {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
    });

    const page = await context.newPage();
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
      await page.waitForTimeout(1200);
      const html = await page.content();
      const finalUrl = page.url();
      return { html, finalUrl };
    } finally {
      await context.close();
      await browser.close();
    }
  } catch {
    return null;
  } finally {
    playwrightActiveFetches = Math.max(0, playwrightActiveFetches - 1);
  }
}

async function fetchBestJobPage(rawUrl: string): Promise<{ html: string; finalUrl: string } | null> {
  const candidates = buildCandidateUrls(rawUrl);

  for (const candidate of candidates) {
    try {
      const fetched = await fetchPageWithRetry(candidate, { maxAttempts: 3, baseDelayMs: 700 });
      if (fetched.html && fetched.html.length >= 200) {
        return fetched;
      }
    } catch {
      continue;
    }
  }

  // Playwright launches a fresh headless browser per fetch (90s timeout each) and
  // hangs hard when the egress proxy rotates mid-fetch. STAGE2_NO_PLAYWRIGHT=1
  // skips it entirely — jobs that would need it fall back to Stage 1's description
  // in enrichJobFromUrl rather than being lost.
  if (process.env.STAGE2_NO_PLAYWRIGHT === "1") return null;
  const shouldUsePlaywright = candidates.some((candidate) => isKnownAtsHost(candidate));
  if (!shouldUsePlaywright) return null;

  for (const candidate of candidates.slice(0, 2)) {
    const fetched = await fetchViaPlaywright(candidate);
    if (fetched && fetched.html && fetched.html.length >= 200) {
      return fetched;
    }
  }

  return null;
}

function fixMojibake(text: string): string {
  return text
    .replace(/\u00E2\u20AC\u2122/g, "\u2019")
    .replace(/\u00E2\u20AC\u02DC/g, "\u2018")
    .replace(/\u00E2\u20AC\u0153/g, "\u201C")
    .replace(/\u00E2\u20AC\u009D/g, "\u201D")
    .replace(/\u00E2\u20AC\u201D/g, "\u2014")
    .replace(/\u00E2\u20AC\u201C/g, "\u2013")
    .replace(/\u00E2\u20AC\u00A6/g, "\u2026")
    .replace(/\u00C2\u00A0/g, " ")
    .replace(/\u00C2\u00B7/g, "\u00B7")
    .replace(/\u00E2\u20AC\u200B/g, "")
    .replace(/\u00E2\u0080[\u0090-\u009F]/g, "-")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\u2026/g, "...");
}

function cleanText(value: string | null | undefined): string {
  if (!value) return "";
  return fixMojibake(value)
    .replace(/\u00A0/g, " ")
    .replace(/[\t\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function nonEmpty(value: string | null | undefined): string | null {
  const cleaned = cleanText(value);
  return cleaned ? cleaned : null;
}

function normalizeRootWebsite(url: string): string | null {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.hostname}`;
  } catch {
    return null;
  }
}

function tryParseJson(value: string): unknown | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function extractJsonLdJobPosting(html: string): Record<string, unknown> | null {
  const $ = load(html);
  const scripts = $("script[type='application/ld+json']").toArray();
  const parsedValues: unknown[] = [];

  for (const script of scripts) {
    const parsed = tryParseJson($(script).text());
    if (parsed) parsedValues.push(parsed);
  }

  const queue: unknown[] = [...parsedValues];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;

    if (Array.isArray(current)) {
      for (const item of current) queue.push(item);
      continue;
    }

    if (typeof current !== "object") continue;
    const record = current as Record<string, unknown>;
    const rawType = record["@type"];
    const typeValue = Array.isArray(rawType) ? rawType.join(" ") : String(rawType ?? "");

    if (/jobposting/i.test(typeValue)) return record;

    for (const nested of Object.values(record)) queue.push(nested);
  }

  return null;
}

function sanitizeDescription(raw: string): string {
  let text = raw;

  for (const marker of DESCRIPTION_CUTOFF_MARKERS) {
    const index = text.indexOf(marker);
    if (index > 0) {
      text = text.slice(0, index);
    }
  }

  text = text
    .replace(/\.remix-css-[a-z0-9-]+\{[^}]*\}/gi, " ")
    .replace(/\b[A-Za-z0-9_-]+\{[^}]{0,240}\}/g, " ")
    .replace(/\b(Select\.\.\.|AttachDropboxGoogle Drive|Enter manually)\b/gi, " ");

  return cleanText(text).slice(0, 15000);
}

function cleanDescriptionWithTitle(description: string, title: string): string {
  let d = cleanText(description);
  const t = cleanText(title);

  d = d.replace(
    /\bBack\s+Apply\s+Share\s+(?:Facebook|X|Twitter|LinkedIn|Email)(?:\s+(?:Facebook|X|Twitter|LinkedIn|Email))*\b/gi,
    " "
  );
  d = d.replace(/\bBack\s+to\s+jobs\b/gi, " ");
  d = d.replace(/\bCreate\s+a\s+Job\s+Alert\b/gi, " ");
  d = d.replace(/\bLocation:\s*[^.]{0,180}?\bTime\s+Type:\s*[^.]{0,120}/gi, " ");

  if (t && d.toLowerCase().startsWith(t.toLowerCase())) {
    d = d.slice(t.length).trim();
    d = d.replace(/^[^.!?]{0,140}?apply\s*/i, "");
  }

  d = d.replace(/([a-z])Apply([A-Z])/g, "$1 $2");
  d = d.replace(
    /^\s*(new\s+)?(apply\s+|share\s+|facebook\s+|x\s+|twitter\s+|linkedin\s+|email\s+)+/i,
    ""
  );
  d = d.replace(/^\s*description\s*/i, "");

  return cleanText(d);
}

function extractDescription(html: string, jsonLdJob: Record<string, unknown> | null): string {
  if (jsonLdJob) {
    const jsonDescription = nonEmpty(String(jsonLdJob.description ?? ""));
    if (jsonDescription && jsonDescription.length > 80) return sanitizeDescription(jsonDescription);
  }

  const $ = load(html);
  let best = "";
  for (const selector of DESCRIPTION_SELECTORS) {
    const text = cleanText($(selector).text());
    if (text.length > best.length) best = text;
  }

  if (best.length >= 80) return sanitizeDescription(best);

  const metaDescription =
    nonEmpty($("meta[property='og:description']").attr("content")) ??
    nonEmpty($("meta[name='description']").attr("content"));

  if (metaDescription) {
    const cleanedMeta = sanitizeDescription(metaDescription);
    if (/^Explore corporate jobs and career programs at Amazon/i.test(cleanedMeta)) {
      return "For job details, click apply.";
    }
    return cleanedMeta;
  }
  return "For job details, click apply.";
}

function emptyLocation(): ApiLocation {
  return {
    placeId: "",
    name: "",
    formattedAddress: "",
    latitude: 0,
    longitude: 0,
    city: "",
    state: "",
    country: ""
  };
}

function expandCountry(value: string): string {
  const normalized = value.trim().toUpperCase();
  return COUNTRY_CODE_MAP[normalized] ?? value.trim();
}

function isLikelyLocationPhrase(raw: string): boolean {
  const value = cleanText(raw);
  if (!value || value.length > 90) return false;
  if (LOCATION_NOISE_PATTERN.test(value)) return false;
  if (/[{}<>]/.test(value)) return false;

  const wordCount = value.split(/\s+/).length;
  if (wordCount > 8 && !/\bremote\b/i.test(value)) return false;

  return true;
}

function normalizeRemoteRegion(raw: string): ApiLocation {
  const base = emptyLocation();
  const regionMatch = raw.match(/remote\s*[-:,]?\s*(global|worldwide|emea|apac|latam|europe|asia|usa|us|uk|canada|india)/i);
  const region = regionMatch?.[1] ? regionMatch[1].toUpperCase() : "";
  return {
    ...base,
    name: region ? `Remote (${region})` : "Remote",
    formattedAddress: region ? `Remote - ${region}` : "Remote",
    city: "Remote",
    state: region,
    country: region === "US" || region === "USA" ? "United States" : ""
  };
}

function parseDelimitedLocation(raw: string): ApiLocation | null {
  const base = emptyLocation();
  const cleaned = raw
    .replace(/[|]/g, ",")
    .replace(/[\u2022]/g, ",")
    .replace(/\s+-\s+/g, ",")
    .replace(/\s*\/\s*/g, ",")
    .replace(/,+/g, ",")
    .trim();

  if (!cleaned) return null;

  const chunks = cleaned
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

  if (chunks.length === 0) return null;

  let city = chunks[0] ?? "";
  let state = chunks[1] ?? "";
  let country = chunks[2] ?? "";

  if (chunks.length === 2) {
    const secondUpper = state.toUpperCase();
    if (US_STATES.has(secondUpper)) {
      state = secondUpper;
      country = "United States";
    } else if (CA_PROVINCES.has(secondUpper)) {
      state = secondUpper;
      country = "Canada";
    } else if (secondUpper.length <= 3 && COUNTRY_CODE_MAP[secondUpper]) {
      country = COUNTRY_CODE_MAP[secondUpper];
      state = "";
    } else if (state.length > 3) {
      country = state;
      state = "";
    }
  }

  if (!state) {
    const cityStateMatch = city.match(/^(.+?)\s+([A-Za-z]{2,3})$/);
    if (cityStateMatch?.[1] && cityStateMatch[2]) {
      city = cityStateMatch[1].trim();
      const stateOrCountry = cityStateMatch[2].toUpperCase();
      if (US_STATES.has(stateOrCountry)) {
        state = stateOrCountry;
        country = "United States";
      } else if (CA_PROVINCES.has(stateOrCountry)) {
        state = stateOrCountry;
        country = "Canada";
      } else {
        country = expandCountry(stateOrCountry);
      }
    }
  }

  if (country && country.length <= 3) country = expandCountry(country);

  if (!isLikelyLocationPhrase([city, state, country].filter(Boolean).join(", "))) {
    return null;
  }

  const nameParts = [city, state || country].filter(Boolean);
  return {
    ...base,
    name: nameParts.join(", "),
    formattedAddress: cleanText(raw),
    city,
    state,
    country
  };
}

function parseLocationString(rawInput: string | null | undefined): ApiLocation | null {
  const raw = cleanText(rawInput);
  if (!raw || /^not specified$/i.test(raw) || /^n\/?a$/i.test(raw)) return null;

  if (/\bremote\b/i.test(raw)) {
    return normalizeRemoteRegion(raw);
  }

  const firstCandidate = raw
    .split(/\s*[;|\u2022]\s*/)
    .map((part) => part.trim())
    .find((part) => part && isLikelyLocationPhrase(part));

  const candidate = firstCandidate ?? raw;
  if (!isLikelyLocationPhrase(candidate)) return null;

  const parsed = parseDelimitedLocation(candidate);
  if (parsed) return parsed;

  return {
    ...emptyLocation(),
    name: candidate,
    formattedAddress: candidate,
    city: candidate
  };
}

function extractLocationFromJsonLd(jsonLdJob: Record<string, unknown>): ApiLocation | null {
  const jobLocation = jsonLdJob.jobLocation;
  if (!jobLocation) return null;

  const entry = Array.isArray(jobLocation) ? jobLocation[0] : jobLocation;
  if (!entry || typeof entry !== "object") return null;
  const record = entry as Record<string, unknown>;

  const address = record.address;
  if (!address || typeof address !== "object") return null;
  const addressRecord = address as Record<string, unknown>;

  const city = cleanText(String(addressRecord.addressLocality ?? ""));
  const state = cleanText(String(addressRecord.addressRegion ?? ""));
  const country = cleanText(String(addressRecord.addressCountry ?? ""));
  const postal = cleanText(String(addressRecord.postalCode ?? ""));
  const formattedAddress = [city, state, postal, country].filter(Boolean).join(", ");

  const built = {
    ...emptyLocation(),
    name: [city, state].filter(Boolean).join(", "),
    formattedAddress,
    city,
    state,
    country: country.length <= 3 ? expandCountry(country) : country
  };

  return isLikelyLocationPhrase(built.formattedAddress || built.name) ? built : null;
}

function extractLocation(
  seedLocation: string,
  jsonLdJob: Record<string, unknown> | null,
  description: string
): ApiLocation | null {
  const fromSeed = parseLocationString(seedLocation);
  if (fromSeed) return fromSeed;

  if (jsonLdJob) {
    const fromJson = extractLocationFromJsonLd(jsonLdJob);
    if (fromJson) return fromJson;
  }

  const descriptionLocationMatch = description.match(
    /\b(location|based in|office location|work location)\s*[:\-]\s*([A-Za-z .'-]{3,80}(?:,\s*[A-Za-z .'-]{2,40}){0,3})/i
  );
  if (descriptionLocationMatch?.[2]) {
    const fromDescription = parseLocationString(descriptionLocationMatch[2]);
    if (fromDescription) return fromDescription;
  }

  return null;
}

function inferJobType(
  title: string,
  description: string,
  jsonLdJob: Record<string, unknown> | null
): JobTypeValue {
  const combined = `${title} ${description}`.toLowerCase();
  const employmentType = cleanText(String(jsonLdJob?.employmentType ?? "")).toLowerCase();
  const fromJson = `${employmentType} ${combined}`;

  if (/\b(intern|internship|temporary|fixed[- ]term|contract)\b/.test(fromJson)) return "GIG";
  if (/\b(part[- ]?time)\b/.test(fromJson)) return "PARTTIME";
  if (/\b(freelance|contractor)\b/.test(fromJson)) return "FREELANCE";
  return "FULLTIME";
}

function inferWorkType(
  location: ApiLocation | null,
  title: string,
  description: string,
  jsonLdJob: Record<string, unknown> | null
): WorkTypeValue | null {
  // Check JSON-LD jobLocationType first (most reliable)
  const locationType = cleanText(String(jsonLdJob?.jobLocationType ?? "")).toUpperCase();
  if (locationType === "TELECOMMUTE") return "REMOTE";

  const combined = `${title} ${description} ${location?.formattedAddress ?? ""}`.toLowerCase();
  if (/\b(remote|work from home|distributed)\b/.test(combined)) return "REMOTE";
  if (/\b(hybrid|flexible office)\b/.test(combined)) return "HYBRID";
  if (/\b(on[- ]?site|onsite|in office|studio based)\b/.test(combined)) return "ONSITE";
  return null;
}

function normalizePeriod(input: string): SalaryPeriodValue | null {
  const text = input.toLowerCase();
  if (text.includes("hour")) return "HOURLY";
  if (text.includes("day")) return "DAILY";
  if (text.includes("week")) return "WEEKLY";
  if (text.includes("month")) return "MONTHLY";
  if (text.includes("year") || text.includes("annual")) return "ANNUAL";
  if (text.includes("one") || text.includes("fixed")) return "ONE_TIME";
  return null;
}

function parseMoneyToken(token: string): number | null {
  const cleaned = token.replace(/[,$]/g, "").trim().toLowerCase();
  const multiplier = cleaned.endsWith("k") ? 1000 : cleaned.endsWith("m") ? 1000000 : 1;
  const numeric = Number(cleaned.replace(/[km]$/, ""));
  if (!Number.isFinite(numeric)) return null;
  return numeric * multiplier;
}

function extractSalary(
  description: string,
  jsonLdJob: Record<string, unknown> | null
): ApiSalary | null {
  const fromJson = jsonLdJob?.baseSalary as Record<string, unknown> | undefined;
  if (fromJson && typeof fromJson === "object") {
    const currency = cleanText(String(fromJson.currency ?? "USD")) || "USD";
    const value = fromJson.value as Record<string, unknown> | undefined;
    const min = value ? Number(value.minValue ?? NaN) : NaN;
    const max = value ? Number(value.maxValue ?? NaN) : NaN;
    const unitText = value ? String(value.unitText ?? "") : "";
    const period = normalizePeriod(unitText);

    if (Number.isFinite(min) || Number.isFinite(max)) {
      return {
        min: Number.isFinite(min) ? min : null,
        max: Number.isFinite(max) ? max : null,
        currency,
        period
      };
    }
  }

  const rangeMatch = description.match(
    /([$€£])\s?([0-9]{2,3}(?:,[0-9]{3})*(?:\.[0-9]+)?[kKmM]?)\s*(?:-|to)\s*([$€£])?\s?([0-9]{2,3}(?:,[0-9]{3})*(?:\.[0-9]+)?[kKmM]?)\s*(?:per|\/)??\s*(hour|day|week|month|year|annual)?/i
  );

  if (!rangeMatch) return null;

  const symbol = rangeMatch[1] ?? "$";
  const min = parseMoneyToken(rangeMatch[2]);
  const max = parseMoneyToken(rangeMatch[4]);
  const period = rangeMatch[5] ? normalizePeriod(rangeMatch[5]) : null;

  let inferredPeriod = period;
  if (!inferredPeriod && min !== null) {
    if (min >= 10000) inferredPeriod = "ANNUAL";
    else if (min >= 1000) inferredPeriod = "MONTHLY";
    else if (min >= 100) inferredPeriod = "DAILY";
    else inferredPeriod = "HOURLY";
  }

  let currency = "USD";
  if (symbol === "€") currency = "EUR";
  if (symbol === "£") currency = "GBP";

  return {
    min,
    max,
    currency,
    period: inferredPeriod
  };
}

function extractKeywordsFromJsonLd(jsonLdJob: Record<string, unknown>): string[] {
  const keywords: string[] = [];
  for (const field of ["occupationalCategory", "industry", "qualifications"]) {
    const val = jsonLdJob[field];
    if (typeof val === "string" && val.trim()) {
      keywords.push(...val.split(/[,;|]/).map(s => s.trim().toLowerCase()).filter(Boolean));
    }
    if (Array.isArray(val)) {
      keywords.push(...val.filter((s): s is string => typeof s === "string" && s.trim().length > 0).map(s => s.trim().toLowerCase()));
    }
  }
  return [...new Set(keywords)].filter(k => k.length >= 2 && !KEYWORD_BLOCKLIST.has(k));
}

function extractKeywords(title: string, description: string, jsonLdJob: Record<string, unknown> | null): string[] {
  const jsonLdKeywords = jsonLdJob ? extractKeywordsFromJsonLd(jsonLdJob) : [];

  const combined = `${title} ${description}`.toLowerCase();
  const keywords = new Set<string>(jsonLdKeywords);

  for (const term of KEYWORD_TERMS) {
    if (combined.includes(term)) keywords.add(term);
  }

  return Array.from(keywords).filter(k => !KEYWORD_BLOCKLIST.has(k)).slice(0, 20);
}

function normalizeSkillToken(raw: string): string | null {
  const cleaned = raw
    .replace(/[()\[\]{}]/g, " ")
    .replace(/[^a-zA-Z0-9+.#\- ]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

  if (!cleaned || cleaned.length < 2 || cleaned.length > 45) return null;
  if (SKILL_STOP_WORDS.has(cleaned)) return null;
  return cleaned;
}

function canonicalizeSkill(candidate: string): string {
  const normalized = normalizeSkillToken(candidate);
  if (!normalized) return "";

  for (const [canonical, aliases] of Object.entries(SKILL_TAXONOMY)) {
    for (const alias of aliases) {
      if (normalized === alias || normalized.includes(alias) || alias.includes(normalized)) {
        return canonical;
      }
    }
  }

  return normalized.replace(/\s+/g, "_");
}

function isValidSkillToken(token: string): boolean {
  if (!token || token.length < 2) return false;
  const words = token.split(/_+/).filter(Boolean);
  if (words.length > 4) return false;
  const sentenceWords = new Set(["the", "to", "they", "that", "this", "their", "them", "need", "deliver", "enable", "companies", "tracks"]);
  const sentenceWordCount = words.filter(w => sentenceWords.has(w)).length;
  if (sentenceWordCount >= 2) return false;
  if (token.length > 40) return false;
  return true;
}

function extractSkillsFromJsonLd(jsonLdJob: Record<string, unknown>): string[] {
  const raw = jsonLdJob.skills;
  if (!raw) return [];

  let tokens: string[] = [];
  if (typeof raw === "string") {
    tokens = raw.split(/[,;|]/).map(s => s.trim().toLowerCase().replace(/\s+/g, "_")).filter(Boolean);
  } else if (Array.isArray(raw)) {
    tokens = raw
      .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
      .map(s => s.trim().toLowerCase().replace(/\s+/g, "_"));
  }

  const validated: string[] = [];
  for (const token of tokens) {
    const canonical = canonicalizeSkill(token.replace(/_/g, " "));
    if (canonical && isValidSkillToken(canonical)) {
      validated.push(canonical);
    } else if (isValidSkillToken(token)) {
      validated.push(token);
    }
  }

  return [...new Set(validated)];
}

function extractSkills(title: string, description: string, jsonLdJob: Record<string, unknown> | null): string[] {
  const jsonLdSkills = jsonLdJob ? extractSkillsFromJsonLd(jsonLdJob) : [];

  const lower = `${title} ${description}`.toLowerCase();
  const extracted = new Set<string>(jsonLdSkills);

  for (const [canonical, aliases] of Object.entries(SKILL_TAXONOMY)) {
    for (const alias of aliases) {
      const regex = new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\b`, "i");
      if (regex.test(lower)) {
        extracted.add(canonical);
        break;
      }
    }
  }

  const skillPhrasePattern =
    /\b(proficiency in|experience with|expertise in|strong knowledge of|hands[- ]on with|skilled in)\s+([^.;:\n]{3,160})/gi;
  let match: RegExpExecArray | null = skillPhrasePattern.exec(description);
  while (match) {
    const phrase = match[2] ?? "";
    const segments = phrase
      .split(/,| and | or |\/|\|/i)
      .map((token) => normalizeSkillToken(token))
      .filter((value): value is string => Boolean(value));

    for (const segment of segments) {
      const canonical = canonicalizeSkill(segment);
      if (canonical) extracted.add(canonical);
    }

    match = skillPhrasePattern.exec(description);
  }

  for (const titleToken of title.split(/[,:|\-/]/)) {
    const canonical = canonicalizeSkill(titleToken);
    if (canonical) extracted.add(canonical);
  }

  return Array.from(extracted).filter(isValidSkillToken).slice(0, 30);
}

function extractDeadline(
  description: string,
  jsonLdJob: Record<string, unknown> | null
): string | null {
  const validThrough = nonEmpty(String(jsonLdJob?.validThrough ?? ""));
  if (validThrough) {
    const parsed = new Date(validThrough);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }

  const deadlineMatch = description.match(
    /\b(apply by|application deadline|deadline)\s*[:\-]?\s*([A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4})/i
  );
  if (!deadlineMatch?.[2]) return null;
  const parsed = new Date(deadlineMatch[2]);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function extractNumberOfPositions(description: string): number | null {
  const match = description.match(/\b(\d{1,3})\s+(openings?|positions?)\b/i);
  if (!match?.[1]) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function extractEmail(html: string, description: string): string | null {
  const mailtoMatches = Array.from(html.matchAll(/mailto:([^"'?\s>]+)/gi))
    .map(m => cleanText(m[1]))
    .filter(Boolean);
  const textMatches = Array.from((`${html}\n${description}`).matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi))
    .map(m => cleanText(m[0]))
    .filter(Boolean);

  const candidates = [...new Set([...mailtoMatches, ...textMatches].map(e => e.toLowerCase()))];
  if (candidates.length === 0) return null;

  const preferred = candidates.find(value =>
    !/no-?reply|donotreply|privacy|gdpr|legal|unsubscribe|support|info|hello|contact|admin|postmaster/i.test(value)
  );
  return preferred ?? null;
}

const ATS_HOSTS = new Set([
  "greenhouse.io", "lever.co", "workday.com", "myworkdayjobs.com",
  "smartrecruiters.com", "ashbyhq.com", "breezy.hr", "recruitee.com",
  "jobs.lever.co", "boards.greenhouse.io", "jobvite.com", "icims.com",
  "ultipro.com", "taleo.net", "successfactors.com", "applytojob.com",
]);

const GENERIC_SUBDOMAINS = new Set([
  "careers", "career", "jobs", "job", "job-boards", "boards", "apply",
  "hire", "hiring", "recruiting", "recruitment", "work", "www",
]);

function cleanCompanyName(name: string): string {
  return name.replace(/^[A-Z]{2,6}-/, "").trim() || name;
}

function splitJoinedCompanyName(name: string): string {
  if (name.includes(" ") || name.length <= 6) return name;
  const camelSplit = name.replace(/([a-z])([A-Z])/g, "$1 $2");
  if (camelSplit !== name) return camelSplit;
  return name;
}

function deriveCompanyFromUrl(url: string): ApiCompany | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./i, "");
    const parts = host.split(".");
    const baseDomain = parts.slice(-2).join(".");

    if (ATS_HOSTS.has(baseDomain) || ATS_HOSTS.has(parts.slice(-3).join("."))) {
      const subdomain = parts.length > 2 ? parts[0] : null;
      if (subdomain && !GENERIC_SUBDOMAINS.has(subdomain.toLowerCase())) {
        const name = subdomain.charAt(0).toUpperCase() + subdomain.slice(1);
        return { name, website: null, logo: null, email: null };
      }
      const pathParts = parsed.pathname.split("/").filter(Boolean);
      if (pathParts.length > 0 && !GENERIC_SUBDOMAINS.has(pathParts[0].toLowerCase())) {
        const name = pathParts[0].charAt(0).toUpperCase() + pathParts[0].slice(1);
        return { name, website: null, logo: null, email: null };
      }
      return null;
    }

    let companyPart: string | null = null;
    for (const part of parts) {
      if (!GENERIC_SUBDOMAINS.has(part.toLowerCase()) && part !== parts[parts.length - 1]) {
        if (part.length <= 3 && /^(com|org|net|io|co|eu|us|uk|de|fr|in|au|ca)$/i.test(part)) continue;
        companyPart = part;
        break;
      }
    }

    if (!companyPart && parts.length >= 2) {
      const sld = parts[parts.length - 2];
      if (!GENERIC_SUBDOMAINS.has(sld.toLowerCase())) {
        companyPart = sld;
      }
    }

    if (companyPart) {
      const name = companyPart.charAt(0).toUpperCase() + companyPart.slice(1);
      return { name: splitJoinedCompanyName(name), website: `https://${host}`, logo: null, email: null };
    }
  } catch { /* no-op */ }
  return null;
}

function extractCompany(
  seed: NormalizedJob,
  finalUrl: string,
  jsonLdJob: Record<string, unknown> | null,
  email: string | null
): ApiCompany | null {
  const org = jsonLdJob?.hiringOrganization;
  const orgRecord = org && typeof org === "object" ? (org as Record<string, unknown>) : null;

  let name: string | null = null;
  let website: string | null = null;

  if (orgRecord) {
    const rawName = cleanText(String(orgRecord.name ?? ""));
    name = cleanCompanyName(rawName) || null;
    website = nonEmpty(String(orgRecord.sameAs ?? orgRecord.url ?? ""));
  }

  if (!name) name = nonEmpty(seed.company);

  if (!name) {
    const fromUrl = deriveCompanyFromUrl(finalUrl);
    if (fromUrl) {
      name = fromUrl.name ?? null;
      website = website ?? fromUrl.website ?? null;
    }
  }

  if (!name) name = "Unknown";

  return {
    name,
    website: website ?? normalizeRootWebsite(finalUrl),
    logo: null,
    email
  };
}

function isCareersPageTitle(title: string): boolean {
  return /^.{2,30}\s+(careers?|jobs?|openings?|opportunities)$/i.test(title.trim());
}

function extractTitle(html: string, seedTitle: string, jsonLdJob: Record<string, unknown> | null): string {
  const fromJson = nonEmpty(String(jsonLdJob?.title ?? ""));
  if (fromJson && !isCareersPageTitle(fromJson)) return fromJson;

  const $ = load(html);
  const fromHeading = nonEmpty($("h1").first().text());
  if (fromHeading && fromHeading.length > 3 && fromHeading.length < 200 && !isCareersPageTitle(fromHeading)) return fromHeading;

  const fromTitle = nonEmpty($("title").first().text());
  if (fromTitle && !isCareersPageTitle(fromTitle)) return fromTitle;

  return seedTitle;
}

/**
 * Sanitize a datePosted value to an ISO date string (YYYY-MM-DD or full ISO).
 * Returns null if the value is absent or unparseable.
 */
function sanitizeDatePosted(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Already a valid ISO date/datetime?
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  // Return YYYY-MM-DD format
  return parsed.toISOString().slice(0, 10);
}

export async function enrichJobFromUrl(params: {
  seed: NormalizedJob;
  hiringTeamUid: string;
  minCreativeScore?: number;
}): Promise<EnrichedJobRecord | null> {
  const { seed, hiringTeamUid, minCreativeScore = 2 } = params;
  const fetched = await fetchBestJobPage(seed.url);

  let fetchedHtml: string;
  let finalUrl: string;
  if (fetched) {
    fetchedHtml = fetched.html;
    finalUrl = fetched.finalUrl;
  } else {
    // HTTP fetch failed (and Playwright is disabled/skipped). Don't drop the job
    // if Stage 1 already captured a usable description — synthesize from seed
    // data. ~88% of ATS jobs carry a full description from the Stage 1 API.
    const seedDesc = seed.description?.trim() || "";
    if (seedDesc.length < 120) return null;
    fetchedHtml = "";
    finalUrl = seed.url;
  }

  const jsonLdJob = extractJsonLdJobPosting(fetchedHtml);

  // Self-expanding loop (JobsDrop Task 4): each job-detail page is the richest
  // source of hiringOrganization.sameAs JSON-LD. Harvest any company domains we
  // don't already track into new_companies_discovered.json (flushed once in
  // Stage 2 main). Never break enrichment if extraction throws.
  try {
    recordDiscoveredDomains(extractDiscoveredDomains(fetchedHtml));
  } catch {
    // discovery is best-effort; enrichment must never depend on it
  }

  let title = extractTitle(fetchedHtml, seed.title, jsonLdJob);
  let fetchedDescription = extractDescription(fetchedHtml, jsonLdJob);
  fetchedDescription = cleanDescriptionWithTitle(fetchedDescription, title);

  // Prefer the ATS API-provided description when it's substantially longer than
  // what was fetched from the HTML page (or when the HTML fetch yielded a thin
  // placeholder). This avoids the flaky per-job HTML fetch for ATS jobs that
  // already carry the full description in Stage 1.
  const apiDescription = seed.description?.trim() || null;
  let description: string;
  const API_PREFER_THRESHOLD = 300; // chars: HTML fetch below this → prefer API description

  if (apiDescription && apiDescription.length > 200) {
    const fetchedIsWeak = fetchedDescription.length < API_PREFER_THRESHOLD ||
      /^for job details, click apply\.?$/i.test(fetchedDescription.trim());
    // Use whichever is longer; tie goes to API description (more reliable)
    if (fetchedIsWeak || apiDescription.length >= fetchedDescription.length) {
      description = apiDescription;
    } else {
      description = fetchedDescription;
    }
  } else {
    description = fetchedDescription;
  }

  const passesGate = passesCreativeGate({
    title,
    description,
    url: finalUrl,
    minScore: minCreativeScore
  });

  if (!passesGate) {
    const seedIsCreative = isCreativeTitleStrict(seed.title);
    const weakDescription =
      description.length < 60 ||
      /\b(apply for this job|create a job alert|autofill|voluntary self-identification|resume\/cv)\b/i.test(
        description
      );
    const atsLikelyUrl = isKnownAtsHost(finalUrl) || /\/(job|jobs|position|opening|careers?)\b/i.test(finalUrl);

    if (!(seedIsCreative && (weakDescription || atsLikelyUrl))) {
      return null;
    }

    title = seed.title;
    if (weakDescription) {
      description = "For job details, click apply.";
    }
  }

  const creativeScore = scoreCreativeText(`${title} ${description} ${finalUrl}`);
  const location = extractLocation(seed.location, jsonLdJob, description);
  const workType = inferWorkType(location, title, description, jsonLdJob);
  const jobType = inferJobType(title, description, jsonLdJob);
  const salary = extractSalary(description, jsonLdJob);
  const deadline = extractDeadline(description, jsonLdJob);
  const numberOfPositions = extractNumberOfPositions(description);
  const workEmail = extractEmail(fetchedHtml, description);
  const company = extractCompany(seed, finalUrl, jsonLdJob, workEmail);
  const keywords = extractKeywords(title, description, jsonLdJob);
  const skills = extractSkills(title, description, jsonLdJob);

  const datePosted = sanitizeDatePosted(seed.datePosted);

  const apiJob: ApiCreateJobRequest = {
    title,
    description,
    deadline,
    datePosted,
    keywords,
    skills,
    jobType,
    location,
    salary,
    company,
    jobLink: finalUrl,
    hiringTeam: [hiringTeamUid],
    workEmail,
    numberOfPositions,
    workType,
    screeningQuestions: [],
    screeningRequired: false,
    allowEmailApplications: Boolean(finalUrl && (workEmail || company?.email))
  };

  return {
    apiJob,
    sourceUrl: seed.url,
    sourceCareerPage: seed.source,
    ats: seed.ats as ATS,
    creativeScore,
    extractedAt: new Date().toISOString()
  };
}




