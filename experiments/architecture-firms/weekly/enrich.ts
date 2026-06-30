/**
 * Stage 2 detail extractor (self-contained — lives under experiments/, mirrors the
 * main pipeline's technique without its creative-title gate, which would wrongly
 * drop "Project Architect" / "Job Captain" style roles).
 *
 * For one job URL it fetches the detail page (HTTP, with a Playwright fallback for
 * SPA pages) and pulls:
 *   - description  (JSON-LD JobPosting.description → content selectors → meta)
 *   - location     (JSON-LD jobLocation.address → description heuristic) — point 4
 *   - posted date  (JSON-LD datePosted → description heuristic) — point 4
 *   - work type    (remote / hybrid / onsite from text)
 *
 * Reuses only read-only repo helpers (fetchPageWithRetry, cheerio). No edits to
 * anything outside experiments/.
 */
import { load } from "cheerio";
import { chromium } from "playwright";
import { fetchPageWithRetry } from "../../../utils/http.js";

const DESCRIPTION_SELECTORS = [
  "[data-automation-id='jobPostingDescription']",
  "[data-automation-id='jobDescription']",
  "[data-qa='job-description']",
  "[data-testid*='description']",
  "[class*='JobDescription']",
  ".posting-description",
  ".job-description",
  ".job-details",
  ".iCIMS_InfoMsg_Job",
  "[class*='description']",
  ".description",
  "article",
  "main",
];

const SPA_HOST_HINT = /(dayforcehcm|jobvite|jobscore|paylocity|myworkdayjobs|icims|eightfold|bamboohr|hrmdirect|smartrecruiters|lever|greenhouse)/i;

export interface EnrichResult {
  finalUrl: string;
  description: string;
  location: string;
  locationSource: "jsonld" | "description" | "none";
  postedDate: string;          // raw value found on the page (ISO or relative text), "" if none
  postedDateSource: "jsonld" | "description" | "none";
  workType: string;            // REMOTE | HYBRID | ONSITE | ""
  fetched: boolean;
}

function clean(s: string | null | undefined): string {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

function tryJson(s: string): unknown | null {
  try { return JSON.parse(s.trim()); } catch { return null; }
}

/** Find the first JobPosting object anywhere in the page's JSON-LD blocks. */
function findJsonLdJobPosting(html: string): Record<string, unknown> | null {
  const $ = load(html);
  const queue: unknown[] = [];
  $("script[type='application/ld+json']").each((_, el) => {
    const parsed = tryJson($(el).text());
    if (parsed) queue.push(parsed);
  });
  while (queue.length) {
    const cur = queue.shift();
    if (!cur || typeof cur !== "object") continue;
    if (Array.isArray(cur)) { queue.push(...cur); continue; }
    const rec = cur as Record<string, unknown>;
    const type = Array.isArray(rec["@type"]) ? rec["@type"].join(" ") : String(rec["@type"] ?? "");
    if (/jobposting/i.test(type)) return rec;
    for (const v of Object.values(rec)) queue.push(v);
  }
  return null;
}

function locationFromJsonLd(job: Record<string, unknown>): string {
  const jl = job.jobLocation;
  const entry = Array.isArray(jl) ? jl[0] : jl;
  if (!entry || typeof entry !== "object") return "";
  const addr = (entry as Record<string, unknown>).address;
  if (!addr || typeof addr !== "object") return "";
  const a = addr as Record<string, unknown>;
  const parts = [a.addressLocality, a.addressRegion, a.addressCountry]
    .map((x) => clean(String(x ?? "")))
    .filter(Boolean);
  return parts.join(", ");
}

/** Heuristic: pull a "Location: City, ST" style phrase from free text. */
function locationFromText(text: string): string {
  const m = text.match(/\b(?:location|based in|office location|work location)\s*[:\-]\s*([A-Za-z .'-]{3,40}(?:,\s*[A-Za-z .'-]{2,40}){0,2})/i);
  return m?.[1] ? clean(m[1]) : "";
}

