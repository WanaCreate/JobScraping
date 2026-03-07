# API-Ready Output Folder

Use this folder for API ingestion.

## Latest (API consumes this)

- `latest/results_jobs_api.json`: primary JSON payload input for API create/bulk pipeline
- `latest/results_jobs_api.csv`: CSV bulk-upload file
- `latest/results_jobs_enriched.json`: enriched intermediate records
- `latest/results_jobs_quality_report.json`: extraction quality metrics
- `latest/manifest.json`: run metadata + counts

## History (weekly snapshots)

- `history/<YYYY-Www>/<runTag>/...`
- Example: `history/2026-W10/2026-03-02_140606Z/`

## Optional Runtime Flags (collectJobDetails)

- `--runTag <tag>`: custom run snapshot label
- `--noHistory`: skip history snapshot for one run
- `--latestDir <path>`: override latest output base directory
- `--historyDir <path>`: override history output base directory
- `--output <path>`: override enriched JSON output path
- `--apiOutput <path>`: override API JSON output path
- `--csvOutput <path>`: override API CSV output path
- `--reportOutput <path>`: override report output path

Defaults are set in `pipeline/collectJobDetails.ts`.
