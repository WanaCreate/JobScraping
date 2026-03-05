import type { RawJob } from "../types.js";
import { http, safeAbsoluteUrl } from "../utils/http.js";

interface WorkdayPosting {
  title?: string;
  externalPath?: string;
  locationsText?: string;
  bulletFields?: string[];
}

interface WorkdayResponse {
  total?: number;
  jobPostings?: WorkdayPosting[];
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function buildWorkdayCandidates(sourceUrl: string, tenant: string | null, endpoints: string[]): string[] {
  const candidates = [...endpoints];

  if (tenant) {
    const match = sourceUrl.match(/https?:\/\/([a-z0-9.-]*myworkdayjobs\.com)/i);
    if (match?.[1]) {
      const host = match[1];
      candidates.push(
        `https://${host}/wday/cxs/${tenant}/External/jobs`,
        `https://${host}/wday/cxs/${tenant}/Careers/jobs`
      );
    }
  }

  return unique(candidates);
}

function buildPostingUrl(endpoint: string, posting: WorkdayPosting): string | null {
  const externalPath = posting.externalPath?.trim();
  if (!externalPath) return null;
  if (/^https?:\/\//i.test(externalPath)) return externalPath;

  try {
    const endpointUrl = new URL(endpoint);
    return safeAbsoluteUrl(externalPath, endpointUrl.origin);
  } catch {
    return null;
  }
}

async function scrapeEndpoint(endpoint: string): Promise<RawJob[]> {
  const jobs: RawJob[] = [];
  const limit = 20;
  let offset = 0;
  const maxPages = 500;
  let page = 0;

  while (page < maxPages) {
    const response = await http.post<WorkdayResponse>(
      endpoint,
      {
        appliedFacets: {},
        limit,
        offset,
        searchText: ""
      },
      {
        headers: {
          "Content-Type": "application/json"
        }
      }
    );

    const postings = response.data?.jobPostings ?? [];
    if (postings.length === 0) break;

    for (const posting of postings) {
      jobs.push({
        title: posting.title ?? null,
        url: buildPostingUrl(endpoint, posting),
        location: posting.locationsText ?? posting.bulletFields?.[0] ?? null,
        ats: "workday"
      });
    }

    offset += limit;
    page += 1;
    if (postings.length < limit) break;
  }

  return jobs;
}

export async function scrapeWorkday(params: {
  sourceUrl: string;
  tenant: string | null;
  endpoints: string[];
}): Promise<RawJob[]> {
  const candidates = buildWorkdayCandidates(params.sourceUrl, params.tenant, params.endpoints);

  let lastError: unknown = null;
  for (const endpoint of candidates) {
    try {
      const jobs = await scrapeEndpoint(endpoint);
      if (jobs.length > 0) return jobs;
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError) throw lastError;
  return [];
}
