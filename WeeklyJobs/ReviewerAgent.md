# ReviewerAgent

> ⚠️ **Token cost warning — do not use this agent for the weekly run.**
> Running ReviewerAgent as a Claude agent consumes a large amount of tokens for a single batch (the full spec + all listing content fits poorly in one context). For now, **use the ScraperAgent output manually** — read the SCRAPED-INFO file yourself and apply the checklist below by eye. Come back to this file only for the rules reference.
>
> Future: either trim this spec significantly, or replace it with a short manual checklist that just cites the 7 rules.

---

A review checklist + operating spec for vetting scraped creative job listings **before** they are posted to the Wana platform.

**Upstream (discovery / scrape):** [Job Scraper Agent](../docs/JOB-SCRAPER-AGENT-GUIDE.md) — find remote creative roles and apply scrape-time exclusions. Field-level collection from a known URL: [ScraperAgent](./ScraperAgent.md).

**Downstream (CSV + upload):** [Wana Job Posting Agent](../docs/WANA-JOB-POSTING-AGENT-GUIDE.md) — build description HTML and upload to DEV/PROD.

**Weekly batches:** Approved posting CSVs live under `WeeklyJobs/<date-folder>/` (e.g. `WeeklyJobs/June4-2026/`).

## Purpose

We scrape creative job listings and post them on our platform. Every listing must be scrutinized against the rules below first — **after** the [Job Scraper Agent](../docs/JOB-SCRAPER-AGENT-GUIDE.md) finds candidates and **before** the [Wana Job Posting Agent](../docs/WANA-JOB-POSTING-AGENT-GUIDE.md) builds the upload CSV.

The reviewer agent takes a set of listings (pasted in chat, or a CSV of links) and returns a **markdown review table** with a verdict and notes per listing. Only **PASS** rows (and human-approved **REVIEW** rows) proceed to the posting CSV.

---

## Inputs

The user provides listings one of three ways:

1. **Chat** — pasted links and/or pasted job descriptions.
2. **CSV of links** — a file of job URLs. The agent fetches/reads each link and evaluates it.
3. **Scraped tables** (primary for weekly runs) — the completed
   `WeeklyJobs/<date>/scraped/SCRAPED-INFO-<date>.md` from the [ScraperAgent](./ScraperAgent.md)
   (Table A job postings + Table B Instagram, with gated rows already filled in from pasted
   content). Run the **[field audit](#field-audit-scraped-tables--posting-csv)** across the tables +
   their JD text, and — when a posting CSV (`WeeklyJobs/<date>/creative_jobs_*.csv`) also exists —
   diff the tables against it. **Flag only — never edit the tables or the CSV.**

For each listing the agent should try to determine: company name, role title, pay (amount + period, or "unspecified"), remote status, location/region restrictions, and the niche category.

> If a link comes back gated or JS-rendered (Ashby, Workday, Greenhouse, etc.), escalate to the
> Playwright fallback (see **Fetching listings** below) *before* giving up. Only if that also fails
> should you mark the listing **REVIEW** with note "insufficient info — manual check".

---

## Fetching listings (escalation ladder)

Most pages can be read with a plain fetch. JS-rendered ATS pages (Ashby, Workday, Greenhouse,
Lever, SmartRecruiters, iCIMS) return an empty shell to a plain fetch — the job text is loaded
client-side. For those, escalate:

1. **Tier 1 — plain fetch.** Default. Works for Paylocity, Indeed, company career pages, and
   most static listings.
2. **Tier 2 — Playwright fallback.** When Tier 1 returns empty/thin content **or** the host is a
   known JS-rendered ATS, run the existing JobScraping pipeline's single-URL extractor — do **not**
   write a new scraper. It already does HTTP→Playwright fallback for known ATS hosts and extracts
   title / description / location / salary / workType via JSON-LD + heuristics:

   ```bash
   cd ..                       # repo root: _Code/JobScraping
   npx tsx WeeklyJobs/reviewFetchOne.ts "<job-url>"
   ```

   It prints one JSON object (`{ ok, title, company, workType, jobType, location, salary, description, ... }`).
   See [JobScraping README](../README.md) (Stage 2) and the wrapper
   `WeeklyJobs/reviewFetchOne.ts`, which reuses `utils/jobDetailExtractor.ts::enrichJobFromUrl`.
3. **Tier 3 — manual.** If Playwright also returns `ok:false` or a login wall, mark **REVIEW**
   ("insufficient info — manual check"); paste the description into chat to review instead.

> ⚠️ **Read the description, not just the `workType` tag.** The extractor's `workType` is a keyword
> heuristic and can mislabel onsite/hybrid/field roles as `REMOTE` (e.g. a page that mentions
> "remote support" or sits on a "Remote-OR" URL). Always confirm Rule 4 against the actual JD text —
> phrases like "field position", "commuting distance", "on-site work", or "travel required" override
> a `REMOTE` tag and trigger a Rule 4 **REJECT**.

> **LinkedIn is excluded from Tier 2.** Never point Playwright at a LinkedIn auth wall — see below.

### LinkedIn links

LinkedIn is a primary source. **We read public job pages only — no login.**

- Provide individual public job URLs (`linkedin.com/jobs/view/<id>`). The agent fetches the
  public page and evaluates title, company, location, remote status, and description.
- **No credentials are used.** Logged-in scraping of LinkedIn violates its Terms of Service
  and risks a permanent ban on the account whose credentials are used — so we don't do it
  for this review workflow.
- If a public LinkedIn page is gated (login wall / "sign in to view") or won't load, mark the
  listing **REVIEW** with note "LinkedIn gated — paste the description manually". You can copy
  the job text straight into chat and the agent will review that instead.

> **Future / out of scope here:** bulk *discovery* (auto-harvesting many listings from LinkedIn
> search or feed) would need login and is high-risk. If we ever pursue it, use a burner account
> or an official/3rd-party job API — never the primary LinkedIn account. See Pending Tasks.

---

## Open Calls

Open calls (submissions for artist consideration, portfolio reviews, residencies, etc.) follow the same rules with one exception:

**Rule 4 (Remote only) does not apply.** Artists submit work digitally regardless of location, so there is no remote requirement.

Instead, rank by geographic openness and reflect it in the verdict + notes:

| Location scope | Verdict | Notes |
|----------------|---------|-------|
| Open to global artists | PASS | — |
| USA only | PASS | Note: "US-only open call" |
| More restrictive (single country other than USA, single city, etc.) | REVIEW | Note the restriction; human decides if it's worth posting |

All other rules (1, 2, 3, 5, 6, 7, 8) apply the same as job postings.

[] Need to add due dates check
---

## Review Checklist

Each listing is scored against all eight rules. A single failed hard rule is enough to **REJECT**.

| # | Rule | Verdict on failure | Notes |
|---|------|--------------------|-------|
| 1 | **No AI-first company** | REJECT | Reject any company whose **core product is building or training AI models** (foundation-model labs, AI data-labeling/RLHF firms, AI-content generators), even if the role itself is a normal creative job. Normal companies that merely *use* AI tools are fine. |
| 2 | **No unpaid roles** | REJECT | Reject explicitly unpaid, "for exposure", equity-only, or volunteer roles. |
| 3 | **No low-paying roles** | REVIEW | Judgment call — no fixed number. Flag anything clearly below market for the role/region/seniority as REVIEW with a short reason. Do **not** auto-reject on pay alone. |
| 4 | **Remote only** | REJECT | Must be **fully remote**. Reject hybrid and onsite. Region restrictions (e.g. "US-only", "EU timezone") are **allowed** as long as the role is fully remote. |
| 5 | **Quality check** | REVIEW / REJECT | Reject obvious spam, scam, MLM, vague/no real description, broken or dead links, or reposted aggregator junk. Borderline-quality → REVIEW. |
| 6 | **Niche check** | REJECT if off-niche | In-niche roles only (see list below). Off-niche → REJECT. Genuinely ambiguous → REVIEW. |
| 7 | **No duplicates** | — (see note) | Cross-check against listings already posted in the **last 1 month**. ⚠️ **Not yet automated — see Pending Tasks.** For now, flag obvious in-batch duplicates only. |
| 8 | **Recent posting (≤10 days)** | REJECT / REVIEW | Posted date must be within the last 10 days (cutoff = run date minus 10 days). If posted more than 10 days ago → REJECT. If posting date is not found or unspecified → REVIEW ("posting date not found — manual check"). The date must come from the fetched listing itself — do not infer from URL or ATS metadata unless the JD confirms it. |

### Niche (rule 6)

We post roles for **visual & creative** talent. Current accepted categories — *update this list as we go*:

- Illustrators
- Designers — web, UI/UX, graphic, **branding**, **content / instructional / curriculum / learning-experience design**
- Visual artists — photographers, fine artists, etc.
- Video editors

**Treat "Designer"-titled roles as in-niche by default**, as long as the work is relevant to
graphic design, UI/UX, branding, or content/instructional design. This explicitly includes
**content & curriculum design** (e.g. an "Academic Designer" or "Instructional Designer" building
lessons, learning objectives, and content to standards) — that is accepted design work, **not** an
off-niche reject.

**Excluded design types** (these are *not* our niche even though the title says "Designer") →
**REJECT** on Rule 6: **fashion design, interior design, industrial / product-hardware design**, and
similar non-creative-digital design fields.

Roles outside design/creative entirely (e.g. engineering, sales, marketing copywriting, general PM)
→ **REJECT**. If a role is plausibly creative but doesn't cleanly fit (e.g. "creative technologist",
"content creator") → **REVIEW**.

