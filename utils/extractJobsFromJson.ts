import type { RawJob } from "../types.js";
import { safeAbsoluteUrl } from "./http.js";

const TITLE_KEYS = [
  "title",
  "jobTitle",
  "job_title",
  "positionTitle",
  "postingTitle",
  "requisitionTitle",
  "name",
  "text"
];

const URL_KEYS = [
  "url",
  "applyUrl",
  "apply_url",
  "absolute_url",
  "hostedUrl",
  "jobUrl",
  "canonicalUrl",
  "externalPath",
  "job_path",
  "path",
  "href",
  "jobLink",
  "job_link"
];

const LOCATION_KEYS = ["location", "locationsText", "city", "state", "country", "workplaceType"];

const DATE_KEYS = [
  "datePosted",
  "date_posted",
  "datePublished",
  "publishedAt",
  "published_at",
  "published_on",
  "publishedDate",
  "postedDate",
  "postedOn",
  "posted_at",
  "createdAt",
  "created_at",
  "first_published",
  "releasedDate"
];

const URL_HINT = /(job|jobs|career|careers|position|positions|opening|openings|requisition|vacanc|opportunit)/i;
const TITLE_HINT =
  /\b(designer|design|artist|writer|producer|engineer|developer|manager|director|specialist|analyst|research|intern|architect|lead)\b/i;

function pickStringValue(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function formatLocation(record: Record<string, unknown>): string | null {
  const direct = pickStringValue(record, LOCATION_KEYS);
  if (direct) return direct;

  const nested = record.location;
  if (nested && typeof nested === "object") {
    const obj = nested as Record<string, unknown>;
    const parts = [obj.city, obj.state, obj.region, obj.country]
      .filter((value) => typeof value === "string" && value.trim())
      .map((value) => String(value).trim());
    if (parts.length > 0) return parts.join(", ");
  }

  return null;
}

function toRawJob(record: Record<string, unknown>, baseUrl: string): RawJob | null {
  const title = pickStringValue(record, TITLE_KEYS);
  const rawUrl = pickStringValue(record, URL_KEYS);

  if (!title || title.length < 3 || title.length > 180) return null;

  if (!rawUrl) return null;
  const url = safeAbsoluteUrl(rawUrl, baseUrl);
  if (!url) return null;
  if (!URL_HINT.test(url) && !TITLE_HINT.test(title)) return null;

  return {
    title,
    url,
    location: formatLocation(record),
    ats: "generic",
    datePosted: pickStringValue(record, DATE_KEYS)
  };
}

function extractFromJsonLdJobPosting(data: unknown, baseUrl: string, jobs: RawJob[]): void {
  if (!data || typeof data !== "object") return;

  if (Array.isArray(data)) {
    for (const item of data) extractFromJsonLdJobPosting(item, baseUrl, jobs);
    return;
  }

  const record = data as Record<string, unknown>;
  const type = String(record["@type"] ?? "").toLowerCase();
  if (type === "jobposting") {
    const title = typeof record.title === "string" ? record.title.trim() : null;
    const url =
      (typeof record.url === "string" && safeAbsoluteUrl(record.url, baseUrl)) ||
      (typeof record.sameAs === "string" && safeAbsoluteUrl(record.sameAs, baseUrl)) ||
      null;
    if (title && url) {
      const locationObj = record.jobLocation as
        | { address?: { addressLocality?: string; addressRegion?: string; addressCountry?: string } }
        | undefined;
      const location = locationObj?.address
        ? [locationObj.address.addressLocality, locationObj.address.addressRegion, locationObj.address.addressCountry]
            .filter(Boolean)
            .join(", ")
        : null;

      jobs.push({
        title,
        url,
        location,
        ats: "generic",
        datePosted: typeof record.datePosted === "string" ? record.datePosted.trim() : null
      });
    }
  }

  for (const value of Object.values(record)) {
    extractFromJsonLdJobPosting(value, baseUrl, jobs);
  }
}

export function extractJobsFromJson(data: unknown, baseUrl: string): RawJob[] {
  const jobs: RawJob[] = [];
  const visited = new WeakSet<object>();

  const walk = (value: unknown, depth: number): void => {
    if (!value || depth > 10) return;

    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }

    if (typeof value !== "object") return;
    if (visited.has(value)) return;
    visited.add(value);

    const record = value as Record<string, unknown>;
    const maybeJob = toRawJob(record, baseUrl);
    if (maybeJob) jobs.push(maybeJob);

    for (const nested of Object.values(record)) walk(nested, depth + 1);
  };

  walk(data, 0);
  extractFromJsonLdJobPosting(data, baseUrl, jobs);
  return jobs;
}
