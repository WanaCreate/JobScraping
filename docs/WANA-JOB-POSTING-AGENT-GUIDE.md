# Wana Job Posting — Agent Quick Reference

Complete instructions for creating job CSVs and uploading to **DEV** or **PROD**. Use this doc so an agent can work end-to-end without re-discovering rules from chat history.

**Repo:** `JobScraping` (this folder). Upload tooling and API live in the parent **NEW_WEB** monorepo (`../api-server`, `../JobScraping/pipeline/` when run from monorepo root).

**Prerequisite:** URLs should be reviewed first with [WeeklyJobs/ReviewerAgent.md](../WeeklyJobs/ReviewerAgent.md) (only **PASS** / approved **REVIEW**). Discovery rules: [JOB-SCRAPER-AGENT-GUIDE.md](./JOB-SCRAPER-AGENT-GUIDE.md).

**Do not** commit or push unless the user explicitly asks.

---

## Agent checklist (read first)

1. Scrape or collect job URLs and posting text.
2. Build or fix a CSV using the **standard headers** below (or the scrape CSV schema).
3. Write **description** HTML using the **spacing pattern** (heading + `<br />` + body in one `<p>`, then `</p><br />` before the next section).
4. Set **location** so the app shows **one** “Remote” (not “Remote, Remote”).
5. Set **apply method**: external (default) or email — never both active.
6. Use **favicon** URLs for `companyLogo` unless a real company logo URL exists.
7. Upload to **DEV only** unless the user says PROD.
8. On re-upload: **delete** old jobs first (same `jobLink`), then upload with **`createdAt` = today** so jobs sort to the top.
9. Confirm jobs under the user’s account via **My Jobs** when using dev test credentials.

---

## Environments

| | DEV | PROD |
|---|-----|------|
| API base | `http://localhost:8000` | `https://wana-api-server-prod.onrender.com` |
| API must be running | Yes — `cd ../api-server && npm run dev` | Hosted |
| Typical upload account | `errrrr77@gmail.com` (test) | `hello@wana.download` (admin) |
| When to upload | Default for all agent work | **Only when user explicitly requests PROD** |
| Prod safety | N/A | Set `WANA_CONFIRM_PROD_UPLOAD=1` and `WANA_API_BASE` to prod URL |

Store passwords in env vars at upload time — **never** commit credentials into this repo.

```powershell
# DEV
$env:WANA_UPLOAD_EMAIL="errrrr77@gmail.com"
$env:WANA_UPLOAD_PASSWORD="<dev-password>"
$env:WANA_API_BASE="http://localhost:8000"

# PROD (only when user asks)
$env:WANA_CONFIRM_PROD_UPLOAD="1"
$env:WANA_API_BASE="https://wana-api-server-prod.onrender.com"
$env:WANA_UPLOAD_EMAIL="hello@wana.download"
$env:WANA_UPLOAD_PASSWORD="<prod-password>"
```

---

## CSV headers (manual / illustrator batches)

Use this **exact column order** (quoted CSV, UTF-8):

```text
title,jobType,description,deadline,keywords,skills,jobLink,workEmail,numberOfPositions,workType,formattedAddress,city,state,country,latitude,longitude,company,companyWebsite,companyLogo,companyEmail,salaryMin,salaryMax,salaryCurrency,salaryPeriod,allowEmailApplications,hiringTeam,screeningQuestions
```

### Scrape pipeline CSV (Stage 2+ output)

Scrape files may use a different column order and include:

- `externalApplicationLink` instead of (or in addition to) `jobLink`
- `createdAt`, `job.visibility.allowedLocations`, `locationName`, `placeId`, etc.

The API accepts `externalApplicationLink` and `jobLink`; stored apply URL is written to `jobLink` on the job record.

---

## Field rules

### Title (`title`)

- Use the **real job title** from the posting when the user does not specify otherwise.
- User may override (e.g. all rows `Illustrator`, or `Graphic Designer` for a specific company).

### Job type (`jobType`)

CSV values (API normalizes):

| CSV examples | API value |
|--------------|-----------|
| `Full-time`, `FULLTIME`, `Full Time` | `FULLTIME` |
| `Part-time`, `PARTTIME` | `PARTTIME` |
| `Freelance`, `FREELANCE` | `FREELANCE` |
| `Contract`, `Internship`, `GIG` | Often `GIG` for Internship |
| `Open Call`, `OPEN_CALL` | `OPEN_CALL` |

