# JobScraping Pipeline

Three-stage pipeline that discovers creative job postings from company career pages,
extracts structured data, and enriches via GPT.

## Quick Start

```bash
# Install dependencies
npm install
npx playwright install chromium

# Run full pipeline (all 3 stages)
npx tsx pipeline/run.ts

# Run from a specific stage
npx tsx pipeline/run.ts --stage 2    # stages 2+3
npx tsx pipeline/run.ts --stage 3    # stage 3 only
```

## Stages

### Stage 1: Scrape Career Pages
`npx tsx pipeline/stage1_scrapeCareers.ts`

Reads career page URLs from `pipeline/company_career_urls.json`.
Detects ATS (Greenhouse, Lever, Workday, etc.), dispatches to specialized adapters,
falls back to generic HTML/Playwright crawlers.
Filters for creative jobs.

**Input:** `pipeline/company_career_urls.json`
**Output:** `outputs/history/[timestamp]/results_scrape.json`

### Stage 2: Collect Job Details
`npx tsx pipeline/stage2_collectJobDetails.ts --input <scrape_output>`

Fetches each job URL, extracts structured data (title, description, location,
salary, company, skills, keywords) via JSON-LD + HTML heuristics.
Pre-filters noise titles and listing-page URLs.

**Input:** Stage 1 JSON
**Output:** `outputs/history/[timestamp]/results_jobs_api.csv`

### Stage 3: GPT Enrichment
`npx tsx pipeline/stage3_enrichGpt.ts --input <stage2_csv>`

Sends each row through GPT-4.1-nano to fix titles, clean descriptions,
validate fields, and regenerate keywords/skills.
Deduplicates and drops invalid rows.

**Input:** Stage 2 CSV
**Output:** `outputs/history/[timestamp]/results_enriched_api_gpt.csv`

## Environment Variables

| Variable | Description |
|----------|-------------|
| `OPENAI_API_KEY` | Required for Stage 3 (GPT enrichment) |
| `SCRAPER_CONCURRENCY` | Stage 1 concurrency (default: 8) |
| `SCRAPER_URLS_FILE` | Override input URL file path |
| `HIRING_TEAM_UID` | UID for hiringTeam field (default: system-scraper) |

## Output Structure

All stage outputs go into a single timestamped run folder:

```
outputs/history/
  2026-03-07_143022Z/
    results_scrape.json           # Stage 1
    results_jobs_api.csv          # Stage 2
    results_enriched_api_gpt.csv  # Stage 3
    manifest.json                 # Run summary
```

## Project Structure

```
adapters/       # ATS-specific scrapers (greenhouse, lever, workday, etc.)
ats/            # ATS detection & tenant extraction
filters/        # Creative job filtering
pipeline/       # Stage scripts + input data
utils/          # Shared extraction, classification, HTTP utilities
types.ts        # Shared TypeScript interfaces
```
