/** Record types passed between weekly-pipeline stages. */

/** Stage 1 output: an arch role that passed the resume-fit gate + recency. */
export interface Stage1Job {
  firm: string;
  title: string;
  location: string;       // seed location from the listing API (may be "")
  url: string;
  ats: string;
  datePosted: string;     // raw source value (ISO, or "Posted 5 Days Ago", or "")
  postedDate: string;     // normalized YYYY-MM-DD from source, or "" if unknown
  sourceUrl: string;
  scrapedAt: string;
  fitScore: number;       // resume-fit score (0–10), title-only at this stage
  recency: "recent" | "unknown";  // "recent" = posted <= window; "unknown" = no date yet
}

/** Stage 2 output: Stage 1 + full detail collected from the job page. */
export interface Stage2Job extends Stage1Job {
  description: string;
  descriptionChars: number;
  // resolved location (seed -> JSON-LD -> description heuristic)
  locationResolved: string;
  locationSource: "seed" | "jsonld" | "description" | "none";
  // resolved posted date (source -> JSON-LD datePosted -> description heuristic)
  postedDateResolved: string;          // YYYY-MM-DD or ""
  postedDateSource: "source" | "jsonld" | "description" | "none";
  daysAgo: number | null;              // vs run date, when a date is known
  workType: string;                    // REMOTE | HYBRID | ONSITE | ""
  fitScoreFull: number;                // re-scored with description (skill bonus)
  enrichStatus: "ok" | "fetch-failed";
}

/** Stage 3 output: Stage 2 + US geo verdict (optimistic). */
export interface Stage3Job extends Stage2Job {
  geo: "us" | "foreign" | "unknown";
  kept: boolean;                       // optimistic: kept unless confirmed foreign
}