### Work type & location (remote jobs)

For **remote** jobs (most creative batches):

| Field | Value |
|-------|--------|
| `workType` | `Remote` |
| `city` | `Remote` |
| `state` | *(empty)* |
| `country` | *(empty)* |
| `formattedAddress` | *(empty)* |
| `latitude` / `longitude` | *(empty)* |

**Important:** Do **not** set both `city` and `state` to `Remote`. The job card joins city + state → **“Remote, Remote”**. Only `city` should be `Remote`.

For **on-site** open calls, use real `city`, `state`, `country`, `workType` = `On-site` / `ONSITE`, and real `formattedAddress` when known.

### Application method

**External apply (default for almost all scraped jobs):**

| Field | Value |
|-------|--------|
| `jobLink` | Full apply URL from the posting |
| `allowEmailApplications` | `false` |
| `workEmail` | *(empty)* |
| `companyEmail` | *(empty)* |

**Email apply (only when posting says apply by email):**

| Field | Value |
|-------|--------|
| `jobLink` | *(empty)* |
| `allowEmailApplications` | `true` |
| `workEmail` | Application inbox |
| `companyEmail` | Same as `workEmail` if needed |

**Critical for upload:** The API uses `externalApplicationLink` on upload if present. For external jobs, inject at upload time:

```text
externalApplicationLink = jobLink
```

(The monorepo upload scripts do this; do not rely on `jobLink` alone.)

### Company logo (`companyLogo`)

Prefer Google favicon (256px):

```text
https://www.google.com/s2/favicons?domain=COMPANY_DOMAIN&sz=256
```

Use the company’s real site domain (not LinkedIn/Instagram/ATS domain unless that is the only apply surface).

### Keywords & skills

- Comma-separated lists in manual batches: `keyword1,keyword2,keyword3`
- Scrape CSV may use semicolons in `skills`; API splits on `,` and `|`
- Keep terms relevant to the role (tools, discipline, industry)

### Salary

| Field | Notes |
|-------|--------|
| `salaryMin` / `salaryMax` | Numbers only, no `$` |
| `salaryCurrency` | `USD`, `IDR`, etc. |
| `salaryPeriod` | `hour`, `year`, `month`, `project` — API maps `year` → `ANNUAL` |

Leave salary fields empty if unknown.

### Deadline

ISO date optional, e.g. `2026-12-31T23:59:59.000Z`. Empty is fine.

---

## Description HTML (required format)

Descriptions render in the Wana app (Flutter `HtmlText` and web `RichTextRenderer`). Use the spacing pattern below so section breaks show correctly on mobile and web.

### Allowed tags

- Wrapper: `<div>...</div>`
- Sections: `<p>`, `<strong>`, `<ul>`, `<li>`
- Spacing: `<br />` only (between sections and after section headings)
- **Do not** use: inline `style=`, `<br>` without slash if avoidable, empty `<p></p>`, `<p><span>&nbsp;</span></p>` (spacer paragraphs do not render as a blank line)

### Required sections (in order)

1. **About the Company**
2. **About the Role**
3. **Responsibilities** (bullet list)
4. **Requirements** (bullet list)
5. **Compensation** (optional — include when salary/rate is known)
6. **Location** (single line, e.g. `Remote.`)

### Spacing pattern (critical)

For **About the Company**, **About the Role**, **Compensation**, and **Location**:

1. Put the **section heading and body in one `<p>`**, with a line break after the heading:  
   `<p><strong>About the Company</strong><br />Paragraph text here.</p>`
2. Put a **blank line before the next section** using `<br />` **between** closing `</p>` and the next block:  
   `</p><br /><p><strong>About the Role</strong><br />...`

For **Responsibilities** and **Requirements**:

- Heading in its own `<p>`, then `<ul>` (not wrapped in `<p>`):  
  `</p><br /><p><strong>Responsibilities</strong></p><ul><li>...</li></ul><br />`

**Wrong (no visible blank line between sections):**

```html
<p><strong>About the Company</strong></p><p>Company text.</p><br /><p><strong>About the Role</strong></p><p>Role text.</p>
```

**Correct:**

```html
<p><strong>About the Company</strong><br />Company text.</p><br /><p><strong>About the Role</strong><br />Role text.</p><br /><p><strong>Responsibilities</strong></p><ul><li>Item</li></ul>
```

