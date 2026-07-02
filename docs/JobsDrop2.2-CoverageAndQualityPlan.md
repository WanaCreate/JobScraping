# JobsDrop 2.2 — Multi-Source Coverage & Quality Plan

> Status: **planning** · Authored 2026-07-01 from a live multi-region creative-jobs
> scraping session (India + EU + US-cities, ~313 verified rows produced outside the
> normal pipeline). This doc compiles what that session learned and how to fold it
> back into the pipeline. Nothing here is implemented yet.

## Context: how this differs from the current pipeline

The current pipeline (see [README](../README.md), [JobsDrop2.1](JobsDrop2.1-ScaleTo100KJobs.md))
is **ATS-API-first, remote-only, US-dominant**: curated ATS company list →
Greenhouse/Lever/Ashby/Workable JSON → creative+remote+recent gate → enrich. Robust,
browser-free, scales via slug discovery.

The session that produced this doc was the inverse shape — **aggregator/LinkedIn-first,
multi-worktype (incl. onsite), multi-region (India/EU/US-cities)**. It hit exactly the
gaps our own docs already flag as open (non-US coverage, non-ATS studios, city-specific
onsite, per-category targeting). Headline finding: **LinkedIn's guest API is scrapable
server-side with no login** — reframing LinkedIn from "out of scope / ban risk" to a
viable primary source for those gaps.

## Priority checklist

- [ ] **P1 — LinkedIn guest-API adapter** (`adapters/linkedinGuest.ts`). Unblocks India,
  US cities, and non-ATS studios in one move. Details + endpoints below.
- [ ] **P2 — Tighten creative classifier**: expand block-list so engineering/PM titles
  can't slip through; add per-discipline category tags (video/motion/illustration/graphic/3D).
- [ ] **P3 — Deterministic geo classifier** in `utils/` (country + city/state), wired into
  normalize. Prevents region mislabeling ("Philippines – Remote" → US) and enables city drops.
- [ ] **P4 — Fix recency policy** in `filter_recent_jobs.py`: drop/quarantine no-date rows
  for strict windows; parse relative dates ("3 days ago").
- [ ] **P5 — Resolve schema drift**: stage CSV headers emit `jobLink` and omit
  `uid`/`externalApplicationLink`/`job.visibility.allowedLocations`/`screeningQuestions`;
  align to the authoritative api-server schema (see [AGENTS.md](../AGENTS.md) lines 68–79).
- [ ] **P6 — Reconcile editorial divergences** (below): remote-only vs onsite, and the
  AI-role rule.

## What the current repo already does better (do NOT change)

- **Logo resolution** — [pipeline/stage4_enrichLogos.ts](../pipeline/stage4_enrichLogos.ts):
  validated favicons `sz=256`, globe-placeholder rejection by SHA-256 (self-healing),
  domain guessing + overrides, DiceBear fallback so a logo is never missing. Superior to the
  session's unvalidated `sz=128` favicons. **Keep.** Only add: for aggregator sources that
  already carry a real CDN logo (LinkedIn `media.licdn.com`), emit it directly and let it
  pass through rather than re-guessing a domain.
- **429 discipline** — [utils/hostLimiter.ts](../utils/hostLimiter.ts) per-host concurrency +
  spacing. The session hit 429s on LinkedIn precisely because it lacked this; route the new
  adapter through it.
- **Dedup** — normalized-URL + (title+company) in [pipeline/cleanAndDedup.ts](../pipeline/cleanAndDedup.ts).
- **Scale model** — slug discovery + promote/prune; aggregators as gap-fill, not backbone.

---

## P1 — LinkedIn guest-API adapter

No login, no browser, `curl`-able server-side. Two endpoints:

```
# 1. Search — returns ~25 job cards per page; paginate start=0,25,50…
https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search
    ?keywords=<kw>&location=<loc>&f_TPR=r518400&f_WT=2&start=0

# 2. Detail — full description + criteria + logo
https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/<jobId>
```

