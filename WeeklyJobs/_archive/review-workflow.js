export const meta = {
  name: 'wana-job-review',
  description: 'Review a Wana bulk-jobs CSV against Rules 1-3, 5-6 and verify external links. Pass { csvPath, outputPath } via args.',
  phases: [
    { title: 'Parse CSV', detail: 'Read and extract rows from CSV' },
    { title: 'Rules Review', detail: 'Rule 1 (Sonnet) + Rules 2,3,5,6 (Haiku) in parallel' },
    { title: 'Link Pre-screen', detail: 'Flag dead/suspicious URLs from URL text alone (no fetch)' },
    { title: 'Link Verification', detail: 'Fetch only links that passed pre-screen' },
    { title: 'Synthesize', detail: 'Merge all verdicts into final output CSV' },
  ],
}

// ── Args ──────────────────────────────────────────────────────────────────────
// args.csvPath    (required) absolute path to input CSV
// args.outputPath (optional) absolute path for reviewed output CSV
//                 defaults to same folder as input: bulk-jobs-reviewed-YYYY-MM-DD.csv
//
// Usage from Claude:
//   Workflow({ scriptPath: 'C:\\...\\WeeklyJobs\\review-workflow.js',
//              args: { csvPath: 'C:\\...\\WeeklyJobs\\June14-2026\\bulk-jobs-upload-template.csv' } })

if (!args || !args.csvPath) {
  throw new Error('args.csvPath is required. Pass the absolute path to the input CSV.')
}

// ── Phase 1: Parse CSV ────────────────────────────────────────────────────────
phase('Parse CSV')

const PARSE_SCHEMA = {
  type: 'object',
  properties: {
    rows: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          i:         { type: 'number' },
          title:     { type: 'string' },
          company:   { type: 'string' },
          salaryMin: { type: 'number' },
          salaryMax: { type: 'number' },
          currency:  { type: 'string' },
          period:    { type: 'string' },
          workType:  { type: 'string' },
          jobType:   { type: 'string' },
          link:      { type: 'string' },
          desc:      { type: 'string' },
        },
        required: ['i','title','company','link','desc'],
      },
    },
    outputPath: { type: 'string' },
  },
  required: ['rows', 'outputPath'],
}

const parsed = await agent(
  `Read the CSV file at this path and extract every data row (skip the header).
For each row return:
  i         = row number starting at 1
  title     = the "title" column
  company   = the "company" column
  salaryMin = the "salaryMin" column as a number (0 if empty)
  salaryMax = the "salaryMax" column as a number (0 if empty)
  currency  = the "salaryCurrency" column
  period    = the "salaryPeriod" column
  workType  = the "workType" column
  jobType   = the "jobType" column
  link      = the "externalApplicationLink" column (fall back to "jobLink" if empty)
  desc      = first 400 characters of the "description" column (strip newlines to spaces)

Also return outputPath: ${args.outputPath || '(derive from csvPath: same directory, filename bulk-jobs-reviewed-<today YYYY-MM-DD>.csv)'}
csvPath = ${args.csvPath}

Use the Read tool to read the file. Parse it carefully — description fields span multiple lines and are quoted.`,
  { label: 'parse-csv', phase: 'Parse CSV', schema: PARSE_SCHEMA }
)

if (!parsed || !parsed.rows || parsed.rows.length === 0) {
  throw new Error('CSV parsing returned no rows. Check the csvPath.')
}

const rows = parsed.rows
const outputPath = parsed.outputPath
log(`Parsed ${rows.length} rows from CSV. Output will go to: ${outputPath}`)

// ── Phase 2: Rules Review (parallel) ─────────────────────────────────────────
phase('Rules Review')

