# Job Scraper Agent — Find Latest Remote Creative Jobs

Instructions for an agent tasked with **finding the latest, correct job postings** for a **specific role** the user names (e.g. Illustrator, Graphic Designer, Video Editor, Brand Designer). Output must pass **quality checks** and exclusion rules before any CSV build or Wana upload.

**Companion docs:**

- [WANA-JOB-POSTING-AGENT-GUIDE.md](./WANA-JOB-POSTING-AGENT-GUIDE.md) — CSV format + DEV/PROD upload
- [WeeklyJobs/ReviewerAgent.md](../WeeklyJobs/ReviewerAgent.md) — **review PASS/REVIEW/REJECT** on URLs or a link CSV *before* building the posting CSV

**Repo:** `JobScraping` (this folder). **Do not** commit or push unless the user asks.

### End-to-end weekly workflow (scraper → reviewer → posting)

1. **Scraper agent (this doc)** — find roles, apply exclusions, draft rows.
2. **Reviewer agent** — run [WeeklyJobs/ReviewerAgent.md](../WeeklyJobs/ReviewerAgent.md) on the URL list; only **PASS** (and approved **REVIEW**) rows go forward.
3. **Posting agent** — build final CSV per [WANA-JOB-POSTING-AGENT-GUIDE.md](./WANA-JOB-POSTING-AGENT-GUIDE.md); store under `WeeklyJobs/<date-folder>/`; upload DEV unless user requests PROD.

---

## Agent mission

When the user gives a **target role** (and optionally count, region, or URLs):

1. Discover **current** openings (default window: **last 5–7 days** unless user says otherwise).
2. Confirm each posting is a **real job detail page** (not a careers index or aggregator spam).
3. Keep only **fully remote** roles.
4. **Exclude** AI-training companies and any role whose work is primarily AI/ML data labeling or model training.
5. **Exclude** unpaid, volunteer, and clearly underpaid roles.
6. Run the inline QC rules in this doc, then run the **Reviewer agent** checklist on every URL ([WeeklyJobs/ReviewerAgent.md](../WeeklyJobs/ReviewerAgent.md)).
7. Hand off **PASS** rows using [WANA-JOB-POSTING-AGENT-GUIDE.md](./WANA-JOB-POSTING-AGENT-GUIDE.md) for description HTML and upload (DEV unless user requests PROD).

---

## Step 1 — Understand the target role

### Parse user intent

| User says | Agent does |
|-----------|------------|
| Role name only (e.g. “Illustrator”) | Search title + description for that discipline |
| Specific title (e.g. “Pixel Artist”) | Match that title; related titles only if user allows |
| List of URLs | Scrape those URLs only; still apply all filters |
| “Last N days” | Filter by `date posted` / `createdAt` in that window |
| Batch size (e.g. 6 jobs) | Stop when N **passing** jobs are found |

### Build a role search profile

For each assignment, write a short internal profile:

- **Include titles:** synonyms and close matches (e.g. Illustrator → `Illustrator`, `Visual Artist`, `Picture Book Illustrator`, `Children's Book Illustrator` if user wants publishing).
- **Include skills/tools:** e.g. Adobe Illustrator, Procreate, Figma (if relevant).
- **Exclude titles:** roles that are not the target (e.g. for Illustrator, exclude pure `Software Engineer`, `Recruiter`, `Project Manager` unless explicitly creative-art).
- **Score priority:** prefer exact title match > creative discipline match > generic “Designer” with illustration in description.

Use `utils/creativeClassifier.ts` and `score_jobs.py` in this repo as reference for creative vs non-creative signals when running the automated pipeline.

---

## Step 2 — Where to find jobs

### Preferred sources (reliable detail pages)

| Source type | Examples | Notes |
|-------------|----------|--------|
| Company ATS | Greenhouse, Lever, Ashby, Workday, Ultipro/Dayforce, SmartRecruiters | Best for apply URL + structured data |
| Company career site | Direct `/jobs/` pages | Verify URL is **one job**, not listing |
| LinkedIn | `/jobs/view/<id>` | Good for discovery; confirm remote + salary in full text |
| Curated boards | BeBee, Himalayas, Otta (remote filter) | Verify listing links to real employer |
| Instagram / social | Reels/posts with apply link | Only if user provided URL or clear hiring post |

### Recency

- Prefer postings with **posted date within last 5 days** (user workflow default).
- If date unknown, use `createdAt` at upload time as today only for **Wana sort** — do not pretend an old job is new.
- Reject obvious reposts of closed roles (page says “no longer available”, expired req ID).

### Automated pipeline (optional)

From this repo root:

```bash
npm install
npx playwright install chromium
npx tsx pipeline/run.ts
```

Outputs under `outputs/history/<timestamp>/`. Then filter/enrich CSV **manually or with scripts** using the rules below. Stage 3 GPT enrichment must be instructed to enforce **remote-only** and **no AI-training content** in descriptions (see Step 5).

---

## Step 3 — Hard exclusions (drop immediately)

### A. AI training / data-labeling companies (blocklist)

