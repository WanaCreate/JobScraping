# ScraperAgent (WanaJobsScraper)

A batch field-extraction spec: take a **list of job URLs** and turn it into two complete
tables — one for **job postings**, one for **Instagram postings** — using the existing Stage 2
extractor (`reviewFetchOne.ts`), **not** a new scraper.

Place in the weekly flow:

1. **ScraperAgent (this doc)** — URLs in → two tables out + a `toFetch` list of what couldn't be fetched.
2. **[ReviewerAgent](./ReviewerAgent.md)** — flags issues across the completed tables (and diffs vs. the posting CSV when one exists).
3. **[Wana Job Posting Agent](../docs/WANA-JOB-POSTING-AGENT-GUIDE.md)** — build the upload CSV + DEV/PROD upload.

> Finding *which* URLs to scrape is the **[Job Scraper Agent guide](../docs/JOB-SCRAPER-AGENT-GUIDE.md)**.
> This doc starts once you have a URL list.

---

## The batch flow (read this first)

```
  ┌─ Step 1 ─ user gives URL list
  │
  ├─ Step 2 ─ Scraper fetches each via reviewFetchOne.ts
  │            → builds Table A (job postings) + Table B (Instagram)
  │            → any URL it CAN'T fetch goes in the toFetch list WITH a reason
  │            → writes SCRAPED-INFO-<date>.md  (PASS 1)
  │
  ├─ Step 3 ─ user pastes the full page content for the toFetch URLs
  │
  └─ Step 4 ─ Scraper reads the pasted content, fills in those rows,
               removes them from toFetch → rewrites SCRAPED-INFO-<date>.md (PASS 2, complete)
```

The deliverable is **one file**, written twice: PASS 1 (with a `toFetch` list) and PASS 2
(complete). Hand the completed file to the [ReviewerAgent](./ReviewerAgent.md).

---

## The one tool: `reviewFetchOne.ts`

Do **not** write a new scraper. Fetching + extraction is the shared wrapper, which reuses
`utils/jobDetailExtractor.ts::enrichJobFromUrl`. It does HTTP → Playwright fallback for known
ATS hosts (Ashby, Workday, Greenhouse, Lever, SmartRecruiters, iCIMS) and extracts
title / description / location / salary / workType / jobType via JSON-LD + heuristics.

```bash
cd ..                                   # repo root: _Code/JobScraping
npx tsx WeeklyJobs/reviewFetchOne.ts "<job-url>"
```

It prints **one JSON object** on stdout. On success:

```json
{ "ok": true, "title": "…", "company": "…", "workType": "REMOTE", "jobType": "GIG",
  "location": "…", "salary": { "min": 20, "max": 23, "currency": "USD", "period": "HOURLY" },
  "jobLink": "…", "ats": "generic", "creativeScore": 5, "description": "<p>…</p>" }
```

On a gated / unextractable page:

```json
{ "ok": false, "reason": "no-creative-match-or-unfetchable", "url": "…" }
```

Exit code is **always 0** when it ran — parse the JSON, don't rely on exit code.

### Known-gated hosts (expect `ok:false` → toFetch)

| Host | Why it fails | Action |
|------|--------------|--------|
| **Indeed** (`indeed.com/viewjob`) | Bot-blocked | → toFetch, reason "Indeed bot-block" |
| **Instagram** (`instagram.com/p/…`) | Login wall / no JD text | → toFetch, reason "Instagram — paste caption" |
| **LinkedIn** (`linkedin.com/jobs/view/…`) | Public pages sometimes render, but **never** point Playwright at an auth wall | Try Tier 1 only; if gated → toFetch |
| **Greenhouse / Workday JS shells** | Client-rendered shell returns thin content | Often resolvable; if `ok:false` → toFetch |

> ⚠️ **The extractor's `salary` / `jobType` / `workType` are heuristics and are sometimes wrong**
> — both directions. Observed: invents salary by scraping a LinkedIn *similar-jobs* sidebar;
> misses salary that's plainly in the JD; tags freelance/contract roles `GIG`; tags a
> commuting/field role `REMOTE`. **Always reconcile against the actual description text** before
> finalizing a row, and note in the row when a value is uncertain. The Reviewer flags these,
> but get them right here first.

---

## Step 2 — Build the two tables

For each URL, run `reviewFetchOne.ts`. If `ok:true`, populate both tables from the result
(reconciled against the JD). If `ok:false`, add the URL to **toFetch** with the reason and leave
its table rows blank (or `⚠ toFetch`).