Per **card** (regex-parse the returned HTML): `jobPosting:<id>`, `base-search-card__title`,
`base-search-card__subtitle` (company), `job-search-card__location`, and a
`<time … datetime="YYYY-MM-DD">` — the **exact posted date** (ideal for a hard N-day window).

Per **detail**: `show-more-less-html__markup` (full description — strip the leading
`…overflow-hidden">` class remnant), `description__job-criteria-text` (seniority +
employment type + function + industry), and a `media.licdn.com/…company-logo…` URL.

Params:
- `f_TPR` = time window in **seconds** (`r518400` = 6 days, `r86400`×N for N days).
- `f_WT` = `1` onsite · `2` remote · `3` hybrid.
- `start` paginates by 25.

**Gotchas (learned the hard way):**
- **Location must resolve** — bare `Miami` returns results; `Miami, Florida` returns **0**.
  Use bare city names or country names.
- **Rate-limits on bursts** — route through `hostLimiter`, cache every response by URL hash,
  add ~0.3s spacing. Empty responses ≠ "no jobs"; treat as throttle + back off.
- ~3% of details lack the logo tag → fall back to `og:image`, then stage4.
- Seniority map: `Internship→ENTRY/GIG`, `Entry level→ENTRY`, `Associate→MID`,
  `Mid-Senior level/Director/Executive→SENIOR`. Employment type: `Full-time→FULLTIME`,
  `Part-time→PARTTIME`, `Contract/Temporary→FREELANCE`, `Internship→GIG`.

**Why it matters:** the repo has **no India source today**; this API produced 50 India-graphic
and 39 India-video in one run, plus city-specific onsite roles (LA/Miami/NYC/Nashville) that the
ATS list structurally misses. Same listing-page pattern also works for **remoterocketship**
(`/{cc}/jobs/{slug}` category pages → structured job pages with age/salary/location/company) as a
second aggregator.

## P2 — Classifier precision + per-category tags

Current [utils/creativeClassifier.ts](../utils/creativeClassifier.ts):
- Positive title terms are broad (`design, content, editor, writer, 3d, video`) and the
  `NON_CREATIVE_TITLE_TERMS` list (lines 33–51) is short.
- `isCreativeTitleStrict` (lines 102–110) lets `design|creative|content|brand|art` **rescue**
  otherwise-blocked titles — so "Design Engineer" and "Content Marketing Manager" pass. The
  session hit exactly these false positives.

Fixes:
1. Add a hard block-list that **overrides** the rescue clause:
   `engineer, developer, product manager, program manager, project manager, architect, sales,
   consultant, analyst, accountant, recruiter`.
2. Add **per-discipline** classification (the repo only has binary creative + weighted score;
   the niche list has no distinct animation/motion or 3D bucket). Ready-made regexes in the
   appendix — needed any time a drop is targeted *by category*.

## P3 — Deterministic geo classifier

[utils/normalize.ts](../utils/normalize.ts) passes `location` through as a freeform string
("Not specified" fallback); country/city/state are not parsed deterministically. Risks:
region mislabeling and no city columns for onsite. Add a `detectCountry(loc)` +
`City, ST` splitter (appendix). Reject ambiguous locations (`Worldwide/LATAM/Anywhere`)
rather than defaulting them into a region bucket.

## P4 — Recency policy

[filter_recent_jobs.py](../filter_recent_jobs.py) lines 39–53 **silently keep** rows with no
date, and line 45 only parses ISO `%Y-%m-%d`. This breaks the "posted in last N days"
guarantee and contradicts Rule 8. Change: default **drop/quarantine** no-date rows for strict
windows (flag configurable), and add relative-date parsing (`"3 days ago"`, `"yesterday"`,
`"an hour ago"`) for aggregator/LinkedIn inputs.

## P5 — Schema drift

[pipeline/stage4_enrichLogos.ts](../pipeline/stage4_enrichLogos.ts) `CSV_HEADERS` (lines 140–146)
emit `jobLink` and omit `uid`, `externalApplicationLink`, `job.visibility.allowedLocations`,
`screeningQuestions` — but [AGENTS.md](../AGENTS.md) (68–79) says the authoritative api-server
schema uses `externalApplicationLink` (NOT `jobLink`), and the live `job-bulk-upload-template.csv`
is 33 columns including those fields. Verify/realign stage output to the api-server parser (or
confirm a server-side transform maps it). AGENTS.md notes this class of bug "has bitten us before."

