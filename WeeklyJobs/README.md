# WeeklyJobs — How to Run the Weekly Job Scrape

## Quick start: ScraperAgent

1. Open a Claude chat and paste the contents of [ScraperAgent.md](./ScraperAgent.md) as the system/context.
2. Give it a list of job URLs to process.
3. It runs `reviewFetchOne.ts` on each URL, builds Table A (job postings) and Table B (Instagram), and writes `WeeklyJobs/<date>/scraped/SCRAPED-INFO-<date>.md`.
4. For any gated URLs (Indeed, Instagram, LinkedIn auth walls), paste the page content back into chat — the agent fills in those rows manually.
5. The completed SCRAPED-INFO file is your output.

> The scraper **works now and gets better each run.** Every week we refine the rules, niche list, and field-reconciliation notes directly in ScraperAgent.md. If something comes out wrong, note it here or in the agent spec — the next run will be cleaner.

---

## After scraping: manual review (skip ReviewerAgent for now)

**Do not use ReviewerAgent for the weekly run** — see note in [ReviewerAgent.md](./ReviewerAgent.md). Use the SCRAPED-INFO output directly to review listings manually, then hand off to the Posting Agent.

The Posting Agent guide is at [../docs/WANA-JOB-POSTING-AGENT-GUIDE.md](../docs/WANA-JOB-POSTING-AGENT-GUIDE.md).

---

## Folder structure per run

```
WeeklyJobs/
  <MonthDay-YYYY>/
    scraped/
      SCRAPED-INFO-<date>.md   ← ScraperAgent output (Table A + Table B)
    creative_jobs_<date>.csv   ← upload CSV (from Posting Agent)
    review-YYYY-MM-DD.md       ← manual or ReviewerAgent review (if used)
```

---

## Future / to-do

- [ ] Integrate ScraperAgent and ReviewerAgent into the `docs/` folder alongside the other agent guides — keep all agent specs in one place.
- [ ] Reorganize the WeeklyJobs folder: weekly run output (CSVs, SCRAPED-INFO, reviews) in dated subfolders; agent specs and scripts at the top level or in `docs/`.
- [ ] Revisit ReviewerAgent — either trim it heavily to reduce token cost, or replace with a lightweight manual checklist that references the scraper output.
- [ ] Wire up duplicate-check against last 30 days of live listings (Supabase query or exported CSV).
