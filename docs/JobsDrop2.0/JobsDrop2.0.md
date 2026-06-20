# Jobs Drop — Strategy & Technical Notes

_Last updated: 2026-05-26 (scraping research + preference-driven scoring added)_

---

## Context for new chat

**What we decided:** Evolve the existing pipeline scraper (Approach B) rather than rebuild. The pipeline is already complete and working — ATS detection, API adapters, enrichment, logos are all built.

**Two parallel improvements:**
1. **Grow `company_career_urls.json` from 900 → 5000+** creative-focused URLs so the pipeline has enough source material.
2. **Make `creativeClassifier.ts` preference-driven** — replace its hardcoded keyword tiers with a weekly-regenerated `creativeScore.json` aggregated from actual user preferences in the DB.

Everything else in the pipeline (Stages 2–4, ATS adapters, career-page fallback, logos) stays as-is.

**Key directories:**
- Pipeline scraper: `c:\Users\vyash\Desktop\Business\Wana\_Code\JobScraping`
- Playwright/agent scraper: `c:\Users\vyash\Desktop\Business\Wana\_Code\Playwright`
- API server (relevance matching, auto-apply): `c:\Users\vyash\Desktop\Business\Wana\_Code\api-server`

**Pipeline scraper tech stack:** TypeScript (Node.js), Playwright, Cheerio, GPT-4.1-nano for enrichment. Existing stages in `JobScraping/` are worth keeping (Stage 2 extract, Stage 3 GPT enrich, Stage 4 logos). Stage 1 (`stage1_scrapeCareers.ts`) is what we're augmenting.

**What already exists in the pipeline (do not rebuild):**
- `ats/detectATS.ts` — detects which ATS a company uses from HTML/URL
- `ats/extractTenant.ts` — extracts the company slug from ATS URLs
- `adapters/greenhouse.ts`, `lever.ts`, `ashby.ts`, `workday.ts`, `smartrecruiters.ts`, `icims.ts` — all ATS API adapters already built
- `adapters/genericHtmlCrawler.ts` — crawls `/careers`, `/jobs`, `/work-with-us` etc. and falls back to Playwright. This is Phase 3 fallback, already built.
- `pipeline/company_career_urls.json` — the list to grow (currently 900 URLs)

---

## Product Strategy

### What is Jobs Drop?
Weekly curated job releases personalized to each user's preferences. Users open the app to see new roles relevant to them — no searching across platforms. Replaces the current manual Instagram curation (15–100 roles/week) with an in-product experience.

### Why it matters
- **Acquisition:** Instagram job posts already prove demand. Jobs Drop brings that value in-app and makes it shareable/linkable as a weekly event.
- **Retention:** Creates a weekly habit loop — check the drop, see relevant roles, apply. But retention fix requires Jobs Drop to *transition* users into stickier features (feed, challenges, contracts), not replace them.
- **Risk:** If built as an isolated job board it just recreates LinkedIn for artists. The drop is the door, not the destination.

### Retention context
- Main churn hypothesis: job-search is episodic. Users come for jobs, find them or don't, then go quiet.
- Key unknown: are churned users even aware of feed/challenges, or do they leave before engaging?

---

## Scraping Approaches

### Approach A — Current: Claude Code with Browser (Playwright)
- Compile all user preferences first
- Agents crawl and find relevant roles per user
- Lives in: `c:\Users\vyash\Desktop\Business\Wana\_Code\Playwright`
- Strength: personalized from the start, flexible for novel sources
- Weakness: agent-driven crawling is expensive and fragile at scale

### Approach B — Previous: Pipeline-based scraper
- Lives in: `c:\Users\vyash\Desktop\Business\Wana\_Code\JobScraping`
- 4-stage TypeScript pipeline: scrape → extract → GPT enrich → logo/shuffle
- Playwright + Cheerio for rendering, GPT-4.1-nano for enrichment
- Supports 9 ATS platforms: Greenhouse, Lever, Workday, SmartRecruiters, iCIMS, Ashby, Amazon + generic HTML/Playwright fallback
- Sources: company career pages directly (high signal, low competition)
- Output: structured CSV → API ingestion

#### Pipeline stages
| Stage | File | Output |
|-------|------|--------|
| 1 | `stage1_scrapeCareers.ts` | `results_scrape.json` — raw jobs |
| 2 | `stage2_collectJobDetails.ts` | `results_jobs_api.csv` — extracted data |
| 3 | `stage3_enrichGpt.ts` | `results_enriched_api_gpt.csv` — GPT enriched |
| 4 | `stage4_enrichLogos.ts` | Final CSV with logos, shuffled |

---

