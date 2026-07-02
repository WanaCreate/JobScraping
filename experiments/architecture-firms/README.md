# Architecture Firms — Job Extraction

Extract architecture-related job postings from a curated list of **43 architecture /
engineering firms** (source: `Firms lists_hasi.xlsx`).

> 👉 **START HERE — the latest pipeline is the WEEKLY tracker → [`weekly/`](weekly/README.md).**
> If you're picking this up fresh, that's the one to run:
> `npx tsx experiments/architecture-firms/weekly/run.ts`
> It's the most complete flow (resume-fit scoring → 1-week recency → full detail
> collection with heuristic date/location → optimistic US filter) and produces the
> current deliverable, `output/weekly/<date>/weekly_jobs_<date>.csv`.
> `scrape.ts` (Phase 1) and `track.ts` (daily diff) below are the earlier building
> blocks it's built on — still valid, but not the entry point. The daily tracker is
> the next thing to upgrade with the same resume-scorer + US filter.

## Evolution

- **Phase 1 (`scrape.ts`):** one-time full extraction of all currently-open
  architecture roles across every firm. ✅ built
- **Phase 2 (`track.ts`):** a daily tracker that diffs against the last run and
  reports only *new* postings, with a posted date on every role. ✅ built
  (scoped to the firms we scrape successfully; deferred-ATS firms still skipped.)
- **Phase 3 (`weekly/`) — LATEST:** the weekly tracker pipeline — resume-fit
  scoring + 1-week recency + full job-detail collection + optimistic US-only
  filter. ✅ built. **This is the current entry point.**

## How it works

`scrape.ts` reads `firms.json`, dispatches each firm to the right scraper, filters
job titles down to architecture roles (`archFilter.ts`), and writes a CSV + JSON
snapshot plus a per-firm coverage report.

