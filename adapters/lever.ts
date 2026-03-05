import type { RawJob } from "../types.js";
import { http } from "../utils/http.js";

interface LeverPosting {
  text?: string;
  hostedUrl?: string;
  categories?: {
    location?: string;
  };
  state?: string;
}

export async function scrapeLever(tenant: string): Promise<RawJob[]> {
  const limit = 100;
  let skip = 0;
  const jobs: RawJob[] = [];
  const maxPages = 200;
  let page = 0;

  while (page < maxPages) {
    const url = `https://api.lever.co/v0/postings/${encodeURIComponent(
      tenant
    )}?mode=json&limit=${limit}&skip=${skip}`;

    const response = await http.get<LeverPosting[]>(url);
    const postings = response.data ?? [];
    if (postings.length === 0) break;

    for (const posting of postings) {
      if (posting.state && posting.state.toLowerCase() === "closed") continue;
      jobs.push({
        title: posting.text ?? null,
        url: posting.hostedUrl ?? null,
        location: posting.categories?.location ?? null,
        ats: "lever"
      });
    }

    if (postings.length < limit) break;
    skip += limit;
    page += 1;
  }

  return jobs;
}
