# Weekly Tracker Pipeline

A multi-stage pipeline that surfaces **recent, resume-matched, US architecture
roles** from the firms we scrape successfully. Tuned to a specific candidate
resume (entry-level Architectural Designer — Revit/AutoCAD/SketchUp, passive
house & sustainability, construction documentation; seeking "Designer I / Junior
Designer" on US projects).

> **Separate from the daily tracker** (`../track.ts`). The daily tracker diffs for
> *newly-appeared* roles across all firms. This weekly pipeline scores roles
> against a resume, keeps only the last week, collects full job detail, and
> optimistically filters to the US. They share the scraping core (`../scrape.ts`)
> and the location classifier (`../usGeo.ts`).

## Run

```bash
# Full pipeline (stages 1 → 2 → 3)
npx tsx experiments/architecture-firms/weekly/run.ts

# Useful flags
npx tsx experiments/architecture-firms/weekly/run.ts --firm "WATG"     # one firm (substring)
npx tsx experiments/architecture-firms/weekly/run.ts --limit 5         # first N eligible firms
npx tsx experiments/architecture-firms/weekly/run.ts --days 7          # recency window (default 7)
npx tsx experiments/architecture-firms/weekly/run.ts --min-score 6     # resume-fit gate (default 6)
npx tsx experiments/architecture-firms/weekly/run.ts --concurrency 6   # firms scraped in parallel (stage 1)
npx tsx experiments/architecture-firms/weekly/run.ts --enrich-concurrency 3  # detail fetches in parallel (stage 2)
npx tsx experiments/architecture-firms/weekly/run.ts --no-playwright   # skip the SPA browser fallback in stage 2
```

Stages can also be run individually (each reads the previous stage's output from
the latest `output/weekly/<date>/`):

```bash
npx tsx experiments/architecture-firms/weekly/stage1_scrapeScore.ts
npx tsx experiments/architecture-firms/weekly/stage2_collect.ts
npx tsx experiments/architecture-firms/weekly/stage3_usFilter.ts
```

## Stages

| Stage | File | What it does |
|------|------|--------------|
| Scoring | `resumeScore.ts` | 0–10 resume-fit score. Tiered title patterns (entry-level arch design scores highest), a **seniority penalty** (senior/lead/principal/director/manager push a title down — the candidate wants junior roles), and a **skill bonus** when the description names her tools (Revit/AutoCAD/SketchUp/Enscape/passive house/LEED/ADA/CDs). |
| 1 | `stage1_scrapeScore.ts` | Scrape all `scraper != "skip"` firms (reuses `../scrape.ts` core → arch-title filter), keep roles with **fit ≥ `--min-score`**, then keep those **posted within `--days`**. Roles with no posted date yet are kept as `unknown` and deferred to stage 2 (we never drop a role just because the listing API gave no date). |
| 2 | `stage2_collect.ts` + `enrich.ts` | Fetch each job's detail page (HTTP, Playwright fallback for SPA pages) and collect the **full description**, plus **location** and **posted date** heuristically when the listing didn't carry them (JSON-LD `JobPosting` → in-text regex). Re-applies the recency window once newly-found dates are known; re-scores fit with the description. |
| 3 | `stage3_usFilter.ts` | **Optimistic** US filter via `../usGeo.ts`: keep a role unless its location is *confirmed foreign*. US **and** unknown/ambiguous locations pass — we accept some non-US noise rather than risk dropping a real US listing. |

## Output (`output/weekly/<date>/`)

| File | Contents |
|------|----------|
| `weekly_jobs_<date>.csv` | **The deliverable** — kept roles: `firm, title, fitScoreFull, geo, postedDateResolved, daysAgo, locationResolved, workType, ats, url`. |
| `stage1_scored.json` / `.csv` | Roles after fit + recency gating. |
| `stage2_enriched.json` / `.csv` | Above + full description, resolved date/location (with source labels), work type. The **full description text** lives here (kept out of the CSV deliverable to keep it readable). |
| `stage3_us_jobs.json` | Final kept set + US/unknown/foreign breakdown. |
| `stage3_dropped_foreign.csv` | Roles excluded as confirmed-foreign (for auditing the filter). |

## Notes & extension points

- **Posted date sources** (`postedDateSource`): `source` (listing API), `jsonld`
  (detail-page JSON-LD `datePosted`), `description` (in-text heuristic), or `none`.
  `locationSource` is labelled the same way.
- The fit scorer is the natural knob: edit the tiers/penalties in `resumeScore.ts`,
  or raise/lower `--min-score`. Title-only at stage 1; description-aware at stage 2.
- Stage 2 currently collects description + location + date + work type. Salary /
  skills / company extraction (as in the main pipeline) can be added to `enrich.ts`
  if the deliverable needs them.
- **Daily upgrade:** the same resume scorer + optimistic US filter can be layered
  onto `../track.ts` to make the daily "new roles" feed resume-matched and US-only.
```