const RULES_SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          i:            { type: 'number' },
          rule2_fail:   { type: 'boolean' },
          rule3_flag:   { type: 'boolean' },
          rule3_note:   { type: 'string' },
          rule5_fail:   { type: 'boolean' },
          rule5_note:   { type: 'string' },
          rule6_fail:   { type: 'boolean' },
          rule6_note:   { type: 'string' },
          rule6_review: { type: 'boolean' },
        },
        required: ['i','rule2_fail','rule3_flag','rule5_fail','rule6_fail','rule6_review'],
      },
    },
  },
  required: ['results'],
}

const AI_RULE_SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          i:          { type: 'number' },
          rule1_fail: { type: 'boolean' },
          rule1_note: { type: 'string' },
        },
        required: ['i','rule1_fail'],
      },
    },
  },
  required: ['results'],
}

const rulesPrompt = (batch) => `You are a job listing reviewer for Wana, a platform for visual & creative talent.
Review each listing against Rules 2, 3, 5, and 6 only. Return JSON.

RULES:
- Rule 2 (Unpaid): FAIL if explicitly unpaid, for exposure, equity-only, or volunteer. Internship stipends count as paid.
- Rule 3 (Low pay): FLAG (not fail) if pay is clearly below market for role/region/seniority. Use judgment.
  Examples: $12/hr US illustrator = flag; $70/hr US = fine; INR 5000/month India intern = market rate (no flag); EUR 850/month Spain junior = flag.
- Rule 5 (Quality): FAIL if spam, scam, MLM, vague/no description, or aggregator placeholder text like "For job details, click apply".
  rule5_note required if fail.
- Rule 6 (Niche): Our niche = illustrators, graphic/UI/UX/brand/web designers, content/instructional designers,
  visual artists (photographers, fine artists), video editors, animators, concept artists.
  FAIL if: fashion design (apparel/textile graphics), interior design, industrial/product-hardware design,
  DTF/print machine operator, teaching assistant, operations support, engineering, sales, marketing copywriting only.
  If ambiguous → rule6_review=true (not rule6_fail).
  "Print Designer" doing character art/florals/repeat patterns = in-niche.
  Fashion apparel graphic artist = FAIL.

Listings:
${JSON.stringify(batch.map(r => ({i:r.i, title:r.title, company:r.company, salaryMin:r.salaryMin, salaryMax:r.salaryMax, currency:r.currency, period:r.period, desc:r.desc})))}

Return results array with one entry per listing.`

const aiRule1Prompt = `You are reviewing job listings for Rule 1: No AI-first company.
REJECT if the company's CORE PRODUCT is building/training AI models: foundation-model labs,
AI data-labeling/RLHF firms, AI-content generators, AI training data companies.
Normal companies that merely USE AI tools in their workflow are fine.

Known examples:
- DataAnnotation = FAIL (core business is AI training data)
- Micro1 / micro1 = FAIL (connects experts to AI model training)
- Mindrift = FAIL (AI training data platform)
- Helsing = FAIL (defence AI company — AI is the product)
- Scale AI = FAIL (AI data labeling)
- Bending Spoons = PASS (acquires consumer apps — AI is a tool)
- Any normal brand/agency/studio that uses AI tools = PASS

For each listing determine if the company's CORE PRODUCT is AI model building/training.
Only set rule1_fail=true if clearly yes. Provide rule1_note only if FAIL.

Listings:
${JSON.stringify(rows.map(r => ({i:r.i, title:r.title, company:r.company, desc:r.desc})))}

Return results array.`

// Batch rows for Haiku (up to 30 per batch to stay within context)
const haikuBatches = []
for (let b = 0; b < rows.length; b += 30) {
  haikuBatches.push(rows.slice(b, b + 30))
}

const ruleAgents = [
  () => agent(aiRule1Prompt, { label: 'rule1-ai-sonnet', phase: 'Rules Review', schema: AI_RULE_SCHEMA }),
  ...haikuBatches.map((batch, idx) => () =>
    agent(rulesPrompt(batch), { label: `rules-haiku-b${idx+1}`, phase: 'Rules Review', schema: RULES_SCHEMA, model: 'haiku' })
  ),
]

const ruleResults = await parallel(ruleAgents)

