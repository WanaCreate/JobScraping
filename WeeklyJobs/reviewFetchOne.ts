/**
 * reviewFetchOne — single-URL detail fetch for the ReviewerAgent fallback.
 *
 * When the ReviewerAgent's cheap fetch (WebFetch) returns a gated / JS-rendered
 * page (Ashby, Workday, etc.), it shells out to this script to get the real
 * details. This is a THIN wrapper — all the actual work (HTTP -> Playwright
 * fallback for known ATS hosts, JSON-LD + heuristic extraction of title /
 * description / location / salary / workType) lives in enrichJobFromUrl().
 *
 * Usage:
 *   npx tsx WeeklyJobs/reviewFetchOne.ts <jobUrl>
 *
 * Output: a single JSON object on stdout, e.g.
 *   { "ok": true, "title": "...", "company": "...", "workType": "REMOTE",
 *     "location": "...", "salary": {...}, "jobLink": "...", "description": "..." }
 * On a non-creative / unextractable page:
 *   { "ok": false, "reason": "no-creative-match-or-unfetchable", "url": "..." }
 *
 * Exit code is always 0 (parse the JSON for success) unless usage is wrong (2).
 */
import { detectATS } from "../ats/detectATS.js";
import { enrichJobFromUrl } from "../utils/jobDetailExtractor.js";
import type { ATS, NormalizedJob } from "../types.js";

function atsFromUrl(url: string): ATS {
  // detectATS keys off host + html; for a bare URL the host substring is enough
  // to route Ashby/Workday/etc. to their Playwright-capable paths.
  return detectATS("", url);
}

async function main(): Promise<void> {
  const url = process.argv[2];
  if (!url) {
    process.stderr.write("usage: tsx WeeklyJobs/reviewFetchOne.ts <jobUrl>\n");
    process.exit(2);
    return;
  }

  const seed: NormalizedJob = {
    title: "",
    url,
    location: "",
    ats: atsFromUrl(url),
    company: "",
    source: "reviewer-agent",
  };

  let enriched = null;
  try {
    enriched = await enrichJobFromUrl({
      seed,
      hiringTeamUid: process.env.HIRING_TEAM_UID ?? "reviewer-agent",
      // Reviewer wants the raw text even for borderline-niche pages so it can
      // judge against its own rules; relax the creative gate to the floor.
      minCreativeScore: 0,
    });
  } catch (err) {
    process.stdout.write(
      JSON.stringify({ ok: false, reason: "fetch-error", error: String(err), url }) + "\n"
    );
    return;
  }

  if (!enriched) {
    process.stdout.write(
      JSON.stringify({ ok: false, reason: "no-creative-match-or-unfetchable", url }) + "\n"
    );
    return;
  }

  const j = enriched.apiJob;
  process.stdout.write(
    JSON.stringify(
      {
        ok: true,
        title: j.title,
        company: j.company?.name ?? null,
        workType: j.workType, // REMOTE | HYBRID | ONSITE | null
        jobType: j.jobType, // FULLTIME | PARTTIME | FREELANCE | GIG
        location: j.location?.formattedAddress || j.location?.name || null,
        salary: j.salary, // { min, max, currency, period } | null
        jobLink: j.jobLink,
        ats: enriched.ats,
        creativeScore: enriched.creativeScore,
        description: j.description,
      },
      null,
      2
    ) + "\n"
  );
}

void main();