## P6 — Editorial divergences to decide

1. **Remote-only vs onsite** — Rule 4 rejects hybrid/onsite. The session deliberately included
   onsite/hybrid city roles (~150 of 313) per request. Decide whether Wana is expanding to
   city-specific onsite (then the pipeline needs P3 geo/city parsing) or this batch is a one-off.
2. **AI-role rule** — Rule 1 rejects AI-first companies and AI-dependent roles. The session's CSV
   *includes* several (AI image-generation, AI cinematic editor). If it feeds the same product,
   either filter them or record an explicit exception.
3. **Cross-run dedup** — Rule 7 is in-batch only (30-day live dedup is an open TODO). Multi-source
   drops overlap ATS listings heavily, making live-DB dedup more urgent.

---

## Appendix — reusable snippets from the session

### Category regexes (title-anchored) + hard block-list

```python
CATEGORY_RE = {
 'video':        r'video\s*edit|videographer|post[\s-]?production|video\s*(producer|specialist|content|editor)|reels?\s*editor|film\s*editor',
 'motion':       r'motion\s*(design|graphic)|\banimator\b|\banimation\b|mograph|2d\s*anim|3d\s*anim|broadcast\s*design',
 'illustration': r'illustrat|character\s*(art|design)|concept\s*art(ist)?|2d\s*artist|comic\s*artist|storyboard|animatics|visual\s*development',
 'graphic':      r'graphic\s*design|graphic\s*artist|visual\s*design(er)?|brand\s*design(er)?|packaging\s*design|creative\s*design(er)?|production\s*artist|multimedia\s*(design|graphic|artist)|art\s*director|digital\s*designer',
 '3d':           r'3d\s*(artist|design|model|generalist|animator)|digital\s*artist|environment\s*artist|cg\s*artist|technical\s*artist|texture\s*artist|lighting\s*artist|look\s*dev',
}
# Hard block — overrides any "design/creative/content" rescue clause:
TITLE_BLOCK = r'\b(engineer|developer|programmer|manager|analyst|architect|accountant|scientist|sales|recruiter|consultant|full[\s-]?stack|backend|frontend|devops|data)\b'
# relevance = TITLE matches CATEGORY_RE AND NOT TITLE_BLOCK  (title-only for confidence)
```

### Country / city-state detection

```
US_STATES  = { full name → 2-letter abbrev, all 50 + DC }
US_CITIES  = { los angeles, san francisco, new york/nyc, miami, nashville, chicago, austin, … }
EU_COUNTRIES = { united kingdom, ireland, germany, france, spain, portugal, italy, netherlands,
                 belgium, poland, sweden, denmark, finland, norway, austria, switzerland, czechia,
                 romania, greece, ukraine, … }
detectCountry(loc):
   explicit "United States"/US-state/US-city      → United States
   EU-country name / "Europe"|"EU"|"EEA"           → that country / "Europe"
   India / other known country                     → that country
   "Worldwide"|"Global"|"Anywhere"|"LATAM"|"EMEA"  → None  (REJECT from region buckets)
   else                                            → None  (REJECT — do not default to US)
# city/state: match /^([A-Za-z .]+),\s*([A-Z]{2})$/ and confirm state ∈ US_STATES ∪ {DC}
```

### LinkedIn guest fetch (curl, cached)

```bash
UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36'
curl -s -A "$UA" \
 "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=motion%20designer&location=Mumbai&f_TPR=r518400&f_WT=2&start=0"
curl -s -A "$UA" \
 "https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/<jobId>"
```

> The full working Python reference implementation (search parse, detail parse, seniority/type
> maps, category + geo gates, row builder) from the session is available on request — port it to
> `adapters/linkedinGuest.ts` against the existing `RawJob`/`NormalizedJob` types and `hostLimiter`.
