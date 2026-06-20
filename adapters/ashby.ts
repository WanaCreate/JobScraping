import axios from "axios";
import type { RawJob } from "../types.js";

type AshbyJobPosting = {
  title?: string;
  jobUrl?: string;
  location?: string;
  descriptionHtml?: string;
  descriptionPlain?: string;
  publishedAt?: string;
};

type AshbyJobBoardResponse = {
  // The public posting-api returns postings under `jobs`. (`jobPostings` is kept
  // as a fallback in case an older board shape is ever returned.)
  jobs?: AshbyJobPosting[];
  jobPostings?: AshbyJobPosting[];
};

// Ashby's posting-api exposes no org-name field, so derive a readable company
// from the tenant slug (e.g. "acme-design" -> "Acme Design").
function slugToCompany(slug: string): string {
  return slug
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");
}

export async function scrapeAshby(tenant: string): Promise<RawJob[]> {
  const url = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(tenant)}`;
  const response = await axios.get<AshbyJobBoardResponse>(url, {
    timeout: 60000,
    headers: {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
    },
    validateStatus: (status) => status >= 200 && status < 300
  });

  const jobs: RawJob[] = [];
  const postings = response.data?.jobs ?? response.data?.jobPostings ?? [];
  const company = slugToCompany(tenant);

  for (const posting of postings) {
    const title = posting.title?.trim();
    const jobUrl = posting.jobUrl?.trim();
    if (!title || !jobUrl) continue;

    const description = posting.descriptionHtml?.trim() || posting.descriptionPlain?.trim() || null;
    const datePosted = posting.publishedAt?.trim() || null;

    jobs.push({
      title,
      url: jobUrl,
      location: posting.location?.trim() ?? null,
      company,
      ats: "ashby",
      description: description || null,
      datePosted: datePosted || null
    });
  }

  return jobs;
}