### Table A — Job postings

These are the **same fields the Reviewer audits** and the Posting agent needs. One row per URL:

| # | title | company | workType | jobType | location | salaryMin | salaryMax | salaryCurrency | salaryPeriod | skills | keywords (tags) | externalApplicationLink | companyWebsite | source | status |
|---|-------|---------|----------|---------|----------|-----------|-----------|----------------|--------------|--------|-----------------|-------------------------|----------------|--------|--------|

- `workType` = `Remote` only for kept rows — **confirm against JD text**, not the tag.
- `jobType` ∈ Full-time / Part-time / Freelance / Contract / Internship / Open Call.
- For remote roles: `location` = `Remote` (city only; state/country empty).
- Salary: numbers only, no `$`; leave empty if genuinely unstated — **don't invent**. Backfill from
  the JD if the extractor returned null but the text states pay.
- `status` ∈ `ok` / `ok (reconciled)` / `from-paste` / `⚠ toFetch`.

### Table B — Instagram postings

The compact subset for an IG hiring post. One row per URL:

| # | Summarized description | Job title | Company name | Compensation | Work type | Job type | Open to which locations | status |
|---|------------------------|-----------|--------------|--------------|-----------|----------|-------------------------|--------|

- **Summarized description** — **you (the agent) write this**: a short, punchy **2–3 sentence**
  summary of the role for an IG caption. Plain text, no HTML. What the role is, who it's for, the
  headline perk (remote, pay). Do **not** dump the raw JD.
- **Compensation** — human-readable (`$20–23/hr`, `$100k–150k/yr`, `Unspecified`).
- **Open to which locations** — region/eligibility (`US-only`, `India-only`, `Anywhere`,
  `US citizens only`). State region restrictions — they're allowed and IG readers need them.

### toFetch list

Every URL that returned `ok:false` (or that you skipped to avoid an auth wall):

| # | URL | Reason | Host |
|---|-----|--------|------|
| 6 | https://in.indeed.com/viewjob?jk=… | Indeed bot-block | indeed.com |
| 9 | https://www.instagram.com/p/… | Instagram — paste caption | instagram.com |

Write all of the above (Table A + Table B + toFetch) to:

- **`WeeklyJobs/<date-folder>/scraped/SCRAPED-INFO-<date>.md`** (e.g. `…/June4-2026/scraped/SCRAPED-INFO-june4-2026.md`)

Keep the raw per-URL fetch JSON alongside it (`row-N.json`) for traceability.

Then tell the user, in chat: counts (`X ok · Y toFetch`), the file path, and **ask them to paste
the full page content for the toFetch URLs** (one block per URL, labeled by its `#`).

---

## Step 4 — Finish from pasted content

When the user pastes a table / blocks of full page content for the toFetch URLs:

1. **Read the pasted text directly** (you, the agent) — `reviewFetchOne.ts` is for fetchable URLs
   only; do **not** try to round-trip pasted text through it.
2. Extract the same fields for each pasted row: title, company, workType (from JD text), jobType,
   location, compensation, skills, keywords — and write the 2–3 sentence IG summary.
3. Set those rows' `status` = `from-paste`, **remove them from toFetch**.
4. **Rewrite** `SCRAPED-INFO-<date>.md` (PASS 2) with both tables now complete and an empty (or
   residual) toFetch list.
5. Report: final counts and "ready for review".

If the user can't supply content for a URL, leave it `⚠ toFetch` with the reason — the Reviewer
will mark it REVIEW ("insufficient info — manual check").

---

## Hand-off

The completed `SCRAPED-INFO-<date>.md` (both tables) goes to the
**[ReviewerAgent](./ReviewerAgent.md)**, which flags issues across the content and — when a
posting CSV exists — diffs the tables against it. Table B (Instagram) is also yours to post manually.

---

## Notes / Changelog

- **Batch two-table flow** (URLs → Table A + Table B + toFetch → paste-back → complete).
  Replaces the earlier single-URL job/insta modes.
- Reuses `WeeklyJobs/reviewFetchOne.ts` → `enrichJobFromUrl`. **Never** fork a new scraper.
- Pasted content for gated URLs is read by the agent directly (no code path).
- Extractor fields (`salary`, `jobType`, `workType`) are best-effort heuristics — always reconcile
  against the JD before finalizing.
