import axios from "axios";
import type { RawJob } from "../types.js";

type AshbyJobPosting = {
  title?: string;
  jobUrl?: string;
  location?: string;
};

type AshbyJobBoardResponse = {
  jobPostings?: AshbyJobPosting[];
};

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
  const postings = response.data?.jobPostings ?? [];

  for (const posting of postings) {
    const title = posting.title?.trim();
    const jobUrl = posting.jobUrl?.trim();
    if (!title || !jobUrl) continue;

    jobs.push({
      title,
      url: jobUrl,
      location: posting.location?.trim() ?? null,
      ats: "ashby"
    });
  }

  return jobs;
}