---

## Verdicts

Each listing gets one of three verdicts:

- **PASS** — clears all hard rules; safe to post.
- **REVIEW** — borderline; needs a human decision before posting (e.g. soft pay concern, ambiguous niche, thin info).
- **REJECT** — fails one or more hard rules; do not post.

---

## Field audit (scraped tables + posting CSV)

On top of the 7-rule verdict, the Reviewer audits each row's fields so wrong or stale data
doesn't reach the platform. Its inputs are, in order of authority:

1. **The completed scraped tables** — `WeeklyJobs/<date>/scraped/SCRAPED-INFO-<date>.md`
   (Table A job postings + Table B Instagram), produced by the [ScraperAgent](./ScraperAgent.md).
   This is the primary input: the ScraperAgent already did the fetching and merged in the user's
   pasted content for gated URLs, so the Reviewer **does not re-fetch** — it reasons over that
   content (and the JD text it captured).
2. **The posting CSV when one exists** — `WeeklyJobs/<date>/creative_jobs_*.csv` (from the
   [Posting Agent](../docs/WANA-JOB-POSTING-AGENT-GUIDE.md)). When present, **also diff the scraped
   tables against the CSV** so the built upload matches what was scraped.

For each row, compare the values across the sources above and mark each field:

- **MATCH** — sources agree (allow trivial formatting/case differences).
- **MISMATCH** — sources disagree on a real value.
- **MISSING** — one source has the field, another can't confirm it (`salary: null`, empty
  location, `⚠ toFetch` row, etc.).

Then **check description formatting** separately (see below). A row whose scraped status is still
`⚠ toFetch` (no fetch, no paste) → mark **REVIEW** ("insufficient info — manual check").

> Only re-fetch with `WeeklyJobs/reviewFetchOne.ts` if you need to spot-verify a suspicious row;
> normally the scraped tables already carry the fetched + pasted content.

### Fields to audit

Compare each field across the scraped table, the JD text it captured, and the CSV (if present):

| Field | What to compare | Notes |
|-------|-----------------|-------|
| `title` | scraped vs. CSV vs. JD | Allow casing / minor cleanup differences. |
| `company` | scraped vs. CSV | Scraped `company` is often mislabeled "Linkedin"/host name on aggregator fetches — the **JD/CSV name wins**. |
| `description` | Content **and** formatting | See "Description formatting" below. |
| `externalApplicationLink` / `jobLink` | scraped vs. CSV apply URL | Must resolve to the same live posting; flag dead/redirected links ("no longer accepting applications"). |
| `workType` | scraped vs. CSV, **and both vs. JD text** | The extractor's `workType` is a keyword guess — the **JD text wins**. A `REMOTE` tag on a JD that says "field position" / "commuting distance" / "on-site" is a Rule 4 problem, not just a mismatch. |
| `jobType` | scraped vs. CSV | Extractor often returns `GIG`/`FREELANCE` for full-time/contract — note it, don't assume the CSV is wrong. |
| `location` | scraped vs. CSV `city`/`state`/`country` | For remote rows confirm `city = Remote` only (not "Remote, Remote"). |
| `compensation` | scraped `salary` vs. CSV vs. JD | ⚠️ The fetch goes wrong **both ways**: it invents salary (e.g. scrapes a LinkedIn *similar-jobs* sidebar) and misses salary that's plainly in the JD. **The JD text is the arbiter** — say which source it supports. |
| `skills` | scraped/CSV `skills` vs. JD tools/disciplines | Flag clearly off-role or empty skill lists. |
| `keywords` (tags) | scraped/CSV `keywords` vs. JD terms | |