### Full template

```html
<div><p><strong>About the Company</strong><br />COMPANY_PARAGRAPH</p><br /><p><strong>About the Role</strong><br />ROLE_PARAGRAPH</p><br /><p><strong>Responsibilities</strong></p><ul><li>ITEM</li><li>ITEM</li></ul><br /><p><strong>Requirements</strong></p><ul><li>ITEM</li><li>ITEM</li></ul><br /><p><strong>Compensation</strong><br />SALARY_TEXT</p><br /><p><strong>Location</strong><br />Remote.</p></div>
```

### Rules

- **Never** wrap `<ul>` inside `<p>`.
- Use `<br />` between every major section (after each `</p>` or `</ul>` before the next heading).
- Write complete sentences in company/role paragraphs; bullets for responsibilities/requirements.
- Match facts to the source posting; do not invent salary or requirements.

### Normalize legacy HTML (Python)

```python
import re

SECTIONS = ("About the Company", "About the Role", "Compensation", "Location")

def fix_job_description_html(html: str) -> str:
    for section in SECTIONS:
        html = re.sub(
            rf"<p><strong>{re.escape(section)}</strong></p><p>(.*?)</p>",
            rf"<p><strong>{section}</strong><br />\1</p>",
            html,
            flags=re.DOTALL,
        )
    html = html.replace("</p><p><strong>", "</p><br /><p><strong>")
    html = html.replace("</ul><p><strong>", "</ul><br /><p><strong>")
    html = re.sub(r"(<br />\s*){2,}", "<br />", html)
    return html
```

---

## Upload API behavior (know this)

- Endpoint: `POST /api/v1/jobs/upload` (multipart CSV file)
- Auth: `Authorization: Bearer <accessToken>` from `POST /api/v1/auth/login`
- If a row’s apply URL already exists (`jobLink` match), the API **updates** that job and may **keep old `createdBy`** → job won’t appear under a new user’s **My Jobs**
- To fix ownership + date: **delete** existing jobs (admin token if needed), then re-upload under the target user
- Feed sort: newest `createdAt` first — set `createdAt` to **today** on re-upload (e.g. `2026-05-29T12:00:00.000Z`)

---

## Upload to DEV

1. Start API (from monorepo root):

   ```bash
   cd api-server && npm run dev
   ```

2. From monorepo root, upload with env vars + Python (see **Upload script pattern** below), or:

   Set credentials, then run the **Upload script pattern** (Python block below) with your CSV path.

   Always inject `externalApplicationLink` from `jobLink` for external-apply rows before POSTing the CSV.

3. Verify:

   - `GET /api/v1/jobs/my-jobs` with same token
   - Count rows whose `jobLink` matches CSV apply URLs
   - Check `createdAt` starts with today’s date if you set it

**Large CSVs (50+ rows):** Upload in batches of 10–20 rows; single upload may timeout after 120s.

---

## Upload to PROD

**Only when the user explicitly says PROD.**

1. Set env:

   ```powershell
   $env:WANA_CONFIRM_PROD_UPLOAD="1"
   $env:WANA_API_BASE="https://wana-api-server-prod.onrender.com"
   $env:WANA_UPLOAD_EMAIL="hello@wana.download"
   $env:WANA_UPLOAD_PASSWORD="<password>"
   ```

2. Upload CSV (same as DEV, with `externalApplicationLink` injected for external jobs).

3. Report returned `uid` per job to the user.

**Do not** upload to PROD and DEV in the same task unless the user asks for both.

---

## Re-upload / fix sort order / fix titles

When the user asks to fix titles, spacing, or “jobs not on top”:

1. Edit the CSV only (no other fields unless asked).
2. Delete existing jobs with matching `jobLink` (user token; if 403, use Firebase dev admin token to delete).
3. Re-upload with column `createdAt` set to **today** (ISO UTC), e.g. `2026-05-29T12:00:00.000Z`.
4. Inject `externalApplicationLink` from `jobLink` on upload.

---

## Upload script pattern (Python)

Run from **NEW_WEB monorepo root**. Requires a working upload helper or this pattern:

```python
import csv, io, sys
from pathlib import Path

ROOT = Path("f:/NEW_WEB")  # monorepo root
sys.path.insert(0, str(ROOT / "JobScraping" / "pipeline"))

# Prefer the enhanced module in monorepo if present; otherwise implement
# login + bulk_upload_bytes against POST /api/v1/jobs/upload

import bulk_upload_jobs as b  # when enhanced script exists in monorepo

b.API_BASE = "http://localhost:8000"  # or prod URL
b.API_V1 = f"{b.API_BASE}/api/v1"

token = b.login("errrrr77@gmail.com", "password")

# Build upload CSV with externalApplicationLink + optional createdAt
path = ROOT / "illustrator_jobs_batch3.csv"
text = path.read_text(encoding="utf-8-sig")
rows = list(csv.reader(io.StringIO(text)))
headers = rows[0]
if "externalApplicationLink" not in headers:
    headers.append("externalApplicationLink")
if "createdAt" not in headers:
    headers.append("createdAt")
job_link_idx = headers.index("jobLink")
allow_idx = headers.index("allowEmailApplications")
out = io.StringIO()
w = csv.writer(out, lineterminator="\n", quoting=csv.QUOTE_ALL)
w.writerow(headers)
for row in rows[1:]:
    if len(row) < len(headers):
        row += [""] * (len(headers) - len(row))
    email = (row[allow_idx] or "").strip().lower() == "true"
    row[headers.index("externalApplicationLink")] = "" if email else (row[job_link_idx] or "").strip()
    row[headers.index("createdAt")] = "2026-05-29T12:00:00.000Z"  # today when re-uploading
    w.writerow(row)

jobs = b.bulk_upload_bytes(out.getvalue().encode("utf-8"), path.name, token)
for j in jobs:
    print(j["uid"], j["title"], j.get("createdAt"))
```

> **Note:** `JobScraping/pipeline/bulk_upload_jobs.py` in this repo may be a minimal version. The monorepo copy at `NEW_WEB/JobScraping/pipeline/bulk_upload_jobs.py` should use `/api/v1/jobs/upload`, prod guards, and `login_firebase_dev()` for admin deletes. If missing, use the pattern above against the upload endpoint.

---

## Scrape → API workflow

1. Run pipeline: `npx tsx pipeline/run.ts` (see `README.md`).
2. Outputs land under `outputs/history/<timestamp>/`.
3. Clean/dedupe as needed → file like `job-scrape-*-cleaned.csv`.
4. Upload to DEV with `createdAt` = today if user wants fresh sort.
5. Do **not** modify scrape output schema unless user asks; map at upload time.

---

## Common mistakes

| Mistake | Result | Fix |
|---------|--------|-----|
| `city` + `state` both `Remote` | “Remote, Remote” in UI | Only `city` = `Remote` |
| Empty `<p></p>` spacers | No visible gap | Use `<br />` between sections |
| `<ul>` inside `<p>` | Broken layout | `<ul>` as sibling of `<p>` |
| External job but email flags true | Wrong apply flow | `allowEmailApplications=false`, clear emails |
| Re-upload same URL without delete | Old `createdBy`, old date | Delete then upload |
| Upload without `externalApplicationLink` | External link missing in app | Inject from `jobLink` at upload |
| Prod upload without user request | Live data changed | DEV only by default |
| Committing CSV with secrets | Security risk | Never commit passwords |

---

## Example file names (monorepo root)

| File | Contents |
|------|----------|
| `illustrator_jobs_batch2.csv` | 6 illustrator-style jobs |
| `illustrator_jobs_batch3.csv` | 6 jobs (mixed titles) |
| `illustrator_jobs_batch4.csv` | Verisma Brand Designer |
| `creative_jobs_batch.csv` | 6 graphic/video roles |
| `artist_jobs_batch.csv` | 6 open calls |
| `job-scrape-*-cleaned.csv` | Large scrape upload |

---

## What agents should report after upload

- Environment: DEV or PROD
- Count uploaded
- Table: `uid` | `title` | `company`
- Whether `createdAt` was set to today
- Whether jobs verified in **My Jobs** (DEV test user)

---

## Related docs

- Pipeline scrape stages: `../README.md`
- API job upload implementation: `../api-server/src/services/impl/JobService.ts` (`uploadJobsFromCSV`)
- Rich text allowed tags: `../web-app-new/src/lib/rich-text.ts`

---

*Last updated: 2026-05-29 — aligns with illustrator batches, scrape CSV, DEV/PROD upload practice.*