const r1Map = {}
const rulesMap = {}
const sonnetR1 = ruleResults[0]
if (sonnetR1) {
  for (const r of sonnetR1.results) r1Map[r.i] = r
}
for (const res of ruleResults.slice(1).filter(Boolean)) {
  for (const r of res.results) rulesMap[r.i] = r
}

// ── Phase 3: Link Pre-screen (URL text only, no fetch) ────────────────────────
phase('Link Pre-screen')

// Known patterns that are suspicious/dead from URL text alone — no fetch needed.
// link_status values: 'skip_fetch' (already decided), 'needs_fetch' (must verify by fetching)
const PRESCREEN_SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          i:           { type: 'number' },
          link_status: { type: 'string', enum: ['skip_fetch', 'needs_fetch'] },
          link_ok:     { type: 'boolean' },
          link_note:   { type: 'string' },
        },
        required: ['i','link_status','link_note'],
      },
    },
  },
  required: ['results'],
}

const prescreenResult = await agent(
  `You are pre-screening job listing URLs by URL text only — do NOT fetch anything.
For each URL decide:

link_status = "skip_fetch"  → you can already determine the verdict from the URL pattern alone
  Set link_ok accordingly and write a brief link_note.

link_status = "needs_fetch" → URL looks normal; needs a real fetch to verify
  Leave link_ok unset (omit it or set null); link_note = "needs fetch"

URL patterns that mean skip_fetch:
- jooble.org/away/... → these are redirect/aggregator hashes; mark link_ok=false, note="Jooble redirect — likely dead aggregator link"
- simplyhired.com/job/... or simplyhired.es/job/... → short-lived aggregator URLs; mark link_ok=false, note="SimplyHired aggregator URL — verify manually"
  EXCEPTION: if the listing is a well-known company (MailerLite, Garabato, etc.) and the URL looks current, set needs_fetch instead
- internshala.com URLs → mark needs_fetch (we learned these can be active or suspended — must fetch to know)
- linkedin.com/jobs/view/... → needs_fetch (gating only discoverable by fetching)
- indeed.com/viewjob?jk=... → needs_fetch
- talent.com/view?id=... → needs_fetch
- mediabistro.com/jobs/... → needs_fetch
- Any direct company career page URL → needs_fetch

Listings:
${JSON.stringify(rows.map(r => ({i:r.i, title:r.title, company:r.company, link:r.link})))}

Return results array.`,
  { label: 'link-prescreen', phase: 'Link Pre-screen', schema: PRESCREEN_SCHEMA }
)

const prescreenMap = {}
if (prescreenResult) {
  for (const r of prescreenResult.results) prescreenMap[r.i] = r
}

// Separate into decided vs needs-fetch
const decidedLinks = rows.filter(r => prescreenMap[r.i] && prescreenMap[r.i].link_status === 'skip_fetch')
const fetchLinks   = rows.filter(r => !prescreenMap[r.i] || prescreenMap[r.i].link_status === 'needs_fetch')
log(`Link pre-screen: ${decidedLinks.length} decided from URL, ${fetchLinks.length} need fetching`)

// ── Phase 4: Link Verification (fetch only what needs it) ─────────────────────
phase('Link Verification')

const LINK_SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          i:         { type: 'number' },
          link_ok:   { type: 'boolean' },
          link_note: { type: 'string' },
        },
        required: ['i','link_ok','link_note'],
      },
    },
  },
  required: ['results'],
}

const linkPrompt = (batch) => `You are verifying external job listing links. For each URL:
1. Fetch it.
2. Check it loads (not 404/dead/expired).
3. Confirm page content matches the expected job title and company.

LinkedIn URLs: fetch the public page. If it shows a login wall, mark link_ok=false,
  note="LinkedIn gated — manual check". Do NOT attempt login.
Internshala URLs: if employer account is suspended, mark link_ok=false, note="Internshala account suspended".
Indeed/talent.com/mediabistro: fetch and verify content matches.

link_ok=true  → page loads AND content matches the job
link_ok=false → dead, 404, expired, wrong job, or gated (LinkedIn)
Always include a brief link_note.

Listings to fetch:
${JSON.stringify(batch.map(r => ({i:r.i, title:r.title, company:r.company, link:r.link})))}

Fetch each URL and return results.`

