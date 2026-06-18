import type { RawJob } from "../types.js";
import { http } from "../utils/http.js";

interface WorkableLocation {
  country?: string;
  countryCode?: string;
  city?: string;
  region?: string | null;
  hidden?: boolean;
}

interface WorkableJob {
  title?: string;
  shortcode?: string;
  url?: string;
  shortlink?: string;
  country?: string;
  city?: string;
  state?: string;
  telecommuting?: boolean;
  locations?: WorkableLocation[];
}

interface WorkableResponse {
  name?: string;
  description?: string | null;
  jobs?: WorkableJob[];
}

function formatLocation(job: WorkableJob): string | null {
  if (job.telecommuting && !job.city && !job.country) return "Remote";

  const locations = job.locations ?? [];
  if (locations.length > 0) {
    const first = locations[0];
    const parts = [first.city, first.region, first.country].filter((p): p is string => Boolean(p));
    if (parts.length > 0) return parts.join(", ");
  }

  const parts = [job.city, job.state, job.country].filter((p): p is string => Boolean(p));
  if (parts.length > 0) return parts.join(", ");

  if (job.telecommuting) return "Remote";
  return null;
}

export async function scrapeWorkable(tenant: string): Promise<RawJob[]> {
  const url = `https://www.workable.com/api/accounts/${encodeURIComponent(tenant)}?details=true`;
  const response = await http.get<WorkableResponse>(url);
  const workableJobs = response.data?.jobs ?? [];

  if (workableJobs.length === 0) return [];

  // The account payload carries the company name; fall back to the tenant slug.
  const company = response.data?.name?.trim() || tenant;

  return workableJobs.map((job): RawJob => ({
    title: job.title ?? null,
    url: job.url ?? job.shortlink ?? null,
    location: formatLocation(job),
    company,
    ats: "workable"
  }));
}
