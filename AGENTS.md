# JobScraping Agent Runbook

## Default Output Contract
The `collectJobDetails` pipeline writes by default to:

- `outputs/api-ready/latest/results_jobs_api.json`
- `outputs/api-ready/latest/results_jobs_api.csv`
- `outputs/api-ready/latest/results_jobs_enriched.json`
- `outputs/api-ready/latest/results_jobs_quality_report.json`
- `outputs/api-ready/latest/manifest.json`

Each run also writes a snapshot to:

- `outputs/api-ready/history/<YYYY-Www>/<runTag>/...`

This keeps `latest` stable for downstream API ingestion and preserves weekly run history.

## Primary Command

```bash
npx tsx pipeline/collectJobDetails.ts --input results_150_optimized.json --concurrency 12 --hiringTeamUid system-scraper
```

## Optional Flags

- `--runTag <tag>`: custom run identifier for history snapshot folder.
- `--noHistory`: disable history snapshot write for one run.
- `--latestDir <path>`: override latest output base directory.
- `--historyDir <path>`: override history base directory.
- `--output <path>`: override enriched JSON output path.
- `--apiOutput <path>`: override API JSON output path.
- `--csvOutput <path>`: override API CSV output path.
- `--reportOutput <path>`: override report output path.
- `--maxJobs <n>`: run on subset for smoke tests.
- `--minCreativeScore <n>`: adjust post-fetch creative gate strictness.

## Recommended Agent Behavior

1. Use defaults unless there is a clear reason to override paths.
2. Keep `latest` as the source for API ingestion.
3. Use history snapshots for audits and rollback.
4. For test runs, prefer `--maxJobs` and set a descriptive `--runTag`.