/** Heuristic: pull a posted date from free text when JSON-LD has none. */
function postedDateFromText(text: string): string {
  const labelled = text.match(/\b(?:posted(?:\s+on)?|date\s+posted|posting\s+date)\s*[:\-]?\s*([A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4}|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4})/i);
  if (labelled?.[1]) return clean(labelled[1]);
  const relative = text.match(/\bposted\s+(today|yesterday|\d+\+?\s*(?:hours?|days?|weeks?|months?)\s+ago)\b/i);
  if (relative?.[1]) return clean(relative[0]);
  return "";
}

function extractDescription(html: string, job: Record<string, unknown> | null): string {
  if (job) {
    const d = clean(String(job.description ?? ""));
    if (d.length > 80) {
      // JSON-LD descriptions are often HTML-encoded; strip tags.
      return clean(load(`<div>${d}</div>`).text()).slice(0, 15000);
    }
  }
  const $ = load(html);
  let best = "";
  for (const sel of DESCRIPTION_SELECTORS) {
    const t = clean($(sel).text());
    if (t.length > best.length) best = t;
  }
  if (best.length >= 80) return best.slice(0, 15000);
  const meta = clean($("meta[property='og:description']").attr("content") ?? $("meta[name='description']").attr("content"));
  return meta;
}

function inferWorkType(text: string): string {
  const t = text.toLowerCase();
  if (/\b(remote|work from home|telecommute|distributed)\b/.test(t)) return "REMOTE";
  if (/\b(hybrid|flexible office)\b/.test(t)) return "HYBRID";
  if (/\b(on[- ]?site|onsite|in[- ]office|studio[- ]based)\b/.test(t)) return "ONSITE";
  return "";
}

async function fetchViaPlaywright(url: string): Promise<{ html: string; finalUrl: string } | null> {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({
      ignoreHTTPSErrors: true,
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    });
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(1500);
    const html = await page.content();
    const finalUrl = page.url();
    await ctx.close();
    return { html, finalUrl };
  } catch {
    return null;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

/** Does this HTML already carry usable structured/long-form content? */
function hasUsableContent(html: string): boolean {
  if (!html || html.length < 500) return false;
  if (findJsonLdJobPosting(html)) return true;
  const $ = load(html);
  for (const sel of DESCRIPTION_SELECTORS) {
    if (clean($(sel).text()).length > 200) return true;
  }
  return false;
}

export async function enrichDetail(url: string, opts?: { allowPlaywright?: boolean }): Promise<EnrichResult> {
  const allowPlaywright = opts?.allowPlaywright ?? true;
  let html = "";
  let finalUrl = url;
  let fetched = false;

  // 1) Plain HTTP first.
  try {
    const res = await fetchPageWithRetry(url, { maxAttempts: 3, baseDelayMs: 600 });
    if (res?.html) { html = res.html; finalUrl = res.finalUrl || url; fetched = true; }
  } catch { /* fall through to playwright */ }

  // 2) Playwright fallback for SPA pages / when HTTP gave nothing usable.
  if (allowPlaywright && !hasUsableContent(html)) {
    const looksSpa = SPA_HOST_HINT.test(url) || !fetched;
    if (looksSpa) {
      const pw = await fetchViaPlaywright(url);
      if (pw?.html) { html = pw.html; finalUrl = pw.finalUrl || finalUrl; fetched = true; }
    }
  }

  if (!html) {
    return { finalUrl, description: "", location: "", locationSource: "none", postedDate: "", postedDateSource: "none", workType: "", fetched: false };
  }

  const job = findJsonLdJobPosting(html);
  const description = extractDescription(html, job);

  // Location: JSON-LD address → description heuristic.
  let location = job ? locationFromJsonLd(job) : "";
  let locationSource: EnrichResult["locationSource"] = location ? "jsonld" : "none";
  if (!location) {
    const fromText = locationFromText(description);
    if (fromText) { location = fromText; locationSource = "description"; }
  }

  // Posted date: JSON-LD datePosted → description heuristic.
  let postedDate = job && typeof job.datePosted === "string" ? clean(job.datePosted) : "";
  let postedDateSource: EnrichResult["postedDateSource"] = postedDate ? "jsonld" : "none";
  if (!postedDate) {
    const fromText = postedDateFromText(description);
    if (fromText) { postedDate = fromText; postedDateSource = "description"; }
  }

  const workType = inferWorkType(`${description}`);
  return { finalUrl, description, location, locationSource, postedDate, postedDateSource, workType, fetched: true };
}
