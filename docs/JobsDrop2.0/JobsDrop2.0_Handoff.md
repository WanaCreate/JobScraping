# Jobs Drop 2.0 — Handoff / Progress Notes

_For continuing in a fresh chat (Claude Code web, Opus as lead dev). This captures context that won't carry over._

**JIRA:** USR-2267 · **Branch:** `FullDirCleanUp` (JobScraping repo) · **Source plan:** [`JobsDrop2.0.md`](./JobsDrop2.0.md)

---

## TL;DR of where we are

Task 0 (dynamic preference-driven scoring) is **done and verified**. Tasks 1–4 remain. Everything below is delegatable to Sonnet subagents with Opus leading.

---

## Key context / decisions made (don't re-litigate)

1. **DB is Firebase Firestore, NOT Supabase.** Users live in the `users` collection.
2. **Preferences are discrete tags, not free text.** Two fields per user, both merged: top-level `professions[]` and `jobPreferences.professions[]`. `jobPreferences.keywords[]` is ignored for v1 (noisier).
3. **Location / workMode / employmentType are NOT in scrape-time scoring.** Those are per-user serve-time signals handled by `api-server/src/utils/jobPreferenceScore.ts`. The scraper only answers "is this a creative job?" — the api-server answers "is this right for THIS user?"
4. **Design = Option A:** the strict creative-title GATE stays hardcoded (`filters/creativeFilter.ts`); only the WEIGHTS come from `creativeScore.json`. Reason: the generated weights contain noise (`student`, `teacher`, `web developer`, typos like `ilustrator`). Using them as the gate would leak non-creative jobs. The hardcoded gate is the safety net.

## Research findings worth keeping (verified via deep research + web search)

- Greenhouse / Lever / Ashby / Workable / Personio all expose **public no-auth JSON/XML APIs**. No proxies/browser needed for these.
- **The real bottleneck is slug discovery** — none of these ATSs have a company-enumeration endpoint. You must bring the list of company slugs.
- **Common Crawl CDX** is a free, bulk way to discover slugs (query for `boards.greenhouse.io/*` etc.) — better than Google CSE as the primary method. CSE (100/day free) is the freshness supplement.
- **Rotating proxies (100M+ IP pools) are ONLY for scraping LinkedIn/Indeed/Glassdoor/Cloudflare career pages** — which we deliberately don't touch. Our ATS-API approach skips ~90% of that infra. At 5K companies we need none of it — just per-host concurrency caps.
- **Lever v0 API is fine** — still the only public no-auth endpoint (v1 requires OAuth). The "stale since 2018" flag is about docs, not the API. Keep `lever.ts` as-is.
- **Unified.to** (paid unified-ATS API) — not worth it for v1; our adapters already cover the same platforms. Revisit only at 50K+ companies.
- JobsWright / Sorce.ai — no reliable public data on their internals; can't benchmark directly. Sorce is YC-backed.

---

## Task 0 — DONE ✅

**0a — Preference aggregator**
- Script: [`api-server/src/scripts/aggregateCreativeScore.ts`](../../api-server/src/scripts/aggregateCreativeScore.ts)
- Initializes Firebase directly (the shared config forces `NODE_ENV=development` via dotenv `override:true`, so the script takes a `--production` flag instead).
- Sweeps `users` with field projection (`professions`, `jobPreferences` only), merges+dedupes tags per user, applies a ≥5-user floor + log smoothing → 0–10 weights.
- Sanity gate: refuses to overwrite if users or tag count drops >50%.
- **Run:** from `api-server/`:
  - Dry run: `npx ts-node src/scripts/aggregateCreativeScore.ts --production`
  - Write: `npx ts-node src/scripts/aggregateCreativeScore.ts --production --write`
  - npm scripts also added: `aggregate:creative-score` / `aggregate:creative-score:write`
- **Last run:** 7,322 docs scanned → 3,774 active users → 261 tags. Output committed.

**0b — Wire weights into scoring**
- [`pipeline/creativeScore.json`](../pipeline/creativeScore.json) — generated weights (cold-start default also lives here; regenerated weekly by the aggregator).
- [`score_jobs.py`](../score_jobs.py) — now reads `creativeScore.json`, scores each job by MAX matching keyword weight using **word-boundary regex** (compiled once at module load), clamped 2–10. Falls back to the original hardcoded SCORE_10..SCORE_2 tiers if the JSON is missing/unparseable.
- `filters/creativeFilter.ts` — **unchanged** by design (the gate).

**Run cadence (v1 = manual):** run the aggregator weekly BEFORE the scrape pipeline. Cron deferred.

---

## Remaining tasks

### Task 1 — Prune non-creative companies (Small)
- `pipeline/company_career_urls.json` has ~900 entries, many non-creative (Asana, Puma, Zalando, Zomato).
- Run the now-preference-driven scoring against recent scrape output per company; remove/deprioritize companies returning 0 jobs at score ≥ 6. Move borderline → `low_yield_companies.json`.
- **Do first** to establish a clean yield-per-URL baseline before adding URLs. Needs a recent scrape to measure against.

### Task 2 — Slug discovery → grow the list 900 → 5,000+ (Small, biggest lever)
- New `scripts/` dir (doesn't exist yet).
- **Primary:** Common Crawl CDX scan for `boards.greenhouse.io/*`, `jobs.lever.co/*`, `jobs.ashbyhq.com/*`, `apply.workable.com/*` → extract slugs.
- **Secondary:** Google Custom Search API (free 100/day) for the same, scoped by creative job-title keywords pulled from `creativeScore.json`.
- Dedup against `company_career_urls.json`; write new ones to `pending_review.json` (NOT directly to the main list). Classifier promotes after a sample scrape.

### Task 3 — Add Workable adapter (Small)
- New `adapters/workable.ts`. Public endpoint: `GET https://www.workable.com/api/accounts/{subdomain}?details=true` (jobs + descriptions, no auth).
- Wire into `ats/detectATS.ts` and `pipeline/stage1_scrapeCareers.ts`. (Personio optional, later — EU, XML feed.)

### Task 4 — Self-expanding loop in Stage 1 (Small)
- In `stage1_scrapeCareers.ts`, after each job: parse `schema.org/JobPosting` JSON-LD → take `hiringOrganization.sameAs` → if domain unknown, append to `new_companies_discovered.json`. Manual review first, automate promotion later.

### Operational (when scaling to 5K)
- Per-host concurrency caps in Stage 1 (~4 concurrent/ATS host, 100ms spacing).
- Confirm `validThrough` from JSON-LD is respected so expired roles don't surface.
- Per-URL success/failure logging; alert when a previously-yielding URL returns 0 for 2+ runs.

**Do NOT touch:** stage2/3/4, existing ATS adapters, `genericHtmlCrawler.ts`, api-server serve-time relevance.

---

## Success metric
One pipeline run produces **500+ jobs at creativeClassifier score ≥ 6** (currently ~100–200), using the weekly preference-driven weights.

## Suggested next order
Task 2 (volume, no dependency) → Task 3 (more coverage) → Task 1 (prune once there's fresh output) → Task 4 (compounding discovery).
