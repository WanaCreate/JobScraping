# JobScraping Pipeline

**Agent guides (workflow order):**

1. [Job scraper — find latest remote roles](docs/JOB-SCRAPER-AGENT-GUIDE.md)
2. [Scraper agent — extract fields from a URL (job + Instagram modes)](WeeklyJobs/ScraperAgent.md)
3. [Reviewer — PASS/REVIEW/REJECT + CSV field audit before posting](WeeklyJobs/ReviewerAgent.md)
4. [Wana posting — CSV, descriptions, DEV/PROD upload](docs/WANA-JOB-POSTING-AGENT-GUIDE.md)

**Weekly posting CSVs:** `WeeklyJobs/<date-folder>/` (latest: `WeeklyJobs/June4-2026/creative_jobs_june4_2026.csv`)

Four-stage pipeline that collects creative job postings from company job boards,
fills in and normalizes the details, optionally polishes them with GPT, and
attaches high-res company logos.

Most source companies are on public ATS JSON APIs (Greenhouse, Lever, Ashby,
Workable, SmartRecruiters, etc.), so the bulk of a run needs **no browser** — the
APIs return titles, locations, company, descriptions, and posted dates directly.
A browser (Playwright) is only used as a fallback for custom career pages that
have no API.

> **📈 Scaling & cloud/local note:** before any large discovery/scrape run, read
> [docs/JobsDrop2.1-ScaleTo100KJobs.md](docs/JobsDrop2.1-ScaleTo100KJobs.md) — the
> living plan for scaling intake. Its **"Cloud vs Local"** section lists which knobs
> are throttled to survive the Claude Code cloud proxy (Playwright off, lower
> concurrency, small checkpoints); **run locally at full power** per that table.

## Quick Start

```bash
# Install dependencies
npm install
npx playwright install chromium   # optional — only needed for the custom career-page
                                  # fallback; ATS-API companies don't use a browser

# Run full pipeline (all 4 stages)
npx tsx pipeline/run.ts

# Run from a specific stage
npx tsx pipeline/run.ts --stage 2    # stages 2-4
npx tsx pipeline/run.ts --stage 3    # stages 3+4
npx tsx pipeline/run.ts --stage 4    # stage 4 only (logo enrichment)
```

## Stages

The names below describe what each stage does today. The script **file names are
unchanged** (`stageN_*.ts`) — only the conceptual labels and descriptions are
updated to match current behavior. In short: Stage 1 *Collect Jobs* gathers
everything the sources expose for free; Stage 2 *Detail & Normalize* fills the
gaps and cleans up; Stage 3 *GPT Polish* (optional) refines with AI; Stage 4
*Logos & Shuffle* brands and orders the output.

### Stage 1: Collect Jobs
`npx tsx pipeline/stage1_scrapeCareers.ts`  *(file: `stage1_scrapeCareers.ts`)*

Finds each company's job board and lists every job, capturing all fields the
source provides directly. For ATS URLs it detects the ATS **straight from the URL**
and calls the public JSON API (Greenhouse `boards-api`, Lever, Ashby, Workable,
SmartRecruiters, iCIMS, Workday, Amazon) — no HTML scraping, no browser. For
custom career pages it crawls `/careers`, `/jobs`, `/work-with-us`, etc. and falls
back to Playwright. From the API it captures **title, URL, location, company,
full description, and posted date**, then filters to creative roles. Per-host
concurrency caps + request spacing prevent 429/403 rate-limit throttling at scale.

**Input:** `pipeline/company_career_urls.json`
**Output:** `results_scrape.json` — one record per company with its creative jobs
(each job already carries description + posted date)

### Stage 2: Detail & Normalize
`npx tsx pipeline/stage2_collectJobDetails.ts --input <stage1_output>`  *(file: `stage2_collectJobDetails.ts`)*

