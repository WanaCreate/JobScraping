import * as cheerio from "cheerio";
import type { RawJob } from "../types.js";
import { extractJobsFromJson } from "../utils/extractJobsFromJson.js";
import { fetchPage, safeAbsoluteUrl } from "../utils/http.js";

const JOB_URL_HINT =
  /(\/(job|jobs|career|careers|position|positions|opening|openings|requisition|vacanc|opportunit)\b|jobdetail|\/search\/jobdetail)/i;
const JOB_TITLE_HINT =
  /\b(designer|design|artist|writer|producer|editor|engineer|developer|manager|director|specialist|analyst|research|intern)\b/i;
const PAGE_HINT =
  /(\/(jobs|job-search|jobsearch|careers|career|open-positions|opportunities|search)\b|\/c\/[a-z0-9-]+-jobs\b|work-with-us|join-us)/i;
const NOISE_TITLE =
  /\b(privacy|cookie|terms|faq|help|support|investor|press|newsroom|login|sign in|apply now|learn more|home)\b/i;

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function extractAnchors(html: string, baseUrl: string): { jobs: RawJob[]; nextPages: string[] } {
  const $ = cheerio.load(html);
  const jobs: RawJob[] = [];
  const nextPages: string[] = [];

  $("a[href]").each((_, element) => {
    const href = normalizeText($(element).attr("href") ?? "");
    const title = normalizeText($(element).text() ?? "");
    if (!href) return;

    const url = safeAbsoluteUrl(href, baseUrl);
    if (!url) return;

    if (PAGE_HINT.test(url)) nextPages.push(url);

    if (!title || title.length < 3 || title.length > 180) return;
    if (NOISE_TITLE.test(title)) return;
    if (!JOB_URL_HINT.test(url) && !JOB_TITLE_HINT.test(title)) return;

    jobs.push({
      title,
      url,
      location: null,
      ats: "generic"
    });
  });

  return { jobs, nextPages };
}

function extractEmbeddedJsonJobs(html: string, baseUrl: string): RawJob[] {
  const $ = cheerio.load(html);
  const jobs: RawJob[] = [];

  const jsonCandidates: string[] = [];

  $("script[type='application/ld+json'], script#__NEXT_DATA__").each((_, element) => {
    const content = $(element).html();
    if (content && content.trim()) jsonCandidates.push(content);
  });

  for (const raw of jsonCandidates) {
    try {
      const parsed = JSON.parse(raw);
      jobs.push(...extractJobsFromJson(parsed, baseUrl));
    } catch {
      continue;
    }
  }

  return jobs;
}

