# Job Cleaning Instructions

Deterministic cleanup rules for `JobScraping` outputs before API ingest.

## Goal
- Remove noise and non-job rows (news, portfolio, breadcrumb-only, agency/service pages).
- Keep real job listings (creative-first, but do not over-delete valid jobs).
- Normalize title, description, URL, and structured fields.

## Input Files
- `outputs/api-ready/latest/results_jobs_api.json`
- `outputs/api-ready/latest/results_jobs_enriched.json`

## Output Files
- `outputs/api-ready/latest/results_jobs_api.cleaned.json`
- `outputs/api-ready/latest/results_jobs_api.cleaned.csv`
- `outputs/api-ready/latest/results_jobs_quality_report.cleaned.json`

## Drop Rules
Drop record if any of these are true:
1. Noise title only:
`Skip to main content`, `Skip to content`, `Home`, `Careers`, `Search jobs`, `View all jobs`.
2. Collection/category title:
`Jobs in design`, `Design jobs`, `Explore jobs in design and creative`.
3. Agency/service headline (not hiring):
`Web design agency`, `Creative agency`, `Branding agency`, `Exhibition stand design`.
4. Awards/news/insight article title:
`Design awards ...`, `What ... taught me ...`, `insight`, `newsletter`.
5. Missing/invalid `jobLink` (non-HTTP).
6. URL is content/service path and not a job path:
`/news`, `/press`, `/blog`, `/article`, `/insight`, `/portfolio`, `/project`, `/case-studies`, `/work`, `/collections`, `/products`, `/services`.
7. Corrupted mojibake title that cannot be trusted.

## Keep Rules
Keep if URL is clearly job-like:
- path includes `jobs`, `job`, `opening`, `position`, `requisition`, `career/careers`, `join-us`, `vacancy`, `apply`, or numeric job id.
- or title has a role (`designer`, `engineer`, `writer`, etc.) plus job context (`hiring`, `internship`, `full-time`, `contract`, etc.).

## Description Cleanup
1. Decode entities and strip HTML/script/style/nav.
2. Remove breadcrumb/navigation garbage:
`Home > Careers`, `skip to content`, `you are here`, `my profile`, `settings`, `sign out`.
Also strip prefix artifacts like:
`Back to jobs...`, `Back to search results...`, `◀ Search Results...`.
3. Remove EEOC/cookie boilerplate.
4. If description is corrupted or too short (`< 40`) and URL is valid job link, set:
`For job details, click apply.`
5. If description is mainly marketing/promo copy (for example:
`Take 20% off any new website plan`, `Use code at checkout`, `Offer terms`),
replace with:
`For job details, click apply.`

## Field Normalization
- Canonicalize URL: remove `utm_*`, `ref`, `source`, `trk`, and hash fragments.
- Normalize `jobType` to: `GIG | FULLTIME | PARTTIME | FREELANCE`.
- Normalize `workType` to: `ONSITE | HYBRID | REMOTE | null`.
- Ensure location object always exists with empty-string defaults and `latitude/longitude = 0`.
- Dedupe `skills` (max 30) and `keywords` (max 40), lowercase normalized.
- Ensure `company.name` exists (derive from domain if missing).

## Dedupe
1. Primary key: canonical `jobLink`.
2. Fallback key: normalized `title + company + city + state + country`.

## Execution
From `JobScraping`:

```powershell
npm run clean-jobs
```

## Optional LLM Second Pass
Use this only after `clean-jobs` for ambiguous leftovers.

Environment (PowerShell):

```powershell
$env:OPENAI_API_KEY='YOUR_KEY'
$env:LLM_CLEANER_MODEL='gpt-4o-mini'
```

Run:

```powershell
npm run clean-jobs-llm -- --input outputs/api-ready/latest/results_jobs_api.json --maxLlmRecords 220 --concurrency 4 --minConfidence 0.75 --syncLatest
```

Notes:
- Only flagged records are sent to LLM (token efficient).
- LLM can only `keep`, `remove`, or `rewrite` title/description.
- If LLM/API fails, record is kept (safe fallback).

## No-API Manual AI Fallback
If external LLM API is unavailable, run deterministic cleaning, then do a manual agent review on flagged rows:
- remove clear listing/non-job URLs,
- rewrite noisy titles,
- keep valid jobs with placeholder description when details are unavailable.

## Mandatory Manual Review (After Script)
After `npm run clean-jobs`, manually inspect `results_jobs_api.cleaned.json` and remove any remaining non-job rows:
- career index pages with generic titles (example: `/careers`, `/jobs` root pages),
- category pages (`/jobs/product-and-design`, `careers/department/...`),
- agency marketing pages that still look like jobs.

Recommended quick scan commands:

```powershell
node -e "const fs=require('fs');const j=JSON.parse(fs.readFileSync('outputs/api-ready/latest/results_jobs_api.cleaned.json','utf8'));console.log(j.filter(x=>/\/(careers?|jobs?)\/?$/.test(new URL(x.jobLink).pathname)).slice(0,30).map(x=>x.title+' | '+x.jobLink).join('\n'))"
```

Optional sync for API ingestion defaults:

```powershell
Copy-Item outputs/api-ready/latest/results_jobs_api.cleaned.json outputs/api-ready/latest/results_jobs_api.json -Force
Copy-Item outputs/api-ready/latest/results_jobs_api.cleaned.csv outputs/api-ready/latest/results_jobs_api.csv -Force
Copy-Item outputs/api-ready/latest/results_jobs_quality_report.cleaned.json outputs/api-ready/latest/results_jobs_quality_report.json -Force
```
