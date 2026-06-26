# JobsDrop 2.1 — Scaling Stage 1 to 100K+ Creative Jobs / Week

**Goal:** grow weekly creative-job intake from ~1K (current) to **100K+**, while keeping output
filtered to the creative roles defined in [`pipeline/creativeScore.json`](../pipeline/creativeScore.json).
Budget for paid tools: **up to ~$25/month** (weekly fetch cadence).

**Author note (research-backed):** prices and limits below were verified June 2026. See
[Sources](#sources). Re-check before relying on any paid tier.

---

## TL;DR

- **100K/week does NOT fit a paid feed at $25/mo.** $25 buys ~25K jobs/mo from the cheapest clean
  aggregator (Techmap/Fantastic.jobs at ~$1/1,000), nowhere near 400K/mo.
- The only way to 100K is **free sources for volume, paid spend used surgically for gaps.**
- The single biggest free lever is **ATS board discovery**: our 1K ceiling last week was a
  *company-list* limit, not an API limit. Stage 1 only queries the boards in
  `company_career_urls.json`. Expand to tens of thousands of Greenhouse/Lever/Ashby/Workable
  tenant slugs and the **existing free adapters** pull hundreds of thousands of jobs — same
  `creativeScore.json` filter, just over far more companies.
- Creative coverage of every proposed source was verified (see [Source verification](#source-verification-june-2026)).

---

## Architecture

All sources emit the same `RawJob[]`, then converge on one shared path:

```
                                   ┌─────────────────────────────┐
  [ATS board discovery] ─────────► │                             │
  [Free aggregators]    ─────────► │  scoreTitle() filter        │
  [Apify creative actors]─────────►│  (creativeScore.json,       │ ──► dedup ──► ScrapeResult[]
  [Paid feed — later]   ─────────► │   min score threshold)      │              (Stage 2 unchanged)
                                   └─────────────────────────────┘
```

- **Output shape is unchanged** (`{ source, ats, tenant, jobs_count, creative_jobs }`), so
  **Stage 2 needs zero changes.**
- Reuses existing infra: `creativeScoreLib.scoreTitle`, `normalize`, `runWithConcurrency`,
  `withHostLimit`, and all current ATS adapters.

---

## Build phases

### Phase 1 — ATS board discovery  ← **THIS WEEK**

> Biggest volume lever. No new adapters; reuse `scrapeGreenhouse/Lever/Ashby/Workable`.

- Discover tens of thousands of ATS tenant slugs (Greenhouse, Lever, Ashby, Workable,
  SmartRecruiters) from public slug lists / crawls.
- Feed slugs into the **existing** free JSON adapters.
- Persist discovered slugs (merge into `company_career_urls.json` or a new `discovered_boards.json`).
- Filter every job by `scoreTitle ≥ minScore` (default **4** — keeps designer 6.4 / illustrator 8.5 /
  art director 6.2 / copywriter 4.05 / ui-ux 4.57; drops project manager 3.37 / web developer 2.18).
- **Measure the slug count + resulting job count** — this tells us how close the free path alone
  gets to 100K and whether/where paid fill is even needed.
- **Creative-coverage risk: none.** Same adapters + same filter, more companies.

#### What's different from JobsDrop 2.0 (last week)

2.0 ran the discover → scrape → promote loop over **one** CommonCrawl snapshot and promoted at
score 6. We probed the live index (June 2026) to find where the real ceiling is — the findings
below **corrected our first guess** (that "more CDX pages = more boards"):

- ❌ **Pages-per-host is NOT the lever.** Each ATS host exposes only **1–2 CDX pages** per crawl.
  2.0's 30-page cap already swept the whole latest-crawl index (~8,714 boards across 5 hosts).
  Raising the cap to 300 captures the *same* boards — it does nothing. (We reverted the bump.)
- ✅ **Crawl *snapshots* are the lever.** CommonCrawl lists **125 monthly crawls**; 2.0 used only
  the newest. Unioning slugs across the last ~12 captures companies that dropped out of the latest
  crawl. Measured: `boards.greenhouse.io` = **1,723 slugs (1 crawl) → 4,161 (6 crawls)**, ≈2.4×.
- ⚠️ **Lever is uncrawlable.** `jobs.lever.co/robots.txt` sets `CCBot: Disallow /`, so CommonCrawl
  has **0** usable Lever slugs (only `robots.txt`). 2.0 had no Lever discovery at all. Lever is a
  large ATS, so this is a real gap — addressed via non-crawl sources (see Discovery sources).

Phase 1 changes, by volume lever:

| Lever | Change | Verified effect |
|---|---|---|
| **Multi-crawl union** (the big one) | query last ~12 CommonCrawl snapshots, not just newest | ≈2–4× boards per host |
| **Lever recovery** | discover Lever slugs from **HN Algolia** (+ YC) since CC blocks Lever | 0 → hundreds of Lever boards |
| **New ATS source** | added **SmartRecruiters** to discovery hosts | 0 → ~671 boards (latest crawl) |
| **Promotion floor** | `promote-pending` default min-score **6 → 4** | ~2× promotion yield, same scrape |
| **Recheck recovery** | re-scrape 2.0's 9,394 rejects, promote at score 4 | recovers score 4–5 boards |
| **Instrumentation** | new `measure-discovery` script | tells us the free-path ceiling |

#### Discovery sources (verified reachability, June 2026 — from this environment)

| Source | Reachable? | Use | Notes |
|---|---|---|---|
| **CommonCrawl CDX** (multi-crawl) | ✅ 200, fast | GH / GH-job-boards / Ashby / Workable / SmartRecruiters slugs | 1–2 pages/host/crawl; union ~12 crawls |
| **HN Algolia API** (`hn.algolia.com`) | ✅ 200 | **Lever** slugs (also GH/Ashby) | 42 Lever slugs from 3 pages of one query; no key |
| **Lever postings API** (`api.lever.co`) | ✅ 200, JSON | scrape discovered Lever boards | different host than crawl-blocked `jobs.lever.co` |
| **YC company directory** | ⚠️ page 200 | secondary Lever/GH source | JS-rendered; needs YC's frontend Algolia key or Playwright. Optional. |
| **Getro** (VC aggregator) | ❌ 403 | — | blocked from this env; dropped |
| **Wayback Machine CDX** | ❌ 403 | — | blocked by egress policy; dropped |
| **Google / Bing search API** | n/a | optional daily trickle | free tiers ~1K/day (Google), needs `GOOGLE_API_KEY`+CSE id; gated, non-blocking |
| **Firecrawl** | n/a | — | doesn't enumerate isolated tenant boards; its only real use (JS rendering) is already covered by our Playwright dep. Skipped. |

#### Honest ceiling (measure, don't assume)

Volume ≈ **boards × creative-jobs/board**. Current: 1,686 boards → ~1K/week (≈0.6 creative/board/wk).
Extrapolating: full multi-crawl + Lever recovery (~25–40K boards) → **~15–24K creative jobs/week** —
real progress, but **Phase 1 alone will not hit 100K**. That gap is exactly what Phase 2 (free
aggregators) and Phase 4 (paid fill) are for. Phase 1's job: max the free ATS path and *measure*.

#### Phase 1 runbook

```bash
# 1. Discover boards across all sources (multi-crawl CC + HN Lever recovery)
npm run discover-slugs                       # → pipeline/pending_review.json

# 2a. Scrape the newly discovered boards
npm run scrape-pending                        # → outputs/results_pending.json
# 2b. Re-scrape last week's rejects (recover score 4–5 boards at the new floor)
npm run scrape-recheck                        # → outputs/results_recheck.json

# 3. Measure (per-ATS yield, scale factor, distance to 100K)
npm run measure-discovery                     # reads results_pending.json by default

# 4. Promote qualifying boards (score ≥ 4) into the live list
npm run promote-pending -- --input outputs/results_pending.json --apply
npm run promote-pending -- --input outputs/results_recheck.json --apply
```

#### Decision log

- **Discovery depth:** pages-per-host cap removed (a no-op given 1–2 pages/host); volume comes from
  multi-crawl union instead. Start with last **12** crawls; raise based on measured yield/runtime.
- **Lever:** recover via HN Algolia (no key) as primary; YC as optional secondary. Getro/Wayback
  blocked from this env. Firecrawl unnecessary.
- **Recheck:** 2.0's scrape JSON wasn't persisted → re-scrape the 9,394 rejects, then promote at 4.
- **Google daily:** build but gate behind `GOOGLE_API_KEY`; do not block Phase 1 on it.
- **Task 4 (self-expanding loop):** wired into Stage 2 (was dormant — only fired on Stage 1's
  HTML-fallback path, which clean-API ATS boards skip, so it never ran). It reads
  `hiringOrganization.sameAs` from each job's JobPosting JSON-LD and writes unknown company
  domains to `new_companies_discovered.json` (manual review). **Limitation:** for single-company
  boards (our entire current pile — Greenhouse/Lever/Ashby slugs) `sameAs` points back to the
  *same* company we're already scraping, so it discovers ~nothing. It only finds new companies on
  **multi-company / aggregator pages** (VC portfolio job boards, "hiring across our brands" pages,
  job aggregators) where each posting names a different employer. Treat it as a free, harmless
  safety net — **not** a volume lever until multi-company sources are added.

#### Weekly implementation log

> Append a dated entry each week as this runs, so future weeks see what was actually done + yields.

- **2026-06-26 (build):** Corrected the page-bump misread; implemented multi-crawl union + HN Lever
  recovery + SmartRecruiters host + min-score 4 + `measure-discovery`/`scrape-recheck`. Smoke-tested
  source reachability (table above). Also wired Task 4 self-expanding loop into Stage 2 (see
  Decision log) and added a checkpointing chunked scraper so a multi-hour run survives container
  reclaim. Discovery run: **28,539 candidate boards** found (greenhouse 13,097 · workable 6,973 ·
  lever 3,664 via HN · ashby 3,347 · smartrecruiters 1,458). Scrape + measured numbers: _in progress_.

### Phase 2.1 — (deferred, "as jobs drop") plan refinements
Park forward-looking refinements here; flesh out when Phase 1 volume is measured.

### Phase 2 — Free aggregator adapters  (deferred)

New adapters under `adapters/aggregators/`, each mapping payload → `RawJob` then the shared filter.
All verified to carry creative roles:

| Source | Creative filter | Notes |
|---|---|---|
| **Jobicy** | `?industry=design-multimedia` (+ other creative industries) | ✅ live-confirmed: returns "Creative & Design" (UI/UX, Motion Designer, Product Design). Remote-focused. |
| **Remotive** | `?category=design` / `writing` / `product` | ✅ dedicated Design/Writing/Product categories (Graphic/UI/UX/Web/Product Designers, Creative Directors, Copywriters, Editors). |
| **Adzuna** | `category=creative-design-jobs` + `what=<keyword>` loop from `creativeScore.json`; also `pr-advertising-marketing-jobs` | ✅ keyword + category search, 16 countries. Free tier ~250 calls/day, 50 results/page, capped page depth → breadth source, not a firehose. Needs free `app_id`/`app_key`. |
| **Arbeitnow** | full feed, score-filter locally | ✅ free public JSON, no anti-bot. Europe + remote. |

### Phase 3 — Unified driver `stage1_searchByKeyword.ts`  (deferred)

- Runs ATS-board source + aggregator sources concurrently (`runWithConcurrency` + `withHostLimit`).
- `scoreTitle ≥ --minScore` filter (default 4).
- Dedup across all sources by canonical URL + lowercased title (reuse Stage 2 canonicalization).
- Emits `ScrapeResult[]` JSON for Stage 2.
- CLI: `--input`, `--output`, `--minScore`, `--concurrency`; env `ADZUNA_APP_ID`/`ADZUNA_APP_KEY`.

### Phase 4 — Paid fill  (later)

Use $25/mo surgically for keywords/geographies free tiers miss. Candidates:

| Provider | Price | Volume for $25 | Server-side creative filter? |
|---|---|---|---|
| **Techmap / JobDataFeeds** | ~$1 / 1,000 jobs; Pro $29/mo | ~25K jobs/mo | keyword/category filtering |
| **Fantastic.jobs** | ~$1 / 1,000 jobs (self-serve) | ~25K jobs/mo | searches across many Greenhouse/Lever clients via one endpoint; AI-enriched fields; hourly refresh; 6-month backfill |
| **TheirStack** | API: $59/mo → 1,500 credits (1 credit/job) | too expensive at our budget | rich filters (`job_title_or`, `posted_at_max_age_days`) but ~$0.04/job |

> Recommendation when we get here: **Techmap or Fantastic.jobs** (both ~$1/1,000). TheirStack is
> best-in-class for filtering but ~40× the per-job cost — only worth it for tightly targeted pulls.

---

## Apify — creative-portfolio scrapers (research)

Apify is worth a dedicated note because it has **creative-native** sources the job aggregators lack
(Behance, Dribbble communities), but its economics and a 2026 policy change matter.

### What's actually useful

| Actor | Returns | Verdict |
|---|---|---|
| **Behance Jobs Scraper** (`piotrv1001/behance-jobs-scraper`, others) | Real **job listings**: title, company, location, remote flag, posted date, salary (when shown), apply link; filters by query/location/job type; worldwide/remote toggle; cursor pagination | ✅ **Most useful Apify source.** Behance Jobs is creative-by-construction — near-zero noise to filter. Good Phase-2/3 add. |
| **Dribbble Designers / Designer scrapers** | Mostly **designer *profiles*** (names, skills, ratings, Pro status, contacts), not job postings | ⚠️ Limited for job volume. Useful for talent/sourcing, not for the jobs pipeline. Dribbble *does* have a jobs board, but most Store actors target profiles — confirm an actor returns *listings* before relying on it. |
| **Jobicy Remote Jobs Scraper** (`parseforge/...`) | Same data as Jobicy's free API | ❌ Redundant — use Jobicy's free API directly (Phase 2). |

### Apify economics & caveats (verified June 2026)

- **Free plan:** **$5/mo** platform credits at $0.20/CU, **no rollover**, runs **block** when
  exhausted (rented actors are trial-only on Free). Enough to *trial* an actor, not to sustain volume.
- **Starter:** **$29/mo** ($26 annual) — over budget on its own, and keeps running past prepaid as
  overage. Only consider if Behance proves high-value.
- **Pay-per-result** on many actors (~$0.0023/job for cheap ones, up to $3/1,000 for premium)
  stacks **on top of** compute credits.
- ⚠️ **Apify is retiring the rental-actor model:** no new rental actors / price changes after
  **Apr 1, 2026**; rental actors **fully retired Oct 1, 2026**. Prefer **pay-per-result** or
  **open-source** actors we can run ourselves; avoid building a dependency on a rented actor.

### Recommendation for Apify

- **Phase 2/3 add, not Phase 1.** Wire **Behance Jobs Scraper** as one more aggregator source
  (pay-per-result, run within the $5 free credit first to measure yield/cost).
- **Skip Dribbble** for the jobs pipeline unless we confirm a listings (not profiles) actor; keep it
  noted as a future *talent-sourcing* option.
- Treat Apify spend as part of the same ~$25/mo paid envelope as Phase 4.

---

## Honest expectations

- **Phase 1 alone** (ATS discovery) is the make-or-break for hitting 100K. Realistic range:
  tens of thousands → 100K+/week, **driven entirely by how many ATS slugs we discover.** Measure first.
- Aggregators (Phase 2) + Behance (Apify) add breadth at companies not on a known ATS board, with
  low overlap — good for the long tail and for non-US/remote coverage.
- Paid feeds (Phase 4) at $25/mo are a **gap-filler (~25K/mo)**, not the backbone.

---

## Source verification (June 2026)

- **ATS APIs have no usable server-side keyword search** for the two biggest sources: Greenhouse
  (`/jobs` accepts only `content=true`) and Lever (docs: "does not let you do full-text searches").
  → must fetch full board + filter locally. SmartRecruiters (`q=`) and Workable (`query=`) do have
  search, but not worth a split path. **Conclusion: client-side `creativeScore.json` filter is the
  reliable way to get only creative roles.**
- **Jobicy** `industry=design-multimedia` → live-confirmed "Creative & Design" listings.
- **Remotive** → dedicated Design / Writing / Product categories.
- **Adzuna** → `categories` endpoint + `what=` keyword search; `creative-design-jobs` tag.
- **Behance Jobs Scraper (Apify)** → creative job listings with remote flag + apply link.

## Sources

- Greenhouse Job Board API — https://developers.greenhouse.io/job-board.html
- Lever Postings API — https://github.com/lever/postings-api/blob/master/README.md
- TheirStack pricing — https://theirstack.com/en/pricing
- Techmap / JobDataFeeds — https://jobdatafeeds.com/job-api
- Fantastic.jobs — https://fantastic.jobs/api
- Adzuna developer — https://developer.adzuna.com/overview , https://developer.adzuna.com/docs/categories
- Remotive API + categories — https://remotive.com/remote-jobs/api , https://support.remotive.com/en/article/job-categories-10r0p26/
- Jobicy API — https://github.com/Jobicy/remote-jobs-api
- Arbeitnow API — https://www.arbeitnow.com/blog/job-board-api
- Apify pricing — https://apify.com/pricing ; free-plan analysis — https://use-apify.com/docs/what-is-apify/apify-free-plan
- Apify Behance Jobs Scraper — https://apify.com/piotrv1001/behance-jobs-scraper
- Apify Dribbble Designers Scraper — https://apify.com/parsebird/dribbble-designers-scraper