function extractRawJobUrls(html: string, baseUrl: string): string[] {
  const urls: string[] = [];
  const absoluteMatches = html.match(/https?:\/\/[^\s"<>]+/gi) ?? [];
  const escapedAbsoluteMatches = html.match(/https?:\\\/\\\/[^\s"<>]+/gi) ?? [];
  const relativeMatches = html.match(/\/(?:jobs?\/\d{3,}[^\s"<>]*|job\/[^\s"<>]{8,}|Search\/JobDetail\/[^\s"<>]+)/gi) ?? [];

  const cleaned = [...absoluteMatches, ...escapedAbsoluteMatches, ...relativeMatches].map((entry) =>
    entry
      .replace(/\\\//g, "/")
      .replace(/\\+/g, "")
      .replace(/&quot;/gi, "")
      .replace(/&amp;/gi, "&")
      .replace(/&#x2F;/gi, "/")
      .trim()
  );

  for (const candidate of cleaned) {
    if (!/(\/job\/|\/jobs?\/\d|\/Search\/JobDetail\/)/i.test(candidate)) continue;
    const absolute = safeAbsoluteUrl(candidate, baseUrl);
    if (absolute) urls.push(absolute);
  }

  return uniqueUrls(urls);
}

async function hydrateJobDetailPage(url: string): Promise<RawJob | null> {
  const looksLikeJobUrl = (candidate: string): boolean =>
    /(\/job\/|\/jobs?\/\d|\/Search\/JobDetail\/|greenhouse\.io|lever\.co|smartrecruiters\.com|myworkdayjobs\.com)/i.test(
      candidate
    );

  const noiseTitle = (value: string): boolean =>
    /^(join us in empowering everyone to create\.?|search results?|careers?|home)$/i.test(
      value.replace(/\s+/g, " ").trim()
    );

  const deriveTitleFromUrl = (jobUrl: string): string | null => {
    try {
      const parsed = new URL(jobUrl);
      const segments = parsed.pathname.split("/").filter(Boolean);
      if (segments.length === 0) return null;

      let slug = segments[segments.length - 1];
      if (slug.toLowerCase() === "apply" && segments.length > 1) slug = segments[segments.length - 2];
      slug = decodeURIComponent(slug);
      slug = slug.replace(/^xmlname-/i, "");
      slug = slug.replace(/_r\d+[a-z0-9-]*$/i, "");
      slug = slug.replace(/[-_]+/g, " ").trim();
      if (!slug || slug.length < 3 || slug.length > 180) return null;
      return slug;
    } catch {
      return null;
    }
  };

  const derivedTitle = deriveTitleFromUrl(url);

  try {
    const { html, finalUrl } = await fetchPage(url);
    const $ = cheerio.load(html);

    const titleCandidates = [
      $("h1").first().text(),
      $("[data-automation*='job-title']").first().text(),
      $('meta[property="og:title"]').attr("content"),
      $("title").first().text()
    ];
    const title = titleCandidates
      .map((value) => normalizeText(value ?? ""))
      .find((value) => value && value.length >= 3 && value.length <= 180);

    const chosenTitle = title && !noiseTitle(title) ? title : null;
    const resolvedTitle = chosenTitle ?? derivedTitle;
    if (!resolvedTitle) return null;

    const finalJobUrl = looksLikeJobUrl(finalUrl) ? finalUrl : url;

    const locationSelectors = [
      "[data-automation*='job-location']",
      "[class*='location']",
      "[id*='location']"
    ];
    let location: string | null = null;
    for (const selector of locationSelectors) {
      const text = normalizeText($(selector).first().text());
      if (text && text.length <= 120) {
        location = text;
        break;
      }
    }

    return {
      title: resolvedTitle.replace(/\s+\|\s+.*$/, "").trim(),
      url: finalJobUrl,
      location,
      ats: "generic"
    };
  } catch {
    if (!derivedTitle) return null;
    return {
      title: derivedTitle,
      url,
      location: null,
      ats: "generic"
    };
  }
}

async function hydrateJobDetails(urls: string[], limit = 24): Promise<RawJob[]> {
  const targets = uniqueUrls(urls).slice(0, limit);
  const jobs: RawJob[] = [];
  const concurrency = 5;
  let index = 0;

  const workers = Array.from({ length: Math.min(concurrency, targets.length) }, async () => {
    while (true) {
      const current = index;
      index += 1;
      if (current >= targets.length) break;
      const job = await hydrateJobDetailPage(targets[current]);
      if (job) jobs.push(job);
    }
  });

  await Promise.all(workers);
  return jobs;
}

function uniqueUrls(urls: string[]): string[] {
  return Array.from(new Set(urls));
}

function baseDomain(hostname: string): string {
  const host = hostname.toLowerCase().replace(/^www\./, "");
  const parts = host.split(".").filter(Boolean);
  if (parts.length <= 2) return host;

  const tld = parts[parts.length - 1] ?? "";
  const sld = parts[parts.length - 2] ?? "";
  const isCcTld = tld.length === 2;
  const isSecondLevelCc = isCcTld && /^(co|com|org|net|gov|ac|edu)$/i.test(sld);
  const keep = isSecondLevelCc ? 3 : 2;
  return parts.slice(-keep).join(".");
}

function isKnownAtsHost(hostname: string): boolean {
  return (
    /(greenhouse\.io|lever\.co|smartrecruiters\.com|myworkdayjobs\.com|icims\.com|amazon\.jobs|ashbyhq\.com|phenompeople\.com)$/i.test(
      hostname
    ) || hostname.toLowerCase().includes(".phenompeople.com")
  );
}

function isAllowedCrawlUrl(candidateUrl: string, rootUrl: string): boolean {
  try {
    const candidateHost = new URL(candidateUrl).hostname.toLowerCase();
    const rootHost = new URL(rootUrl).hostname.toLowerCase();
    if (candidateHost === rootHost) return true;

    if (isKnownAtsHost(candidateHost)) return true;

    const rootBase = baseDomain(rootHost);
    const sameCompany = candidateHost === rootBase || candidateHost.endsWith(`.${rootBase}`);
    if (!sameCompany) return false;

    if (/^(jobs|careers)\./i.test(candidateHost)) return true;
    return false;
  } catch {
    return false;
  }
}

function seedPaths(baseUrl: string): string[] {
  const guesses = new Set<string>([
    "/jobs",
    "/careers/jobs",
    "/career/jobs",
    "/search",
    "/job-search-results",
    "/search-results",
    "/c/design-jobs",
    "/c/marketing-and-strategy-jobs",
    "/c/engineering-and-product-jobs"
  ]);

  try {
    const pathname = new URL(baseUrl).pathname.replace(/\/+$/, "");
    const parts = pathname.split("/").filter(Boolean);
    if (parts.length >= 2) {
      const prefix = `/${parts[0]}/${parts[1]}`;
      guesses.add(`${prefix}/jobs`);
      guesses.add(`${prefix}/search-results`);
      guesses.add(`${prefix}/careers`);
      guesses.add(`${prefix}/c/design-jobs`);
      guesses.add(`${prefix}/c/marketing-and-strategy-jobs`);
      guesses.add(`${prefix}/c/engineering-and-product-jobs`);
    }
  } catch {
    // no-op
  }

  const seeded = Array.from(guesses)
    .map((path) => safeAbsoluteUrl(path, baseUrl))
    .filter((url): url is string => Boolean(url));

  const priority = (url: string): number => {
    let score = 0;
    if (url.includes("/us/en/search-results")) score += 120;
    if (url.includes("/us/en/c/")) score += 110;
    if (url.includes("/search-results")) score += 90;
    if (/\/c\/[a-z0-9-]+-jobs/i.test(url)) score += 80;
    if (url.includes("/us/en/jobs")) score += 70;
    if (url.endsWith("/jobs")) score += 60;
    return score;
  };

  return seeded.sort((a, b) => priority(b) - priority(a));
}

export async function scrapeGenericHtmlCrawler(params: {
  sourceUrl: string;
  initialHtml?: string;
  initialFinalUrl?: string;
  maxPages?: number;
}): Promise<{ jobs: RawJob[]; discoveredPages: string[] }> {
  const maxPages = params.maxPages ?? 8;
  const jobs: RawJob[] = [];
  const discoveredJobUrls = new Set<string>();
  const discoveredPages = new Set<string>();
  const toVisit: string[] = [];

  let startUrl = params.initialFinalUrl ?? params.sourceUrl;
  let startHtml = params.initialHtml ?? "";

  if (!startHtml) {
    const fetched = await fetchPage(params.sourceUrl);
    startUrl = fetched.finalUrl;
    startHtml = fetched.html;
  }

  const initial = extractAnchors(startHtml, startUrl);
  jobs.push(...initial.jobs);
  jobs.push(...extractEmbeddedJsonJobs(startHtml, startUrl));
  for (const jobUrl of extractRawJobUrls(startHtml, startUrl)) discoveredJobUrls.add(jobUrl);

  for (const candidate of [...seedPaths(startUrl), ...initial.nextPages]) {
    if (isAllowedCrawlUrl(candidate, startUrl)) toVisit.push(candidate);
  }

  const queue = uniqueUrls(toVisit);
  for (const pageUrl of queue) {
    if (discoveredPages.size >= maxPages) break;
    if (discoveredPages.has(pageUrl)) continue;
    discoveredPages.add(pageUrl);

    try {
      const { html, finalUrl } = await fetchPage(pageUrl);
      const extracted = extractAnchors(html, finalUrl);
      jobs.push(...extracted.jobs);
      jobs.push(...extractEmbeddedJsonJobs(html, finalUrl));
      for (const jobUrl of extractRawJobUrls(html, finalUrl)) discoveredJobUrls.add(jobUrl);

      for (const nextUrl of extracted.nextPages) {
        if (!isAllowedCrawlUrl(nextUrl, startUrl)) continue;
        if (discoveredPages.has(nextUrl)) continue;
        if (queue.includes(nextUrl)) continue;
        queue.push(nextUrl);
      }
    } catch {
      continue;
    }
  }

  if (discoveredJobUrls.size > 0) {
    const hydrated = await hydrateJobDetails(Array.from(discoveredJobUrls), 30);
    jobs.push(...hydrated);
  }

  return { jobs, discoveredPages: Array.from(discoveredPages) };
}
