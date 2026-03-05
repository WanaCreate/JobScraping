import type { ATS, NormalizedJob, RawJob } from "../types.js";
import { safeAbsoluteUrl } from "./http.js";

function deriveCompanyName(sourceUrl: string): string {
  try {
    const host = new URL(sourceUrl).hostname.toLowerCase().replace(/^www\./, "");
    const [name] = host.split(".");
    return name || "unknown";
  } catch {
    return "unknown";
  }
}

function clean(input: string | null | undefined): string {
  if (!input) return "";
  return input.replace(/\s+/g, " ").trim();
}

export function normalizeJobs(
  jobs: RawJob[],
  source: string,
  ats: ATS,
  defaultCompany?: string
): NormalizedJob[] {
  const dedupe = new Map<string, NormalizedJob>();
  const companyFallback = defaultCompany || deriveCompanyName(source);

  for (const job of jobs) {
    const title = clean(job.title);
    const url = safeAbsoluteUrl(clean(job.url ?? ""), source);
    if (!title || !url) continue;

    const normalized: NormalizedJob = {
      title,
      url,
      location: clean(job.location) || "Not specified",
      ats: job.ats ?? ats,
      company: clean(job.company) || companyFallback,
      source
    };

    const key = `${normalized.title.toLowerCase()}|${normalized.url.toLowerCase()}`;
    if (!dedupe.has(key)) dedupe.set(key, normalized);
  }

  return Array.from(dedupe.values());
}