**Do not include** jobs from companies whose primary business is AI training, data annotation, RLHF, or crowd labeling, including but not limited to:

- Scale AI, Outlier (by OpenAI), Remotasks, Surge AI, Appen, Telus International / TELUS Digital AI, Sama, Invisible, DataAnnotation, Lionbridge AI/data services, Clickworker, OneForma, iMerit, CloudFactory, Supahub (AI labeling), Mercor (AI evaluator gigs), Mindrift (AI trainer), Alignerr, etc.

If unsure: search company About page — if core product is **training data / human feedback for models**, **drop**.

### B. AI-related work in the role (description + title)

**Drop** if the primary duties are any of:

- Training or evaluating AI / LLM / chatbot models
- RLHF, “human feedback”, “preference ranking”, “prompt testing” for AI products
- Data annotation, image labeling for machine learning, “help improve our model”
- Content moderation for AI systems as the main job
- “AI Trainer”, “AI Rater”, “AI Evaluator”, “GPT”, “LLM” in the **title** unless the role is clearly traditional creative (rare — default **drop**)

**Allowed:** normal creative tools (Adobe, Figma) and phrases like “AI-assisted workflow” **only** if the job is fundamentally a design/illustration/video role, not model training. When in doubt, **drop**.

### C. Not fully remote

**Keep only** if at least one is true:

- Posting states **Remote**, **Work from home**, **Distributed**, **Anywhere**, or location is explicitly remote-global
- `workType` / location fields will be set to **Remote** for Wana (see posting guide)

**Drop** if:

- **On-site only**, **hybrid required** in office (e.g. “3 days in office”), city-specific without remote option
- “Remote” only in country restriction but requires relocation to one city for daily office

For Wana CSV: `workType` = `Remote`, `city` = `Remote`, `state` / `country` / `formattedAddress` empty (see posting guide).

### D. Unpaid or non-compensated

**Drop** if posting includes:

- Volunteer, unpaid internship, “for exposure”, “stipend only” with no cash wage
- “Competitive portfolio review” with no salary and no paid contract
- Equity-only with $0 cash compensation stated
- Contest or spec work presented as a “job” without pay

**Keep** paid internships (hourly or monthly wage stated).

### E. Low paying (minimum thresholds)

Use **USD equivalents** when salary is stated; if currency is other, convert roughly.

| Pay type | Minimum to keep (guideline) |
|----------|----------------------------|
| Hourly contract/freelance | **≥ $20/hr** (design/illustration); **≥ $25/hr** for senior/art director |
| Annual full-time | **≥ $45,000/year** (US remote creative); **≥ $55,000** for senior titles |
| Fixed project (IDR, etc.) | Must be clearly professional rate; reject micro-gig rates (e.g. pennies per task) |

**If salary is missing:**

- Keep only if company and role are reputable **and** title is senior/professional **and** user asked to include “competitive salary” postings.
- Flag internally as `salary TBD` — prefer roles that publish range.
- **Drop** obvious gig-economy piecework (pay per image at rates below professional norms).

### F. Junk / non-job URLs

Use heuristics from `utils/jobHeuristics.ts`:

- Drop careers **listing** pages, search results, “join talent network” with no role
- Drop titles: “Learn more”, “Careers”, “Home”, “Privacy”
- Require role-like title + job-detail URL pattern

---

## Step 4 — Role match (specific instruction)

For each candidate row, confirm:

1. **Title** matches target role or approved synonym from Step 1.
2. **Description** primary work is that discipline (not incidental mention).
3. **Company** is a real employer (studio, agency, brand, publisher) — not a scam or pure lead-gen board.
4. **Apply link** works and points to employer or trusted ATS.

### Title examples by common user requests

| User target | Accept (examples) | Reject (examples) |
|-------------|-------------------|-------------------|
| Illustrator | Illustrator, Picture Book Illustrator, Visual Artist (illustration) | UX Researcher, Accountant, AI Training Specialist |
| Graphic Designer | Graphic Designer, Visual Designer, Brand Designer (if graphic-heavy) | Data Entry, Customer Support |
| Video Editor | Video Editor, Video Producer (edit-heavy) | Social Media Intern (unpaid) |
| Pixel Artist | Pixel Artist, 2D Pixel Art, Sprite Artist | Game Programmer |
| Open Call / Artist | Artist open call, residency with stipend ≥ threshold | Unpaid exhibition call |

---

## Step 5 — Quality check (every job)

Run this checklist **before** adding a row to the deliverable CSV.

### QC checklist

| # | Check | Pass? |
|---|--------|-------|
| 1 | Job URL opens and shows **one** role | ☐ |
| 2 | Posted within user’s date window (or user waived) | ☐ |
| 3 | **Fully remote** confirmed in posting text | ☐ |
| 4 | **Not** AI-training company or AI-labeling work | ☐ |
| 5 | Description has **no** primary AI training/RLHF duties | ☐ |
| 6 | **Paid** — salary meets minimum or reputable TBD | ☐ |
| 7 | Title matches **target role** profile | ☐ |
| 8 | Company name + website identifiable | ☐ |
| 9 | Not duplicate of another row (same apply URL or same title+company) | ☐ |
| 10 | Description sufficient to write Wana HTML sections (company, role, duties, requirements) | ☐ |

