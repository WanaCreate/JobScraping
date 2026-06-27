# Architecture Firms — Job Extraction

Extract architecture-related job postings from a curated list of **43 architecture /
engineering firms** (source: `Firms lists_hasi.xlsx`).

- **Phase 1 (this folder):** one-time full extraction of all currently-open
  architecture roles across every firm. ✅ built
- **Phase 2 (not built yet):** a daily/weekly tracker that diffs against the last
  run and reports only *new* postings. ⏳ deferred

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

## Files

```
firms.json         # 43 firms: name, careers URL, scraper strategy, ATS guess
archFilter.ts      # architecture-role title matcher (+ tech-architect exclusions)
extraAdapters.ts   # UltiPro + BambooHR JSON adapters; Workday endpoint builder
scrape.ts          # the runner
output/<date>/     # results
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
