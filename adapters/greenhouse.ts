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

  const jobs: RawJob[] = [];
  for (const job of ghJobs) {
    const title = job.title?.trim();
    const jobUrl = job.absolute_url?.trim();
    if (!title || !jobUrl) continue;

    jobs.push({
      title,
      url: jobUrl,
      location: job.location?.name?.trim() || null,
      ats: "greenhouse"
    });
  }

  return jobs;
}