**All 10 must pass.** If one fails, drop or fix before inclusion.

### Description prep for Wana

After QC, rewrite description per [WANA-JOB-POSTING-AGENT-GUIDE.md](./WANA-JOB-POSTING-AGENT-GUIDE.md):

- Sections: About the Company, About the Role, Responsibilities, Requirements, Compensation (if known), Location (`Remote.`)
- Use the **spacing pattern** in [WANA-JOB-POSTING-AGENT-GUIDE.md](./WANA-JOB-POSTING-AGENT-GUIDE.md): heading + body in one `<p>` with `<br />` after the heading, then `</p><br />` before the next section; never use `<p><span>&nbsp;</span></p>` for blank lines.

**Strip from final description:** AI training tasks, labeling, RLHF, “evaluate chatbot”, unpaid language.

---

## Step 6 — Deliverable format

### Per-job record (minimum fields to collect)

| Field | Requirement |
|-------|-------------|
| `title` | Exact or cleaned title from posting |
| `company` | Legal or brand name |
| `jobLink` / `externalApplicationLink` | Canonical apply URL |
| `description` | QC’d; ready for HTML conversion |
| `workType` | `Remote` |
| `city` | `Remote` (state/country empty) |
| `salaryMin` / `salaryMax` | If published |
| `jobType` | Full-time / Contract / Freelance / Internship / Open Call |
| `postedDate` | ISO date from source (for filtering) |
| `companyWebsite` | Root domain |
| `companyLogo` | Favicon URL per posting guide |

### Report to user

Provide:

1. **Count** of jobs passing QC
2. **Table:** title | company | remote | salary | posted date | apply URL
3. **Dropped summary:** brief counts by reason (AI company, not remote, unpaid, low pay, wrong role, duplicate)
4. CSV path when built
5. Upload status (DEV/PROD) only if user requested upload

---

## Step 7 — GPT / pipeline guardrails (Stage 3)

If using `stage3_enrichGpt.ts`, add or enforce in review prompts:

- `workType` must be **REMOTE** for rows you keep; clear onsite city fields unless hybrid is acceptable (it is **not** for this agent).
- Remove AI-training paragraphs from descriptions.
- Do not invent salary; leave empty if unknown.
- Titles must match creative role, not “AI Content Reviewer”.

Post-GPT pass: run the **QC checklist** again on enriched CSV.

---

## Keyword reference — quick filter (grep)

Use ripgrep or script on CSV before upload:

```bash
# Example: flag AI-training patterns (review hits manually)
rg -i "rlhf|train (the|our) (ai|model|llm)|data annotat|ai trainer|ai rater|human feedback|label images for|improve our model|outlier|scale ai|remotasks" jobs.csv

# Unpaid signals
rg -i "unpaid|volunteer|for exposure|stipend only|no compensation" jobs.csv

# Non-remote signals (review before drop)
rg -i "on-site only|onsite only|must be located in|relocation required|hybrid.{0,20}office" jobs.csv
```

---

## Search strategy template (copy for agent run)

When user says: **“Find [ROLE], remote only, last 5 days, N jobs”**:

1. List 15–20 search queries: `"[ROLE]" remote jobs`, site:greenhouse.io, site:lever.co, LinkedIn recent, etc.
2. Open each **detail** URL; never bulk-add from search result snippets alone.
3. Apply **Step 3 exclusions** → **Step 4 role match** → **Step 5 QC**.
4. Stop at N passing jobs or exhaust sources.
5. Build CSV → optional upload per posting guide.

---

## Common agent mistakes

| Mistake | Why it fails |
|---------|----------------|
| Adding LinkedIn search result URL | Not a job detail page |
| Keeping “Remote-friendly hybrid” | User asked remote only |
| Keeping Scale AI / Outlier gigs | AI training company |
| Leaving “train generative models” in description | AI work content |
| Including unpaid “internship for portfolio” | Unpaid exclusion |
| $12/hr contract illustrator | Below pay floor |
| Same job twice (Greenhouse + LinkedIn) | Duplicate |
| Old req from 2023 still open | Not “latest” |

---

## Related files in this repo

| Path | Purpose |
|------|---------|
| `pipeline/run.ts` | Full scrape pipeline |
| `pipeline/stage2_collectJobDetails.ts` | Extract fields from job URLs |
| `pipeline/stage3_enrichGpt.ts` | GPT clean/enrich |
| `utils/jobHeuristics.ts` | Valid job URL detection |
| `utils/creativeClassifier.ts` | Creative vs non-creative |
| `utils/jobDetailExtractor.ts` | Location/salary parsing |
| `docs/WANA-JOB-POSTING-AGENT-GUIDE.md` | CSV + HTML + DEV/PROD upload |

---

*Last updated: 2026-05-29 — remote-only, no AI-training, paid quality bar, role-specific discovery.*