**Key principle: scrape the real ATS application backend, not the marketing
careers microsite.** A firm's public `.jobs`/careers page is often a thin SPA that
returns partial or cookie-gated data; the ATS it actually uses for applications has
a clean, paginated public API. (Stantec's microsite gave 1 role; its Oracle Cloud
backend gave 100+. AECOM's gave 1; SmartRecruiters gave 370.) To find a firm's ATS,
open a job and look at where the **Apply** button points.

It **reuses the main pipeline's adapters and utilities** plus a few new ones:

| Scraper | Source | Firms | Notes |
|---------|--------|-------|-------|
| `workday` | repo `adapters/workday.ts` + `buildWorkdayEndpoint` | Gensler, HKS, STV, KPF, HNTB | JSON cxs API; endpoint derived from the careers URL path. |
| `smartrecruiters` | repo `adapters/smartrecruiters.ts` | AECOM (`AECOM2`) | Public postings API. |
| `oracle` | `extraAdapters.ts` (new) | Stantec, WSP | Oracle Cloud Recruiting `recruitingCEJobRequisitions` REST API. |
| `eightfold` | `extraAdapters.ts` (new) | Arcadis | Eightfold `/api/apply/v2/jobs` REST API. |
| `ultipro` | `extraAdapters.ts` (new) | Perkins & Will, WATG | UltiPro/UKG `LoadSearchResults` JSON API. |
| `bamboohr` | `extraAdapters.ts` (new) | CetraRuddy | BambooHR `/careers/list` JSON. |
| `jobsyn` | `extraAdapters.ts` (new) | (DirectEmployers `.jobs` sites) | Captures the page's own cookie-authed XHR. Superseded by real ATS where known. |
| `playwright` | repo `adapters/genericPlaywright.ts` | custom-site firms (~16) | Headless Chromium: sniffs XHR/JSON, embedded JSON-LD, and job anchors. |
| `skip` | — | see notes in `firms.json` | No URL, or ATS deferred as complex (Taleo, ADP, iCIMS, Paycom, SuccessFactors, Avature). |

**Resilience:** if a firm's primary scraper errors or returns nothing, the runner
automatically retries with the Playwright generic crawler.

**Deferred (note-and-skip) firms** — ATSes that need dedicated work, recorded with a
`note` in `firms.json`: HDR (Taleo), HLW + Ennead (ADP WorkforceNow), Corgan + Skanska
(iCIMS), Dattner (Paycom), SmithGroup (SuccessFactors, skipped by request), Jacobs (no
accessible ATS), Koning Eizenberg (no URL).

**Architecture-role filter** (`archFilter.ts`): matches building-architecture
titles (Architect, Project/Design Architect, Architectural Designer, Job Captain,
BIM, Revit) and **excludes IT "architect" roles** (Solutions/Software/Data/Cloud/
Enterprise/Systems Architect) — important because large multidisciplinary firms
(AECOM, Jacobs, WSP, Arcadis, Stantec) post both.

## Run it

```bash
# Full run — all 43 firms
npx tsx experiments/architecture-firms/scrape.ts

# Useful flags
npx tsx experiments/architecture-firms/scrape.ts --firm "Gensler"   # one firm (substring)
npx tsx experiments/architecture-firms/scrape.ts --limit 5          # first N firms
npx tsx experiments/architecture-firms/scrape.ts --concurrency 6    # parallel firms (default 4)
npx tsx experiments/architecture-firms/scrape.ts --all-jobs         # also dump every job pre-filter
```

> Note: the repo pins `@esbuild/linux-x64` (it runs in a Linux cloud env), which
> blocks a plain `npm install` on Windows. Axios needs two transitive deps that
> may be missing locally; install them once with:
> `npm install https-proxy-agent proxy-from-env --no-save --force`

## Output

Written to `output/<Month><Day>-<Year>/` (e.g. `output/June27-2026/`):

| File | Contents |
|------|----------|
| `architecture_jobs_<date>.csv` | The deliverable — `firm, title, location, url, ats, sourceUrl, scrapedAt`. |
| `arch_jobs.json` | Same rows as JSON. |
| `run_summary.json` | Per-firm coverage: detected ATS, total jobs found, arch matches, status, errors. |
| `all_jobs_prefilter.json` | Every job found before the arch filter (only with `--all-jobs`) — use to tune the filter. |

## Phase 2 — daily new-jobs tracker (`track.ts`)

Re-scrapes the firms we scrape successfully (every firm in `firms.json` whose
`scraper` isn't `skip`), filters to architecture roles, and **diffs against a
persistent state file** so each run reports only what's *new* since the last one.
Every role also carries a **posted date**.

```bash
# Daily run — diffs against the last run, writes today's new postings
npx tsx experiments/architecture-firms/track.ts

# Flags
npx tsx experiments/architecture-firms/track.ts --firm "WATG"   # one firm (substring)
npx tsx experiments/architecture-firms/track.ts --limit 5       # first N eligible firms
npx tsx experiments/architecture-firms/track.ts --concurrency 4 # parallel firms (default 4)
npx tsx experiments/architecture-firms/track.ts --dry-run       # preview; don't write state
npx tsx experiments/architecture-firms/track.ts --reseed        # rebuild baseline from past runs
```

**First run** auto-seeds its baseline from the most recent Phase-1 snapshot
(`output/<date>/arch_jobs.json`), so day one already diffs against the last full
extraction instead of flagging every open role as new. Use `--reseed` to rebuild
that baseline from scratch.

**Posted date.** Captured straight from the ATS where it's exposed — exact
timestamps from Oracle, SmartRecruiters, UltiPro and Eightfold; Workday only gives
a relative string (`Posted 12 Days Ago`), which the tracker normalizes to a date.
Where a source has no posted date (most custom Playwright sites, BambooHR), the
tracker falls back to **`firstSeen`** — the date *we* first observed the role.
Two columns make this explicit: `datePosted` (raw source value) and `postedDate`
(normalized `YYYY-MM-DD`, or `firstSeen` when the source gave nothing).

### Phase 2 output

| File | Contents |
|------|----------|
| `output/<date>/new_jobs_<date>.csv` | **The daily deliverable** — only roles new since the last run. |
| `output/<date>/open_arch_jobs_<date>.csv` | Full current snapshot — every open arch role + `firstSeen`. |
| `output/<date>/daily_summary.json` | Per-firm counts (scraped / arch / new / closed) + the new & closed lists. |
| `output/_state/seen_jobs.json` | Running state — one entry per role with `firstSeen` / `lastSeen` / `status`. **Don't delete** (it's the memory that makes the diff work). |
| `output/_state/new_jobs_log.csv` | Cumulative log — every new role ever detected, appended each run with a `detectedOn` date. |

## Filtering — recency + US-only (`filter.ts`)

Runs over the tracker state (`output/_state/seen_jobs.json`) — **no re-scraping**, so
heuristics are cheap to iterate. Two filters:

- **Recency** — keeps roles whose *effective date* is within the last N days
  (default 14). Effective date = source `postedDate` when present, else `firstSeen`.
- **US-only** — heuristic classifier (`usGeo.ts`): US states (codes + names),
  ~200 US cities, and a country / ISO-3166 list (handles SmartRecruiters' lowercase
  `us`/`ro`/`in` country codes). Each recent role is split into **US / foreign /
  location-unknown**. No LLM — these strings are short and structured, so lists
  classify everything that *has* a location.

```bash
npx tsx experiments/architecture-firms/filter.ts            # within 14 days, US split
npx tsx experiments/architecture-firms/filter.ts --days 7   # tighter window
npx tsx experiments/architecture-firms/filter.ts --on 2026-06-30   # pin "today" (testing)
```

Outputs (in `output/<date>/`): `recent_<N>d_US_<date>.csv` (the deliverable),
`recent_<N>d_location_unknown_<date>.csv` (review), and `recent_<N>d_all_<date>.csv`
(all three buckets with a `geo` column).

> **Location-unknown** is a *data* gap, not a classification gap: ~that many recent
> roles come from custom-site firms whose scrapers don't capture a location at all
> (empty string), plus Workday "N Locations" multi-site placeholders. An LLM can't
> help with an empty string — the fix is either per-firm location scraping or a
> firm-level region tag in `firms.json`. They're written to the review file rather
> than dropped or guessed.

## Files

```
firms.json         # 43 firms: name, careers URL, scraper strategy, ATS guess
archFilter.ts      # architecture-role title matcher (+ tech-architect exclusions)
usGeo.ts           # US/foreign/unknown location heuristic (states, cities, countries)
extraAdapters.ts   # UltiPro + BambooHR JSON adapters; Workday endpoint builder
scrape.ts          # Phase 1 runner (full extraction); exports its core for track.ts
track.ts           # Phase 2 runner (daily diff + posted dates)
filter.ts          # recency + US-only filter over the tracker state (no re-scrape)
output/<date>/     # results
output/_state/     # tracker state (seen_jobs.json) + cumulative new-jobs log
```

## Coverage (run 2026-06-27)

**1,274 architecture roles across 35 firms** (9 deferred, 0 errors). Top contributors:

| Firm | ATS | Arch roles | Firm | ATS | Arch roles |
|------|-----|-----------:|------|-----|-----------:|
| AECOM | SmartRecruiters | 370 | KPF | Workday | 13 |
| Gensler | Workday | 255 | ZGF | Playwright | 13 |
| WSP USA | Oracle Cloud | 200 | BIG | Playwright | 13 |
| Stantec | Oracle Cloud | 106 | HNTB | Workday | 12 |
| Perkins & Will | UltiPro | 78 | EwingCole | Playwright | 9 |
| WATG | UltiPro | 50 | Grimshaw | Playwright | 9 |
| HKS | Workday | 31 | Studios | Playwright | 8 |
| STV | Workday | 25 | HOK | Playwright | 7 |
| Perkins Eastman | Playwright | 20 | Cannon | Playwright | 6 |
| NBBJ | Playwright | 18 | CetraRuddy / Arcadis / Treanor … | various | 5 each |

Plus single-digit yields from Handel, LMN, Array, Elkus, Populous, Leo A Daly.

**Returned listings but 0 architecture roles** (genuinely few/none, or custom-site
crawler noise — candidates for per-site tuning): SOM, DLR Group, WRNS, Goody Clancy,
Thornton Tomasetti, Payette, RAMSA.

**Deferred (9):** Corgan + Skanska (iCIMS), HDR (Taleo), HLW + Ennead (ADP), Dattner
(Paycom), SmithGroup (SuccessFactors, by request), Jacobs (no ATS), Koning Eizenberg
(no URL). See `note` fields in `firms.json`.
