export const meta = {
  name: 'wana-csv-content-review',
  description: 'Cross-check a weekly jobs CSV against the MD review file. Verifies field accuracy; fetches live page for rows not in MD. Outputs reviewed CSV with Status + Notes columns. Pass { csvPath, mdPath, outputPath } via args.',
  phases: [
    { title: 'Parse', detail: 'Read CSV rows and MD source table' },
    { title: 'Match', detail: 'Join CSV rows to MD entries by jobLink' },
    { title: 'Verify MD rows', detail: 'Check CSV fields against MD-captured data' },
    { title: 'Fetch new rows', detail: 'Web-fetch rows not in MD and verify fields' },
    { title: 'Synthesize', detail: 'Merge verdicts and write reviewed CSV' },
  ],
}

// ── Args ──────────────────────────────────────────────────────────────────────
// args.csvPath    (required) absolute path to input CSV
// args.mdPath     (required) absolute path to the weekly MD review file
// args.outputPath (optional) defaults to same folder as CSV: <name>-reviewed.csv
//
// Usage:
//   Workflow({ scriptPath: 'C:\\...\\WeeklyJobs\\csv-review-workflow.js',
//              args: { csvPath:  'C:\\...\\June17-2026\\17-June-2026-jobs.csv',
//                      mdPath:   'C:\\...\\June17-2026\\review-2026-06-17.md' } })

// Fallback to hardcoded paths if args not passed via scriptPath invocation
const csvPath  = (args && args.csvPath)    || 'C:\\Users\\vyash\\Desktop\\Business\\Wana\\_Code\\JobScraping\\WeeklyJobs\\June17-2026\\17-June-2026-jobs.csv'
const mdPath   = (args && args.mdPath)     || 'C:\\Users\\vyash\\Desktop\\Business\\Wana\\_Code\\JobScraping\\WeeklyJobs\\June17-2026\\review-2026-06-17.md'
const outPath  = (args && args.outputPath) || null

if (!csvPath) throw new Error('csvPath is required.')
if (!mdPath)  throw new Error('mdPath is required.')

// ── Phase 1: Parse ────────────────────────────────────────────────────────────
phase('Parse')

const PARSE_SCHEMA = {
  type: 'object',
  properties: {
    rows: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          i:           { type: 'number' },
          title:       { type: 'string' },
          company:     { type: 'string' },
          jobType:     { type: 'string' },
          workType:    { type: 'string' },
          salaryMin:   { type: 'number' },
          salaryMax:   { type: 'number' },
          currency:    { type: 'string' },
          period:      { type: 'string' },
          city:        { type: 'string' },
          state:       { type: 'string' },
          country:     { type: 'string' },
          jobLink:     { type: 'string' },
          description: { type: 'string' },
        },
        required: ['i', 'title', 'company', 'jobLink', 'description'],
      },
    },
    outputPath: { type: 'string' },
  },
  required: ['rows', 'outputPath'],
}

const MD_SCHEMA = {
  type: 'object',
  properties: {
    entries: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          mdRow:    { type: 'number' },
          url:      { type: 'string' },
          title:    { type: 'string' },
          company:  { type: 'string' },
          pay:      { type: 'string' },
          remote:   { type: 'string' },
          niche:    { type: 'string' },
          verdict:  { type: 'string' },
          notes:    { type: 'string' },
        },
        required: ['mdRow', 'url', 'title', 'company', 'verdict'],
      },
    },
  },
  required: ['entries'],
}

const [parsed, mdParsed] = await parallel([
  () => agent(
    `Read the CSV file at: ${csvPath}

Extract every data row (skip header). For each row return:
  i           = row number starting at 1
  title       = "title" column
  company     = "company" column
  jobType     = "jobType" column
  workType    = "workType" column
  salaryMin   = "salaryMin" as number (0 if empty)
  salaryMax   = "salaryMax" as number (0 if empty)
  currency    = "salaryCurrency" column
  period      = "salaryPeriod" column
  city        = "city" column
  state       = "state" column
  country     = "country" column
  jobLink     = "jobLink" column (the external job/listing URL)
  description = full "description" column content (preserve HTML)

Also return outputPath = ${outPath || '(same directory as csvPath, filename = 17-June-2026-jobs-reviewed.csv, full path: C:\\Users\\vyash\\Desktop\\Business\\Wana\\_Code\\JobScraping\\WeeklyJobs\\June17-2026\\17-June-2026-jobs-reviewed.csv)'}

Use the Read tool. Description fields are multi-line quoted — parse carefully.`,
    { label: 'parse-csv', phase: 'Parse', schema: PARSE_SCHEMA }
  ),
  () => agent(
    `Read the markdown file at: ${mdPath}

Extract two things:

1. The Sources table at the bottom — it has columns "# | URL". Extract every row as:
   mdRow = the # number
   url   = the URL

2. The review table(s) in the body — each row has columns like:
   # | Role / Company | Pay | Remote | Niche | Verdict | Notes
   (Open calls may use slightly different column names but same structure.)
   Extract each row as:
   mdRow   = the # number
   title   = role name (left of " @ " in "Role / Company")
   company = company name (right of " @ ")
   pay     = pay/prize column value
   remote  = remote column value
   niche   = niche column value
   verdict = verdict column value (PASS / REVIEW / REJECT)
   notes   = notes column value

Merge by mdRow so each entry has: mdRow, url, title, company, pay, remote, niche, verdict, notes.

Use the Read tool.`,
    { label: 'parse-md', phase: 'Parse', schema: MD_SCHEMA }
  ),
])

