# Task 0 — Preference Aggregator Plan

_Goal: extract user job preferences from Firestore → write a weighted `creativeScore.json` the scraper reads._

---

## Data source (confirmed)

- **DB:** Firebase Firestore (not Supabase)
- **Collection:** `users`
- **Fields that matter:**
  - `jobPreferences.professions: string[]` — e.g. `["Illustrator", "Motion Designer"]` → **primary signal**
  - `jobPreferences.keywords: string[]` — free-form → **secondary signal**
  - `professions: string[]` (top-level, back-compat) → **merge with the above** (schema comment in `api-server/src/domain/jobPreferences.ts:21-24` says readers should merge both)
- **Shape:** discrete tags, NOT free text → aggregation is a simple frequency count, no NLP needed.

---

## Where the script lives

`api-server/scripts/aggregateCreativeScore.ts` — **reuse, don't rebuild.**

Why here, not JobScraping:
- Firestore is already wired (`api-server/src/config/firebase.ts` → `firestoreDb`, reads `.env`)
- `JobPreferences` type already defined (`src/domain/jobPreferences.ts`)
- 20+ existing `backfill*.ts` scripts in `scripts/` are the exact pattern to copy
- JobScraping has no Firebase credentials; api-server does

Output path: write to `JobScraping/pipeline/creativeScore.json` (relative path from script).

---

## Token / cost optimization (the important part)

The only expensive operation is the Firestore read. Optimize it:

1. **Field projection** — use `.select("jobPreferences", "professions")` so Firestore returns only those two fields per doc, not the full (large) user object. This is the single biggest cost lever.
2. **Stream, don't buffer** — iterate with `.stream()` and accumulate into an in-memory `Map<string, number>` counter. Never hold all docs at once.
3. **Single pass** — one read of the collection, one write of the JSON. No per-job or per-user roundtrips.
4. **Filter early** — skip docs where `jobPreferences` is null/empty (the "active user" definition from the spec: preferences filled).

No batching gymnastics needed — `.select().stream()` over the users collection is one cheap sweep.

---

## Aggregation logic

```
counter = Map<normalizedTag, userCount>
totalActiveUsers = 0

for each user doc (streamed, projected):
  tags = unique( jobPreferences.professions
               + jobPreferences.keywords
               + top-level professions )         // merge + dedup per user
  if tags is empty: continue
  totalActiveUsers++
  for tag in tags:
    counter[normalize(tag)]++                     // normalize = lowercase, trim

# weight with floor + smoothing (from JobsDrop2.0.md Task 0 dev notes)
for tag, n in counter:
  if n < 5: drop                                  # min-N floor, kills noise
  weight = log(1 + n) / log(1 + totalActiveUsers) * 10   # log smoothing, 0–10
```

Output `creativeScore.json`:

```json
{
  "generatedAt": "2026-06-18T...",
  "totalActiveUsers": 1234,
  "weights": {
    "illustrator": 8.4,
    "motion designer": 7.9,
    "graphic designer": 5.8
  }
}
```

`weights`-under-a-key (not flat) so we can add metadata without breaking the reader.

---

## Safeguards (cheap, from spec)

- **Cold-start fallback:** commit a default `creativeScore.json` so the scraper never fails if the weekly run is skipped.
- **Sanity gate before overwrite:** reject the new file if `totalActiveUsers` or tag count drops >50% vs. the existing file (logs rejection, keeps last good file). ~10 lines.

---

## Steps

1. Copy a `backfill*.ts` script skeleton → `api-server/scripts/aggregateCreativeScore.ts`
2. Query `users` with `.select("jobPreferences", "professions").stream()`
3. Aggregate per logic above (floor=5, log smoothing)
4. Sanity-gate, then write `../JobScraping/pipeline/creativeScore.json`
5. Commit a default `creativeScore.json` for cold-start
6. Run once manually, eyeball the weights, tune the floor

**Run:** `cd api-server && npx tsx scripts/aggregateCreativeScore.ts`

Out of scope for v1: cron automation, negative signals, `creativeClassifier.ts` rewrite (that's the next sub-task once the JSON exists).
