import * as cheerio from "cheerio";
import type { RawJob } from "../types.js";
import { http, safeAbsoluteUrl, withQuery } from "../utils/http.js";

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function extractJobsFromHtml(html: string, pageUrl: string): RawJob[] {
  const $ = cheerio.load(html);
  const jobs: RawJob[] = [];

  $("a").each((_, element) => {
    const href = ($(element).attr("href") ?? "").trim();
    if (!href) return;
    if (!/\/jobs\/\d+/i.test(href) || !/\/job/i.test(href)) return;

    const title = $(element).text().replace(/\s+/g, " ").trim();
    if (!title || title.length < 3) return;

    const absolute = safeAbsoluteUrl(href, pageUrl);
    if (!absolute) return;

    const rowText = $(element).closest("tr, li, div").text().replace(/\s+/g, " ").trim();
    const locationMatch = rowText.match(
      /\b(remote|[a-z .'-]+,\s*[a-z .'-]+(?:,\s*[a-z .'-]+)?)\b/i
    );

    jobs.push({
      title,
      url: absolute,
      location: locationMatch?.[1] ?? null,
      ats: "icims"
    });
  });

  return jobs;
}

function buildIcimsEndpoints(tenant: string | null, endpoints: string[]): string[] {
  const candidates = [...endpoints];
  if (tenant) {
    candidates.push(`https://${tenant}.icims.com/jobs/search?ss=1`);
  }
  return unique(candidates);
}

async function scrapeIcimsSearchEndpoint(endpoint: string): Promise<RawJob[]> {
  const jobs: RawJob[] = [];
  const maxPages = 50;
  let emptyStreak = 0;

  for (let page = 0; page < maxPages; page++) {
    const pagedUrl = withQuery(endpoint, {
      ss: 1,
      searchRelation: "keyword_all",
      page,
      pr: page
    });

    const response = await http.get<string>(pagedUrl, { responseType: "text" });
    const pageJobs = extractJobsFromHtml(response.data, pagedUrl);

    if (pageJobs.length === 0) {
      emptyStreak += 1;
      if (emptyStreak >= 2) break;
      continue;
    }

    emptyStreak = 0;
    jobs.push(...pageJobs);
  }

  return jobs;
}

export async function scrapeIcims(params: {
  tenant: string | null;
  endpoints: string[];
}): Promise<RawJob[]> {
  const candidates = buildIcimsEndpoints(params.tenant, params.endpoints);
  let lastError: unknown = null;

  for (const endpoint of candidates) {
    try {
      const jobs = await scrapeIcimsSearchEndpoint(endpoint);
      if (jobs.length > 0) return jobs;
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError) throw lastError;
  return [];
}