if (!parsed || !parsed.rows || parsed.rows.length === 0)
  throw new Error('CSV parsing returned no rows.')
if (!mdParsed || !mdParsed.entries || mdParsed.entries.length === 0)
  throw new Error('MD parsing returned no entries.')

const rows       = parsed.rows
const outputPath = parsed.outputPath
const mdEntries  = mdParsed.entries

log(`CSV: ${rows.length} rows. MD: ${mdEntries.length} entries. Output: ${outputPath}`)

// ── Phase 2: Match ─────────────────────────────────────────────────────────
phase('Match')

// Build URL→mdEntry map for fast lookup
const MATCH_SCHEMA = {
  type: 'object',
  properties: {
    matches: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          i:       { type: 'number' },
          mdRow:   { type: 'number' },
          matched: { type: 'boolean' },
        },
        required: ['i', 'matched'],
      },
    },
  },
  required: ['matches'],
}

const matchResult = await agent(
  `Match CSV rows to MD entries by URL.

CSV rows (i = row index, jobLink = the URL):
${JSON.stringify(rows.map(r => ({ i: r.i, title: r.title, company: r.company, jobLink: r.jobLink })))}

MD entries (mdRow = MD row number, url = the URL):
${JSON.stringify(mdEntries.map(e => ({ mdRow: e.mdRow, url: e.url, title: e.title, company: e.company })))}

For each CSV row, find the MD entry whose url EXACTLY matches the CSV row's jobLink.
Allow minor differences: trailing slash, http vs https, www vs no-www.

Return matches array: one entry per CSV row with:
  i       = CSV row i
  mdRow   = matched MD row number (omit or set null if no match)
  matched = true if a match was found, false otherwise`,
  { label: 'match-rows', phase: 'Match', schema: MATCH_SCHEMA }
)

const matchMap = {}
for (const m of (matchResult?.matches || [])) {
  matchMap[m.i] = m
}

const mdRowsInCSV = rows.filter(r => matchMap[r.i] && matchMap[r.i].matched)
const newRows     = rows.filter(r => !matchMap[r.i] || !matchMap[r.i].matched)

// Build mdRow# → mdEntry lookup
const mdByRow = {}
for (const e of mdEntries) mdByRow[e.mdRow] = e

log(`Matched ${mdRowsInCSV.length} rows to MD entries. ${newRows.length} rows need web fetch.`)

// ── Phase 3: Verify MD rows ────────────────────────────────────────────────
phase('Verify MD rows')

const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          i:      { type: 'number' },
          status: { type: 'string', enum: ['PASS', 'REVIEW'] },
          notes:  { type: 'string' },
        },
        required: ['i', 'status', 'notes'],
      },
    },
  },
  required: ['results'],
}

const verifyMdResults = mdRowsInCSV.length > 0
  ? await agent(
    `You are verifying that CSV job listing data matches what was captured in the weekly MD review file.

For each listing, compare the CSV fields against the MD-captured values. Check:
1. **Title** — does the CSV title match the MD role title? (allow minor cleanup diffs like capitalisation)
2. **Company** — does the CSV company match the MD company?
3. **Pay / Salary** — does the CSV salaryMin/salaryMax/currency/period match the MD pay description? Flag real mismatches; "unspecified" in MD vs empty CSV is fine.
4. **Remote / workType** — does the CSV workType (Remote/Hybrid/On-site) match the MD remote column?
5. **Description** — does the HTML description content match the same company and role described in the MD notes? Flag if the description seems to be for a different job entirely, contains placeholder text ("For job details, click apply"), or is clearly wrong.

Verdict:
- PASS — all fields check out (minor formatting diffs are fine)
- REVIEW — one or more real mismatches; explain each in notes (keep to 1-2 sentences)

Listings to verify:
${JSON.stringify(mdRowsInCSV.map(r => {
  const md = mdByRow[matchMap[r.i].mdRow] || {}
  return {
    i:          r.i,
    csv_title:  r.title,
    csv_company: r.company,
    csv_salaryMin: r.salaryMin,
    csv_salaryMax: r.salaryMax,
    csv_currency:  r.currency,
    csv_period:    r.period,
    csv_workType:  r.workType,
    csv_description_snippet: r.description.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 500),
    md_title:   md.title,
    md_company: md.company,
    md_pay:     md.pay,
    md_remote:  md.remote,
    md_verdict: md.verdict,
    md_notes:   md.notes,
  }
}))}

Return results array with one entry per listing.`,
    { label: 'verify-md-rows', phase: 'Verify MD rows', schema: VERIFY_SCHEMA }
  )
  : { results: [] }