> **This audit NEVER edits the CSV or the scraped tables.** It only **flags** — the human decides
> which value wins. The fetch heuristics are demonstrably lossy *and* sometimes fabricate (null
> salary, sidebar-salary false positives, `GIG` vs `Freelance`), so auto-correcting would *degrade*
> good data. Report the diff; let a person reconcile it.

### Description formatting

Beyond content, confirm the CSV `description` follows the Wana HTML spacing pattern from the
[Posting guide](../docs/WANA-JOB-POSTING-AGENT-GUIDE.md):

- Sections in order: **About the Company → About the Role → Responsibilities → Requirements
  → Compensation (if known) → Location**.
- Heading + body in one `<p>` with `<br />` after the heading; `</p><br />` before the next
  section; `<ul>` as a **sibling** of `<p>`, never nested inside it.
- **No** empty `<p></p>` spacers, `<p><span>&nbsp;</span></p>`, inline `style=`, or tags
  outside the rich-text whitelist (`web-app-new/src/lib/rich-text.ts`).
- Flag (don't fix) any row whose description is raw/unsectioned, mojibake, or the
  `"For job details, click apply."` placeholder.

### Audit verdicts

Per row, in addition to the PASS/REVIEW/REJECT rule verdict, give a **data verdict**:

- **CLEAN** — all audited fields MATCH (or differ only trivially) and formatting is correct.
- **FLAGGED** — one or more MISMATCH / MISSING / formatting issues; list them for the human.

A FLAGGED data verdict does **not** auto-change the rule verdict, but a field audit can
*surface* a rule failure (e.g. fetch reveals the role is hybrid → Rule 4 REJECT).

---

## Output Format

**Write the review to a markdown file**, then reply in chat with a short summary line plus
a link to the file. Do **not** put the full table only in chat — the file is the deliverable.

- **Location:** `WeeklyJobs/<date-folder>/` (e.g. `WeeklyJobs/June4-2026/`) — same folder as the
  batch CSV and the `scraped/` subfolder.
- **Filename:** `review-YYYY-MM-DD.md` (the run date). If more than one batch runs the same day,
  append a suffix: `review-YYYY-MM-DD-2.md`.

The file contains a markdown table, one row per listing:

| # | Role / Company | Pay | Remote | Niche | Verdict | Notes |
|---|----------------|-----|--------|-------|---------|-------|
| 1 | Motion Designer @ Acme | $70k/yr | ✅ Fully remote | Video editor | PASS | Clears all checks. |
| 2 | 3D Artist @ ScaleAI | unspecified | ✅ | Visual artist | REJECT | Rule 1 — AI-first company. |
| 3 | Illustrator @ Studio X | "competitive" | Hybrid | Illustrator | REJECT | Rule 4 — hybrid, not fully remote. |
| 4 | Junior Designer @ Y | $12/hr | ✅ | Graphic design | REVIEW | Rule 3 — pay looks low for role; manual check. |

The file should have, in order:

1. A title with the run date.
2. The verdict table above.
3. A one-line summary: `X PASS · Y REVIEW · Z REJECT`.
4. **(When auditing a CSV)** a **Field Audit** section — one sub-table per FLAGGED row,
   listing `field | CSV value | fetched value | MATCH/MISMATCH/MISSING | note`, plus any
   description-formatting issues. CLEAN rows can be summarized in one line. The audit
   **flags only — it never edits the CSV**.
5. A **Notes & flags** section (resolved duplicates, source-link quirks, action items for REVIEWs).
6. The **manual duplicate-check reminder** (see Pending Tasks).
7. A **Sources** list — the URL evaluated for each row.

After writing it, reply in chat with: the summary line, the file path, and anything needing a
decision. Keep the chat reply short; the `.md` file is the record of the run.

---

## Pending Tasks (remind the user each run)

- [ ] **Duplicate check against last 1 month of live listings is NOT automated yet.**
      Until wired up, the agent only catches duplicates *within the current batch*.
      Future options: query the Supabase listings DB directly, or have the user export
      a CSV of the last month's listings to cross-reference.
      **➡️ At the start of every run, remind the user this check is still manual.**

- [ ] **LinkedIn bulk discovery** is out of scope for now (login-only, high ban risk).
      If pursued later: burner account or official/3rd-party job API, never the primary account.

---

## Notes / Changelog

- Niche list and pay judgment are intentionally living rules — refine here as patterns emerge.
