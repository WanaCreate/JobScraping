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

## Session log — 2026-06-18 (Tasks 2, 3, 4 shipped; 11K promotion run; Task 1 deferred)

Branch: `claude/dreamy-sagan-rr5fig`. Build clean (`npm run build`). No GPT/OpenAI enrichment touched (stops before Stage 3), no Google CSE (skipped per request — CDX only).

**Shipped (code, committed + pushed):**
- **Task 2 — CDX slug discovery.** `scripts/discoverSlugs.ts` (`npm run discover-slugs`). Common Crawl CDX only. Ran it → `pipeline/pending_review.json` with **11,080 new ATS career-page URLs** (greenhouse 5,586, ashby 2,416, workable 3,078; lever had near-zero CDX coverage in CC-MAIN-2026-21 — known gap, revisit with an older crawl or the deferred CSE supplement).
- **Task 3 — Workable adapter.** `adapters/workable.ts` wired through `types.ts`, `detectATS`, `extractTenant`, `stage1`. Smoke-tested (`blueground` → 35 jobs).
- **Task 4 — Self-expanding loop.** `utils/discoverCompanies.ts` parses JSON-LD `hiringOrganization.sameAs` from already-fetched HTML (no extra fetches), flushes new domains to `new_companies_discovered.json` once per run.

**Pipeline reliability fixes (required to make bulk ATS ingestion work):**
The first 11K bulk run yielded almost nothing (79/11,080) — diagnosed and fixed:
- **URL-first ATS detection** (`stage1_scrapeCareers.ts`): known-ATS URLs hit the JSON API directly, no HTML fetch, no browser. Clean-API results are authoritative, so dead/empty boards skip the HTML+Playwright fallback (which re-hit the throttled host).
- **Greenhouse via `boards-api` JSON** (`adapters/greenhouse.ts`): was scraping the HTML embed page (403s under load); now uses `boards-api.greenhouse.io/v1/boards/{slug}/jobs`.
- **Ashby `jobs`-key bug** (`adapters/ashby.ts`): adapter read `jobPostings`; the API returns `jobs`, so every Ashby board had silently returned 0. Fixed → `ramp`=115 jobs.
- **Per-host rate limiter** (`utils/hostLimiter.ts`): 4 concurrent + 120ms spacing per host (env-tunable) to stop 429/403 storms.

**11K ATS-API promotion — DONE.** Re-run after fixes: 7,366 companies yielded jobs (was 79), 268,081 jobs total, 12,792 creative-gate jobs. `scripts/promotePending.ts` (propose mode) → **1,686 companies carry ≥1 creative job at score ≥6 (4,717 quality jobs)**. 403s/browser-fails dropped to 0; ~1,141 companies still hit a 429 (residual — see reminders).

**Live-list restructure (per product decision 2026-06-18):**
- `pipeline/company_career_urls.json` is now the **1,686 promoted ATS companies** (clean APIs, no browser, ~4,700 creative jobs/run).
- The original 900 custom career pages were **parked** to `pipeline/parked_custom_career_pages.json` (not deleted — niche creative studios that may carry roles the big ATSs don't; revisit when a Chromium-provisioned prune run is worthwhile).
- The 9,394 scraped-but-no-creative companies saved to `pipeline/companies_to_recheck.json` (see reminders).
- `pipeline/pending_review.json` reset to `[]` (all 11,080 decided).

---

## ⏰ Reminders / open follow-ups (check these next session)

1. **Re-check `pipeline/companies_to_recheck.json` (9,394 companies).** These are real ATS boards that scraped fine but had **no creative job at score ≥6 on 2026-06-18**. A company with zero creative openings today may post one next month. Periodically re-scrape this file and run `promotePending` against it to surface new creative roles; promote any that now pass. (Suggested cadence: monthly, or whenever the drop needs more volume.) Command:
   `SCRAPER_URLS_FILE=pipeline/companies_to_recheck.json SCRAPER_OUTPUT_FILE=outputs/recheck.json npm run stage1` then `npm run promote-pending -- --input outputs/recheck.json` (point `PENDING_PATH` logic at this file or just read the promote list).
2. **~1,141 companies hit HTTP 429 during the 11K run** — they may actually have jobs we missed. A gentler retry pass (lower `PER_HOST_CONCURRENCY`, higher `PER_HOST_SPACING_MS`, or a 429-backoff retry in the adapters) would recover them. They're currently in `companies_to_recheck.json`.
3. **Parked 900 (`parked_custom_career_pages.json`)** — only worth a prune run once a Chromium/Playwright environment is available (`npx playwright install chromium`). Use `scripts/pruneCompanies.ts`.
4. **Lever** had near-zero Common Crawl coverage in CC-MAIN-2026-21 — re-run `discoverSlugs` against an older crawl (or add the deferred Google CSE supplement) to pick up Lever companies.

---

---

## Remaining tasks

### Task 1 — Prune non-creative companies (Small) — DEFERRED (see 2026-06-18 note)
- `pipeline/company_career_urls.json` has ~900 entries, many non-creative (Asana, Puma, Zalando, Zomato).
- Run the now-preference-driven scoring against recent scrape output per company; remove/deprioritize companies returning 0 jobs at score ≥ 6. Move borderline → `low_yield_companies.json`.
- Harness is built and ready: `scripts/pruneCompanies.ts` (`npm run prune-companies`). It only needs a fresh Stage 1 scrape of the 900 to run against.

> **Why deferred (2026-06-18):** A composition check showed **894 of the 900 are custom company career pages** on their own websites (e.g. `adoratorio.studio/careers`, `1999.agency/careers`) — NOT standard ATS board URLs. Only ~6 sit on a real ATS. That means scraping the 900 relies almost entirely on the generic HTML crawler + **Playwright/Chromium fallback** (Chromium is not installed in the web/CI container by default and must be added), and yield-per-URL is low (mostly tiny studios with 0–1 openings). We chose to spend the session on the higher-leverage **11K ATS-API promotion** instead (clean JSON APIs, no browser, high yield — see session log). The 900 prune is unchanged in priority intent; it's just gated on a Chromium-enabled scrape run, which is best done locally or in a Playwright-provisioned environment.

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
