import type { ATS } from "../types.js";

function containsAny(text: string, needles: string[]): boolean {
  return needles.some((needle) => text.includes(needle));
}

export function detectATS(html: string, finalUrl: string): ATS {
  const haystack = `${html}\n${finalUrl}`.toLowerCase();

  if (containsAny(haystack, ["boards.greenhouse.io", "job-boards.greenhouse.io", "greenhouse.io"]))
    return "greenhouse";

  if (containsAny(haystack, ["myworkdayjobs.com", "/wday/cxs/", "workday"])) return "workday";

  if (containsAny(haystack, ["jobs.lever.co", "api.lever.co", "lever.co"])) return "lever";

  if (containsAny(haystack, ["smartrecruiters.com", "api.smartrecruiters.com"]))
    return "smartrecruiters";

  if (containsAny(haystack, ["icims.com", "icims"])) return "icims";

  if (containsAny(haystack, ["ashbyhq.com", "jobs.ashbyhq.com", "posting-api/job-board"])) return "ashby";

  if (containsAny(haystack, ["phenompeople.com", "careerconnectresources", "/widgets", "\"refnum\""]))
    return "phenom";

  if (containsAny(haystack, ["amazon.jobs", "search.json?offset", "\"job_path\""])) return "amazon";

  return "generic";
}
