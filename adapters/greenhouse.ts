import type { RawJob } from "../types.js";
import { http } from "../utils/http.js";

interface GreenhouseJob {
  title?: string;
  absolute_url?: string;
  location?: { name?: string };
}

interface GreenhouseJobsResponse {
  jobs?: GreenhouseJob[];
}

interface GreenhouseBoardResponse {
  name?: string;
}

/**
 * Fetch the board's display name (e.g. "2K", "10x Genomics") so jobs carry the
 * real company rather than the "boards.greenhouse.io" hostname label. One call
 * per company; failures fall back to the tenant slug.
 */
async function fetchBoardName(tenant: string): Promise<string> {
  try {
    const response = await http.get<GreenhouseBoardResponse>(
      `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(tenant)}`
    );
    const name = response.data?.name?.trim();
    if (name) return name;
  } catch {
    // fall through to slug
  }
  return tenant;
}

/**
 * Scrape a Greenhouse board via the public no-auth JSON API.
 * boards-api.greenhouse.io serves both boards.greenhouse.io and the newer
 * job-boards.greenhouse.io slugs, and (unlike the HTML embed endpoint) does not
 * 403 under bulk load. Descriptions are fetched later in Stage 2.
 */
export async function scrapeGreenhouse(tenant: string): Promise<RawJob[]> {
  const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(tenant)}/jobs`;
  const response = await http.get<GreenhouseJobsResponse>(url);
  const ghJobs = response.data?.jobs ?? [];
  if (ghJobs.length === 0) return [];

  const company = await fetchBoardName(tenant);

  const jobs: RawJob[] = [];
  for (const job of ghJobs) {
    const title = job.title?.trim();
    const jobUrl = job.absolute_url?.trim();
    if (!title || !jobUrl) continue;

    jobs.push({
      title,
      url: jobUrl,
      location: job.location?.name?.trim() || null,
      company,
      ats: "greenhouse"
    });
  }

  return jobs;
}
