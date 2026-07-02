# JobScraping Agent Runbook

> ⛔️ **MANDATORY — READ THIS FILE FIRST.** Every agent, contributor, script, or
> automated program operating in this repo MUST read this `AGENTS.md` (top to
> bottom) before running, editing, or scheduling anything. It encodes contracts
> and guardrails that are NOT obvious from the code and have broken production
> before. If you are an AI agent: treat this as required context for the whole
> session. If you are wiring up a new program/stage/cron: add a header pointer to
> this file (see how the pipeline stages do it) so the next reader can't miss it.

> 🔁 **DEDUP GUARDRAIL — READ BEFORE RUNNING STAGE 3 OR PUBLISHING A DROP.**
> The pipeline's built-in dedup (Stage 2 `dedupeJobs`, Stage 3 `deduplicateRows`)
> is **within-run only** — it removes duplicates *inside the current batch* and
> knows nothing about jobs we have already published. **Stage 3 must NOT be run,
> and a weekly drop must NOT be published, before the new jobs are deduped against
> the jobs already in the production DB** — otherwise we re-post jobs users have
> already seen. The DB is the source of truth for "already shipped"; do not rely on
> last week's CSV for this going forward.
>
> _History:_ for the 2026-06-27 drop this was done as a one-time pass that removed
> rows whose normalized `jobLink` matched the prior week's final
> (`outputs/api-ready/latest/results_final_api_claude.csv`). That CSV approach was a
> stopgap; the durable solution is a DB-backed dedup step ahead of Stage 3.

> For repo overview, pipeline stages, and commands, read `README.md` first.

> **Open follow-up (set 2026-06-18):** `pipeline/companies_to_recheck.json` holds
> 9,394 ATS companies that scraped clean but had no creative job at score ≥6 at the
> time. Re-scrape + re-score them periodically (monthly, or when the drop needs
> volume) and promote any that now pass — see "Reminders / open follow-ups" in
> [docs/JobsDrop2.0_Handoff.md](docs/JobsDrop2.0_Handoff.md) for the full list of
> follow-ups (429 recovery, parked 900 prune, Lever coverage).

> **📈 Scaling plan — read before any large discovery/scrape run:**
> [docs/JobsDrop2.1-ScaleTo100KJobs.md](docs/JobsDrop2.1-ScaleTo100KJobs.md) is the
> living plan for scaling intake toward 100K creative jobs/week (multi-crawl CDX
> union, HN Lever recovery, promotion gate, self-expanding loop). **It also contains
> a "Cloud vs Local" section** documenting which pipeline knobs are throttled to
> survive the Claude Code cloud proxy (Playwright off, lower concurrency, small
> checkpoints) — **when running locally, restore full power per that table**
> (turn Playwright back on, raise concurrency). Update its weekly log as you run.

## Weekly creative jobs (Instagram / manual batches)

1. **Discover** — [docs/JOB-SCRAPER-AGENT-GUIDE.md](docs/JOB-SCRAPER-AGENT-GUIDE.md) (which URLs to scrape)
2. **Collect fields** — [WeeklyJobs/ScraperAgent.md](WeeklyJobs/ScraperAgent.md) (extract a URL via `reviewFetchOne.ts`; job-posting or Instagram output)
3. **Review** — [WeeklyJobs/ReviewerAgent.md](WeeklyJobs/ReviewerAgent.md) → write `WeeklyJobs/reviews/review-YYYY-MM-DD.md` (7-rule verdict + CSV field audit)
4. **Post** — [docs/WANA-JOB-POSTING-AGENT-GUIDE.md](docs/WANA-JOB-POSTING-AGENT-GUIDE.md); save CSV under `WeeklyJobs/<date-folder>/`

## Default Output Contract
The `collectJobDetails` pipeline writes by default to:

- `outputs/api-ready/latest/results_jobs_api.json`
- `outputs/api-ready/latest/results_jobs_api.csv`
- `outputs/api-ready/latest/results_jobs_enriched.json`
- `outputs/api-ready/latest/results_jobs_quality_report.json`
- `outputs/api-ready/latest/manifest.json`

Each run also writes a snapshot to:

- `outputs/api-ready/history/<YYYY-Www>/<runTag>/...`

This keeps `latest` stable for downstream API ingestion and preserves weekly run history.

## Primary Command

```bash
npx tsx pipeline/collectJobDetails.ts --input results_150_optimized.json --concurrency 12 --hiringTeamUid system-scraper
```

## Optional Flags

- `--runTag <tag>`: custom run identifier for history snapshot folder.
- `--noHistory`: disable history snapshot write for one run.
- `--latestDir <path>`: override latest output base directory.
- `--historyDir <path>`: override history base directory.
- `--output <path>`: override enriched JSON output path.
- `--apiOutput <path>`: override API JSON output path.
- `--csvOutput <path>`: override API CSV output path.
- `--reportOutput <path>`: override report output path.
- `--maxJobs <n>`: run on subset for smoke tests.
- `--minCreativeScore <n>`: adjust post-fetch creative gate strictness.

## Recommended Agent Behavior

1. Use defaults unless there is a clear reason to override paths.
2. Keep `latest` as the source for API ingestion.
3. Use history snapshots for audits and rollback.
4. For test runs, prefer `--maxJobs` and set a descriptive `--runTag`.

## Output Format Contract (READ BEFORE CHANGING ANY STAGE)

The scraper's CSV is consumed by other systems — it is NOT free-form. Before
changing the output format of ANY pipeline stage (column names, column order,
field values, enum values, or the `description` HTML structure), you MUST review
both downstream consumers and match them. The scraper does not define the schema;
these consumers do.

1. **api-server bulk-upload parser (authoritative schema).**
   - Endpoint: `POST /api/v1/jobs/upload` → `bulkUploadJobs` → `JobService.uploadJobsFromCSV`.
   - File: `api-server/src/services/impl/JobService.ts` (`uploadJobsFromCSV`).
   - This parser defines the EXACT column names and accepted enum values. Notable points
     that have bitten us before:
     - Location is read as SEPARATE columns (`city`, `state`, `country`, `locationName`,
       `formattedAddress`, `placeId`, `latitude`, `longitude`) — NOT a composite `location` column.
     - Salary columns are NON-dotted: `salaryMin`, `salaryMax`, `salaryCurrency`, `salaryPeriod`.
     - The apply URL is read from `externalApplicationLink` — NOT `jobLink`.
     - `jobType` enum includes `OPEN_CALL` (GIG/FULLTIME/PARTTIME/FREELANCE/OPEN_CALL).
     - `salaryPeriod` accepts `YEARLY` (mapped to `ANNUAL` server-side).
   - Whenever this parser changes, the scraper output must be updated to match it.

2. **web frontend (rendering + hardcoded enums).** Yes — review the web app too.
   - `description` is rendered as sanitized HTML via `RichTextRenderer` /
     `sanitizeRichTextHtml()` (`web-app-new/src/lib/rich-text.ts`). Stage 3's
     description HTML must stay within that tag whitelist or tags get stripped on render.
   - `jobType` / `workType` enum values are hardcoded in several places (type defs,
     label maps, form dropdowns, Zod validation) — e.g. `web-app-new/src/di/jobs.ts`,
     `src/lib/jobFormatters.ts`, `src/hooks/jobs/forms/useJobForm.ts`. A new enum value
     emitted by the scraper will not display (no label) and may fail form validation
     until the frontend is updated.

The web app does NOT parse the CSV directly (it only reads already-parsed Job objects
from the api-server), so the CSV column-name contract is owned solely by the api-server
parser. The web app constrains only field VALUES (description HTML, enum values).