## Relevance Matching (already implemented)

### Job-to-user relevance (JobScraping)
- **Creative filter:** regex on title against keyword list (designer, animator, UX, illustrator, motion, 3D, etc.)
- **Creative classifier** (`creativeClassifier.ts`): strict title check + scoring. Must pass strict title + score ≥ 2.
- **Score-based tiers** (`score_jobs.py`): Python post-process, scores 2–10 by role type
  - 10: illustrator, animator, graphic designer, UX/UI, motion, VFX, 3D
  - 8: copywriter, brand design, web design, musician, film production
  - 6: content manager, game dev, digital marketing
  - 4: marketing, brand comms, social media
  - 2: engineering, data, finance, ops (near-filtered)

> **Note:** These hardcoded tiers are being replaced by a weekly preference-driven `creativeScore.json` — see [Task 0](#task-0--weekly-preference-aggregator--dynamic-creativeclassifierts) in the Developer Action Plan.

### Form field matching (api-server)
- Lives in: `api-server/src/services/externalApply/adapters/matchers.ts`
- Used for auto-applying: maps applicant profile fields to ATS form controls
- Signals: control type, ARIA role, selector regex, label text regex — AND-combined
- Unmatched fields fall through to LLM planner

---

## Scaling Plan (discussed)

### Recommended sequence
1. **Stabilize scraping** — reliable sources before more volume. Broken scraper at scale = worse than small clean dataset.
2. **Portfolio-aware matching** — Wana's moat. Embed portfolio description + job description, match semantically. No other job board has portfolio signal.
3. **Behavioral feedback loop** — track clicks, applications, responses to tighten matching per user over time.
4. **Then scale volume** — high match quality first, then more jobs = more value.

### Key infrastructure concerns at scale
- Rotating proxies + headless browser pool (Playwright already in use)
- Scraper health monitoring (alert on broken scrapers, not just errors)
- Fuzzy deduplication across sources (same role on 5 platforms)
- Weekly drop cadence has brand value — decide early if it stays weekly event vs. live feed

### Portfolio-aware matching (not yet built)
- Extract skills, style tags, medium (digital/traditional/3D), industry focus from portfolio
- Semantic similarity between portfolio embedding and job description embedding
- This is the differentiator vs. generic job boards

---

## How Job Aggregators Scale — Research Findings

### The core insight
Major aggregators are **not scraping job boards** — they maintain a mapping of `{company_slug → ATS platform}` and call clean public JSON APIs. Scraping complexity only arises for iCIMS, Workday, and custom career pages. Most creative companies use Greenhouse, Lever, or Ashby — all of which have free, unauthenticated, paginated JSON APIs.

### ATS Public APIs (no auth required)

| ATS | Endpoint | Notes |
|-----|----------|-------|
| **Greenhouse** | `boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true` | Largest ATS, ~220K companies. Add `?content=true` for descriptions. |
| **Lever** | `api.lever.co/v0/postings/{slug}?mode=json` | Strong in design-forward startups. Supports `?team=Design&location=Remote` filters. |
| **Ashby** | `api.ashbyhq.com/posting-api/job-board/{slug}?includeCompensation=true` | Fastest growing, dominant in AI/creative-tech startups. Best salary data. |
| **SmartRecruiters** | `api.smartrecruiters.com/v1/companies/{slug}/postings` | Mid-market creative companies. |
| **Workday** | `POST {tenant}.wd{N}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs` | Enterprise (Netflix, major studios). Requires POST not GET. Server number varies (wd1–wd5). |
| **iCIMS** | `{company}.icims.com/sitemap.xml` → HTML parse | Enterprise media/entertainment. Sitemap gives all job URLs, then scrape HTML. |
| **Lever XML** | `api.lever.co/v0/postings/{slug}?mode=xml` | RSS/XML feed available natively. |
| **Personio** | `{company}.jobs.personio.de/xml?language=en` | EU companies. XML only. |

These 6 APIs cover ~60-70% of all creative industry jobs.

### The URL list problem — how to solve it

**The actual bottleneck isn't scraping — it's knowing which company slugs to probe.**

#### Phase 1: Google Custom Search bootstrap (fastest, free)
Query Google for creative job titles scoped to ATS domains. Google returns real live URLs with the company slug already in them — no guessing needed.

Example queries:
```
site:boards.greenhouse.io "animator" OR "motion designer" OR "concept artist"
site:jobs.lever.co "illustrator" OR "art director" OR "graphic designer"
site:jobs.ashbyhq.com "character artist" OR "VFX" OR "3D artist"
```

Each result URL looks like `boards.greenhouse.io/riot-games/jobs/123` → extract `boards.greenhouse.io/riot-games` → add to `company_career_urls.json`.

- **Cost:** Free tier = 100 queries/day via Google Custom Search API. $5/1000 queries after that.
- **Yield:** ~500–1000 new creative-focused company URLs in a few days at zero cost.
- **Key point:** You're not guessing slugs — Google hands you verified URLs for companies that currently have relevant creative jobs.

#### Phase 2: Self-expanding loop (ongoing, automatic)
Already partially supported by the pipeline. When a job is scraped, the `hiringOrganization.sameAs` field in `schema.org/JobPosting` JSON-LD contains the company's main website. Add logic to:
1. Extract that domain from every scraped job
2. Check if it's already in `company_career_urls.json`
3. If not, add it to a probe queue → genericHtmlCrawler finds the career page → add to the list

The company list grows itself with every pipeline run.

> _This is implemented as [Task 3](#task-3--self-expanding-loop-in-stage-1) in the Developer Action Plan._

#### Phase 3: Career page fallback (already built)
`adapters/genericHtmlCrawler.ts` already handles this — tries `/careers`, `/jobs`, `/work-with-us` etc. and falls back to Playwright. No need to build. No need for Clearbit/PDL.

#### Phase 4: Web Data Commons bulk import (one-time, optional)
Pre-extracted `schema.org/JobPosting` JSON-LD from Common Crawl — free download. Filter by creative job title keywords to get thousands of company domains in one batch. Worth doing once to jumpstart the list significantly.

### schema.org/JobPosting — structured data on career pages
All major ATS platforms inject this JSON-LD into their hosted job pages (required for Google for Jobs). Extractable with `extruct` (Python) or `@extractus/article-extractor` (Node) — no brittle CSS selectors needed.

Key fields: `title`, `hiringOrganization.name`, `hiringOrganization.sameAs`, `jobLocation`, `datePosted`, `validThrough`, `baseSalary`, `employmentType`, `description`

### Deduplication
Same role appears on 5 platforms. Fuzzy match on: `title + company + location`. Required before jobs hit users.

### Niche creative sources worth adding
- **Wellfound** (ex-AngelList) — 130K listings, skews creative-tech startups, Greenhouse/Lever/Ashby integrated
- **Jooble API** — free aggregator API, 140K sources globally, good for long-tail and non-US
- **Coroflot** — 2,000+ design companies, good for seeding company list
- **ArtStation** — game/film/VFX industry specifically

### How Indeed works (for reference)
Indeed gets jobs three ways: (1) ATS vendors push XML feeds to Indeed every 6 hours, (2) Indeed's crawler detects `schema.org/JobPosting` on career pages, (3) sponsored jobs via API. Notably permissive for scrapers — no rate limiting on search as of 2025/2026.

### Recommended stack for Wana
1. Build `{company → ATS slug}` mapping from creative board seeding + slug probing
2. Daily/weekly API calls to Greenhouse, Lever, Ashby, SmartRecruiters (clean JSON)
3. Workday POST + iCIMS sitemap for enterprise entertainment companies
4. Web Data Commons bulk import for initial scale
5. Jooble API as supplementary fallback for long-tail roles

---

## Developer Action Plan

**Goal:** Two parallel improvements to the existing pipeline:
1. **Scale `company_career_urls.json`** from 900 → 5000+ creative-focused URLs.
2. **Make `creativeClassifier.ts` preference-driven** — scoring rubric is regenerated weekly from actual user preferences in the DB, not a hardcoded keyword list.

**Nothing else in the existing pipeline needs to be rebuilt.** All ATS adapters, career page crawler, enrichment, and logo stages are already working.

**Recommended task order:** Task 0 → Task 1 → Task 2 → Task 3 → Task 4.

---

### Task 0 — Weekly preference aggregator + dynamic `creativeClassifier.ts`
**Priority: High | Effort: Medium**

Today `creativeClassifier.ts` uses a hardcoded keyword list and static tier weights (see `score_jobs.py` lines 79–83 in `JobScraping/`, referenced in the [Relevance Matching](#relevance-matching-already-implemented) section above). This makes the classifier blind to what users actually want, and stale relative to who is signing up.

**Replace the static list with a weekly-regenerated `creativeScore.json` driven by user preferences.**

#### Sub-task 0a — Preference aggregator script
Build a script (Node.js/TypeScript, lives in `api-server/scripts/` or `JobScraping/scripts/` — dev's choice) that:
1. Queries the user DB for **active users** — defined as **any user who has filled their job preferences** (i.e. `preferences IS NOT NULL` / non-empty). No login-recency filter for v1.
2. Aggregates into a weighted keyword map. **Option 1 (recommended for v1):**
   ```json
   {
     "motion designer": 8.4,
     "3D artist": 7.9,
     "illustrator": 6.2,
     "graphic designer": 5.8,
     ...
   }
   ```
   Weight = normalized share of users who selected the preference (e.g. `(users_with_pref / total_users) * 10`).
3. Writes `creativeScore.json` to the pipeline directory (`JobScraping/pipeline/` or wherever the classifier reads from)
4. Runs once per week, before the scrape pipeline kicks off (cron or manual trigger — start manual)

**Dev note on aggregation logic:** The `api-server` side already has relevance/matching logic (`api-server/src/services/externalApply/adapters/matchers.ts` for form fields, and existing user-preference handling elsewhere). **You can either reuse that logic** if it's already aggregating preferences in a similar way, **or build this script standalone.** Whichever is faster — they should converge over time, but don't block on refactoring the api-server side first.

#### Sub-task 0b — Update `creativeClassifier.ts`
1. Read `creativeScore.json` at startup instead of using the hardcoded keyword list
2. Keep the existing strict-title + score-threshold gate logic — only the *weights* change
3. Fall back to a checked-in default `creativeScore.json` if the file is missing (so the pipeline never fails on a missing weekly file — it just runs with last week's weights)

#### Why this design
- **No per-job DB roundtrip during scraping** — scraper still reads a static file
- **Preferences refreshed weekly** — captures user updates and new signups
- **Single source of truth for scoring** — no drift between scrape-time and serve-time classifiers
- **Naturally adaptive** — if "3D character art" surges this month, weights reflect it automatically
- **Cold-start safe** — checked-in default file means scraper works even before first aggregation run

#### Dev notes / open questions

**Preference storage shape (confirm before starting):**
Are user preferences stored as **discrete tags/categories** (checkboxes like "motion", "3D") or **free text**?
- Discrete → aggregator is a simple `GROUP BY` query.
- Free text → needs light NLP normalization (lowercase, lemmatize, map synonyms) before aggregating. Don't jump to embeddings for v1.

**Weight smoothing / minimum-N floor:**
If only a handful of users selected a niche preference (e.g. 3 out of 10,000 selected "puppet animation"), the raw weight is noise that swings 10× when one more user signs up. Apply both:
- **Floor:** ignore any preference with fewer than 5 supporting users (tune the threshold once you see real distribution).
- **Smoothing:** consider log-scaling (`log(1 + users_with_pref) / log(1 + total_users) * 10`) or additive smoothing so weights don't whipsaw week-over-week.

**Schema specifics for `creativeScore.json`:**
The example above is a flat keyword→weight map. But the existing classifier also has a **strict-title gate** (the title must match a known creative role before scoring even starts). Decide before writing the file:
- **Option A (recommended):** keep the strict-title list hardcoded in `creativeClassifier.ts`; `creativeScore.json` only supplies the *weights* layered on top. Simpler, safer.
- **Option B:** put both in the file — e.g. `{ "strictTitles": [...], "weights": { "motion designer": 8.4, ... } }`. More flexible but the weekly aggregation has to decide what counts as "strict" which is harder.

**Versioning / rollback:**
A bad aggregation run (DB query bug, empty result) would silently feed the scraper garbage. Two cheap safeguards:
- Keep the last N weeks of files: `creativeScore-2026-05-26.json` with a `latest` pointer.
- Sanity-check before overwriting: reject the new file if total keyword count drops >50% or total user count drops >50% week-over-week. Log the rejection; keep last week's file in place.

**Negative signals:** v1 is positive preferences only. If users can mark "not interested in marketing" in the DB, ignore those for now — deferred until v2.

**Pipeline orchestration:**
Aggregator must run *before* the scraper each week. v1 is **manual coordination** — dev runs the aggregator, then triggers the pipeline. Cron / orchestration deferred until the manual flow proves out.

**Seam with api-server's serve-time relevance layer:**
The api-server has its own per-user relevance scoring (lines 84–88). Now that the scraper produces a `creativeClassifier` score per job, that boundary needs to be defined:
- **Recommended:** api-server trusts the pipeline's score as a *base relevance signal*, then re-ranks per-user on top of it (using user-specific preference matches, portfolio similarity later, etc.). Pipeline score is a floor filter ("is this even a creative job?"), serve-time scoring is the personalization.
- **Action:** confirm this is how the api-server should consume `creativeClassifier` scores; otherwise the two scoring systems can drift and contradict.

---

### Task 1 — Filter existing `company_career_urls.json` for creative relevance
**Priority: High | Effort: Small | Requires: Task 0 complete**

**Run this before Task 2** so we have a clean baseline to measure URL-expansion gains against.

The current 900-entry list has many non-creative companies (Asana, Puma, Zalando, Zomato). To clean it up:
1. Run the (now preference-driven) `creativeClassifier.ts` scoring against job titles from each company's recent scrape output
2. Remove or deprioritize companies that consistently return 0 jobs above the score threshold
3. Move borderline ones to a `low_yield_companies.json` for periodic re-checks rather than every-run scraping

**Why first:** Establishes a clean baseline yield-per-URL number. Without this, we can't tell if Task 2's gains came from new URLs or just from removing noise.

---

### Task 2 — Google Custom Search scraper script
**Priority: High | Effort: Small**

Build a standalone script (TypeScript, lives in `JobScraping/scripts/` — create the directory if it doesn't exist) that:
1. Takes a list of creative job title keywords (animator, motion designer, concept artist, art director, illustrator, VFX artist, graphic designer, UX designer, 3D artist, character artist). **Bonus:** pull these keywords directly from `creativeScore.json` so the CSE queries stay aligned with current user preferences.
2. For each keyword, queries Google Custom Search API scoped to:
   - `site:boards.greenhouse.io`
   - `site:jobs.lever.co`
   - `site:jobs.ashbyhq.com`
3. Parses result URLs to extract the base company career URL (e.g. `boards.greenhouse.io/riot-games`)
4. Deduplicates against existing `company_career_urls.json`
5. **Writes new URLs to `pending_review.json` first** (not directly to the main list) — Task 1's classifier promotes them after a sample scrape

**Setup needed:** Google Custom Search API key (free tier: 100 queries/day). Create a Programmable Search Engine at [programmablesearchengine.google.com](https://programmablesearchengine.google.com).

**Expected output:** 500–1000 new creative-focused company URLs after promotion gate.

---

### Task 3 — Self-expanding loop in Stage 1
**Priority: Medium | Effort: Small**

In `pipeline/stage1_scrapeCareers.ts`, after each job is scraped:
1. Check if the job's HTML contains `schema.org/JobPosting` JSON-LD
2. Extract `hiringOrganization.sameAs` (company website URL)
3. If that domain is not already in `company_career_urls.json`, add it to `new_companies_discovered.json`
4. After each pipeline run, the discovery file is reviewed manually first; automate the promotion later via the same classifier-gate used in Task 2

This turns every pipeline run into a discovery engine — no extra infrastructure needed.

---

### Task 4 — Web Data Commons bulk import (one-time)
**Priority: Low | Effort: Small-Medium**

Pre-extracted `schema.org/JobPosting` JSON-LD from Common Crawl — free download. One-time job to push past 5000 URLs faster than CSE + self-expansion alone.

1. Download the latest Web Data Commons JobPosting extraction
2. Filter by creative job title keywords (same list as Task 2)
3. Extract unique company domains → run through `pending_review.json` gate from Task 2
4. Done — don't repeat unless yield drops

Skip if Tasks 1–3 already hit the success metric.

---

### Operational concerns at scale

- **Rate limiting:** Going 900 → 5000 URLs means ~5× API calls to Greenhouse/Lever/Ashby. Add per-host concurrency caps in Stage 1 (suggest: 4 concurrent requests per ATS host, 100ms minimum spacing).
- **Stale jobs:** Confirm Stage 2 or 3 respects `validThrough` from JSON-LD so expired roles don't surface in drops. If not, add a filter.
- **Monitoring:** With 5× the URLs, broken scrapers become more likely. Log per-URL success/failure counts; alert when a previously-yielding URL returns 0 jobs for 2+ consecutive runs.

---

### What NOT to change
- Stage 2 (`stage2_collectJobDetails.ts`) — working, keep as-is
- Stage 3 (`stage3_enrichGpt.ts`) — working, keep as-is
- Stage 4 (`stage4_enrichLogos.ts`) — working, keep as-is
- All ATS adapters — working, keep as-is
- `genericHtmlCrawler.ts` — already handles career page fallback, no changes needed
- Per-user relevance matching (api-server) — already implemented; user-aware re-scoring stays at serve time, not scrape time

---

### Success metric
Pipeline run produces **500+ jobs with `creativeClassifier` score ≥ 6** (currently ~100–200 at any score), using the weekly preference-driven `creativeScore.json`.

- **Volume floor:** 500+ jobs ensures enough material to personalize per user downstream.
- **Quality floor:** Score ≥ 6 filters out noise (engineering, finance, ops) without needing per-user DB lookups during scrape.
- **Per-user relevance** remains a downstream concern handled by the api-server's existing relevance layer — not the scraper's job.