Fills the fields the listing APIs **don't** return — salary, skills, keywords,
work type, work email — by fetching each job page (JSON-LD + HTML heuristics).
Prefers the description Stage 1 already captured (falls back to the fetched page
when absent), cleans breadcrumb titles, sanitizes description HTML to the
frontend's allowed-tag whitelist, dedups (by canonical URL + title), drops noise
titles / listing-page URLs, validates required API fields, and writes API-ready
records.

**Input:** Stage 1 JSON
**Output:** `outputs/api-ready/latest/results_jobs_api.{json,csv}` (+ history snapshot)

### Stage 3: GPT Polish  *(optional — requires `OPENAI_API_KEY`)*
`npx tsx pipeline/stage3_enrichGpt.ts --input <stage2_csv>`  *(file: `stage3_enrichGpt.ts`)*

Sends each row through GPT-4.1-nano to fix titles, clean descriptions, validate
fields, and regenerate keywords/skills. Deduplicates and drops invalid rows.
Optional — the pipeline produces complete API-ready output without it.

**Input:** Stage 2 CSV
**Output:** `results_enriched_api_gpt.csv`

### Stage 4: Logos & Shuffle
`npx tsx pipeline/stage4_enrichLogos.ts --input <stage3_csv>`  *(file: `stage4_enrichLogos.ts`)*

Resolves company logos using the Google Favicon API (256px). Strips job-board/ATS
domains, handles career subdomains, and guesses domains from company names.
Shuffles rows so same-company jobs aren't adjacent. Results are cached in
`logo_cache.json`.

**Input:** Stage 3 CSV
**Output:** Overwrites input (or `--output <path>`)

## Helper scripts (`scripts/`)

Standalone tools for growing and curating the company list — not part of the
weekly stage run:

| Script | Command | What it does |
|--------|---------|--------------|
| Slug discovery | `npm run discover-slugs` | Scans Common Crawl CDX for Greenhouse/Lever/Ashby/Workable boards, extracts company slugs, dedups against the live list, and writes new candidates to `pipeline/pending_review.json`. |
| Promotion gate | `npm run promote-pending -- --input <stage1_output>` | Scores a Stage 1 scrape of `pending_review.json`; promotes companies with a creative job at score ≥6 into `company_career_urls.json` (`--apply`), parks the rest in `companies_to_recheck.json`. |
| Prune | `npm run prune-companies -- --input <stage1_output>` | Partitions the live list into keep / low-yield / zero-job buckets from a Stage 1 scrape; proposes a pruned list (`--apply` to commit). |

## Environment Variables

| Variable | Description |
|----------|-------------|
| `OPENAI_API_KEY` | Required **only** for Stage 3 (GPT Polish). Stages 1, 2, 4 don't use it. |
| `SCRAPER_CONCURRENCY` | Stage 1 global concurrency across all hosts (default: 8) |
| `PER_HOST_CONCURRENCY` | Stage 1 max concurrent requests per host (default: 4) |
| `PER_HOST_SPACING_MS` | Stage 1 min ms between requests to the same host (default: 120) |
| `SCRAPER_URLS_FILE` | Override input URL file path |
| `SCRAPER_OUTPUT_FILE` | Override Stage 1 output path |
| `HIRING_TEAM_UID` | UID for hiringTeam field (default: system-scraper) |

## Output Structure

All stage outputs go into a single timestamped run folder:

```
outputs/history/
  2026-03-07_143022Z/
    results_scrape.json           # Stage 1
    results_jobs_api.csv          # Stage 2
    results_enriched_api_gpt.csv  # Stage 3 + Stage 4 (logos added in-place)
    manifest.json                 # Run summary
```

## Project Structure

```
adapters/       # ATS-specific scrapers (greenhouse, lever, ashby, workable, workday, etc.)
ats/            # ATS detection (incl. URL-first) & tenant extraction
filters/        # Creative job filtering
pipeline/       # Stage scripts + input data (company_career_urls.json, etc.)
scripts/        # Helper tools: discoverSlugs, promotePending, pruneCompanies
utils/          # Shared extraction, classification, HTTP, host rate-limiter, scoring
types.ts        # Shared TypeScript interfaces
```
