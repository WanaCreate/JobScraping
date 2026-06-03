# ReviewerAgent

A review checklist + operating spec for vetting scraped creative job listings **before** they are posted to the Wana platform.

## Purpose

We scrape creative job listings and post them on our platform. Every listing must be scrutinized against the rules below first. The agent takes a set of listings (pasted in chat, or a CSV of links) and returns a **markdown review table** with a verdict and notes per listing.

---

## Inputs

The user provides listings one of two ways:

1. **Chat** — pasted links and/or pasted job descriptions.
2. **CSV of links** — a file of job URLs. The agent fetches/reads each link and evaluates it.

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
   npx tsx pipeline/reviewFetchOne.ts "<job-url>"
   ```

   It prints one JSON object (`{ ok, title, company, workType, location, salary, description, ... }`).
   See [JobScraping README](../README.md) (Stage 2) and the wrapper
   `pipeline/reviewFetchOne.ts`, which reuses `utils/jobDetailExtractor.ts::enrichJobFromUrl`.
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

## Review Checklist

Each listing is scored against all seven rules. A single failed hard rule is enough to **REJECT**.

| # | Rule | Verdict on failure | Notes |
|---|------|--------------------|-------|
| 1 | **No AI-first company** | REJECT | Reject any company whose **core product is building or training AI models** (foundation-model labs, AI data-labeling/RLHF firms, AI-content generators), even if the role itself is a normal creative job. Normal companies that merely *use* AI tools are fine. |
| 2 | **No unpaid roles** | REJECT | Reject explicitly unpaid, "for exposure", equity-only, or volunteer roles. |
| 3 | **No low-paying roles** | REVIEW | Judgment call — no fixed number. Flag anything clearly below market for the role/region/seniority as REVIEW with a short reason. Do **not** auto-reject on pay alone. |
| 4 | **Remote only** | REJECT | Must be **fully remote**. Reject hybrid and onsite. Region restrictions (e.g. "US-only", "EU timezone") are **allowed** as long as the role is fully remote. |
| 5 | **Quality check** | REVIEW / REJECT | Reject obvious spam, scam, MLM, vague/no real description, broken or dead links, or reposted aggregator junk. Borderline-quality → REVIEW. |
| 6 | **Niche check** | REJECT if off-niche | In-niche roles only (see list below). Off-niche → REJECT. Genuinely ambiguous → REVIEW. |
| 7 | **No duplicates** | — (see note) | Cross-check against listings already posted in the **last 1 month**. ⚠️ **Not yet automated — see Pending Tasks.** For now, flag obvious in-batch duplicates only. |

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

## Output Format

**Write the review to a markdown file**, then reply in chat with a short summary line plus
a link to the file. Do **not** put the full table only in chat — the file is the deliverable.

- **Location:** `WeeklyJobs/reviews/`
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
4. A **Notes & flags** section (resolved duplicates, source-link quirks, action items for REVIEWs).
5. The **manual duplicate-check reminder** (see Pending Tasks).
6. A **Sources** list — the URL evaluated for each row.

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