const mdVerifyMap = {}
for (const r of (verifyMdResults?.results || [])) mdVerifyMap[r.i] = r

// ── Phase 4: Fetch new rows ────────────────────────────────────────────────
phase('Fetch new rows')

const FETCH_VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          i:      { type: 'number' },
          status: { type: 'string', enum: ['PASS', 'REVIEW'] },
          notes:  { type: 'string' },
        },
        required: ['i', 'status', 'notes'],
      },
    },
  },
  required: ['results'],
}

const fetchPrompt = (batch) =>
  `You are verifying job listings that were NOT in the weekly MD review file.
For each listing: fetch the URL, then compare the live page content against the CSV data.

Check:
1. **Title** — does the live page title match the CSV title?
2. **Company** — does the live page company match the CSV company?
3. **Pay / Salary** — does the live page salary/rate/compensation match the CSV salaryMin/salaryMax?
4. **Remote status** — does the live page confirm the role/call is remote/on-site matching the CSV workType?
5. **Description accuracy** — does the CSV description HTML accurately represent the live job/call content? Flag if it's for a different job, missing major details, or contains placeholder text.

If the page returns a login wall (e.g. LinkedIn) or 404/error: mark REVIEW with note "page gated or unreachable — manual check".

Verdict:
- PASS — live page confirms all fields match the CSV data
- REVIEW — mismatch found or page could not be verified; explain in notes

Listings:
${JSON.stringify(batch.map(r => ({
  i: r.i,
  title: r.title,
  company: r.company,
  salaryMin: r.salaryMin,
  salaryMax: r.salaryMax,
  currency: r.currency,
  period: r.period,
  workType: r.workType,
  jobLink: r.jobLink,
  description_snippet: r.description.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 500),
})))}

Fetch each URL and return results.`

const fetchVerifyMap = {}

if (newRows.length > 0) {
  const BATCH_SIZE = 10
  const batches = []
  for (let b = 0; b < newRows.length; b += BATCH_SIZE) {
    batches.push(newRows.slice(b, b + BATCH_SIZE))
  }

  const fetchResults = await parallel(
    batches.map((batch, idx) => () =>
      agent(fetchPrompt(batch), {
        label: `fetch-verify-b${idx + 1}`,
        phase: 'Fetch new rows',
        schema: FETCH_VERIFY_SCHEMA,
      })
    )
  )

  for (const res of fetchResults.filter(Boolean)) {
    for (const r of res.results) fetchVerifyMap[r.i] = r
  }
}

// ── Phase 5: Synthesize ────────────────────────────────────────────────────
phase('Synthesize')

// Merge all verdicts
const allVerdicts = rows.map(r => {
  const verdict = mdVerifyMap[r.i] || fetchVerifyMap[r.i]
  if (verdict) return { i: r.i, status: verdict.status, notes: verdict.notes }
  // Fallback: no result from either agent
  return { i: r.i, status: 'REVIEW', notes: 'Verification agent returned no result — manual check required.' }
})

const counts = { PASS: 0, REVIEW: 0 }
for (const v of allVerdicts) counts[v.status] = (counts[v.status] || 0) + 1

const writeResult = await agent(
  `Append two columns to a CSV file and write the result.

Read the original CSV at: ${csvPath}
Add two columns to EVERY row (including the header):
  - Header: append ,Status,Notes at the end of the header line
  - Data rows: append the corresponding Status and Notes values (matched by row order, 1-indexed)

Escape Notes values: if the notes string contains commas or double-quotes, wrap in double-quotes and escape inner quotes as "".

Verdicts (i = row number, 1-indexed):
${JSON.stringify(allVerdicts)}

Write the result to: ${outputPath}

Preserve the original CSV exactly — only append the two new columns. Use the Write tool.`,
  { label: 'write-reviewed-csv', phase: 'Synthesize' }
)

log(`Done — ${counts.PASS} PASS · ${counts.REVIEW} REVIEW`)
log(`Output: ${outputPath}`)

return {
  outputPath,
  summary: counts,
  verdicts: allVerdicts,
}