const linkMap = {}

// Carry over pre-screened decided links
for (const r of decidedLinks) {
  const p = prescreenMap[r.i]
  linkMap[r.i] = { link_ok: p.link_ok, link_note: p.link_note }
}

if (fetchLinks.length > 0) {
  const fetchBatches = []
  const FETCH_BATCH = 17
  for (let b = 0; b < fetchLinks.length; b += FETCH_BATCH) {
    fetchBatches.push(fetchLinks.slice(b, b + FETCH_BATCH))
  }

  const fetchResults = await parallel(fetchBatches.map((batch, idx) => () =>
    agent(linkPrompt(batch), { label: `links-sonnet-b${idx+1}`, phase: 'Link Verification', schema: LINK_SCHEMA })
  ))

  for (const res of fetchResults.filter(Boolean)) {
    for (const r of res.results) linkMap[r.i] = r
  }
}

// ── Phase 5: Synthesize ───────────────────────────────────────────────────────
phase('Synthesize')

const SYNTH_SCHEMA = {
  type: 'object',
  properties: {
    rows: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          i:             { type: 'number' },
          review_status: { type: 'string', enum: ['PASS', 'REVIEW', 'REJECT'] },
          review_notes:  { type: 'string' },
        },
        required: ['i','review_status','review_notes'],
      },
    },
  },
  required: ['rows'],
}

const combined = rows.map(r => ({
  i:        r.i,
  title:    r.title,
  company:  r.company,
  rule1:    r1Map[r.i]    || {},
  rules2356: rulesMap[r.i] || {},
  link:     linkMap[r.i]  || {},
}))

const synthResult = await agent(
  `Synthesize job listing review results into final verdicts.

Logic:
- REJECT if any of: rule1_fail, rule2_fail, rule5_fail, rule6_fail, OR link_ok=false (dead/expired link)
- REVIEW if any of: rule3_flag, rule6_review, OR LinkedIn gated (link_ok=false AND note contains "gated")
  NOTE: LinkedIn gated = REVIEW (not REJECT) — the job likely exists, just needs manual verification
- PASS if all clear

If multiple failures, cite the primary reason first. Keep review_notes to 1-2 sentences max.

Data:
${JSON.stringify(combined)}

Return rows array with one entry per listing.`,
  { label: 'synthesize', phase: 'Synthesize', schema: SYNTH_SCHEMA }
)

if (!synthResult) throw new Error('Synthesis agent returned no result.')

// Write output CSV
const writeResult = await agent(
  `Write the reviewed CSV file.

Read the original CSV at: ${args.csvPath}
Append two columns to EVERY row (including the header): review_status, review_notes

Header addition: add ,review_status,review_notes at the end of the header line.
Data rows: append the corresponding verdict for each row (matched by row order, 1-indexed).

Verdicts (i = row number, 1-indexed, matching data rows in order):
${JSON.stringify(synthResult.rows)}

Write the result to: ${outputPath}

Important: preserve the original CSV exactly (multi-line quoted description fields etc.) — only append the two new columns.
Use the Write tool. Return "done" when complete.`,
  { label: 'write-csv', phase: 'Synthesize' }
)

// Summary counts
const counts = { PASS: 0, REVIEW: 0, REJECT: 0 }
for (const r of synthResult.rows) counts[r.review_status] = (counts[r.review_status] || 0) + 1

log(`Done — ${counts.PASS} PASS · ${counts.REVIEW} REVIEW · ${counts.REJECT} REJECT`)
log(`Output: ${outputPath}`)

return {
  outputPath,
  summary: counts,
  verdicts: synthResult.rows,
}
