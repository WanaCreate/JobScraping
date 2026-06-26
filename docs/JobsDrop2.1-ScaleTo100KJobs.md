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
