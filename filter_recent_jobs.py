"""
One-off script: filter results_jobs_api_filtered.csv to roles posted in the last 30 days.

Usage:
  python filter_recent_jobs.py
  python filter_recent_jobs.py --days 30 --input path/to/input.csv --output path/to/output.csv
"""

import csv
import sys
from datetime import datetime, timedelta

def main():
    days = 30
    input_path = "outputs/api-ready/latest/results_jobs_api_filtered.csv"
    output_path = "outputs/api-ready/latest/results_jobs_api_filtered_30d.csv"

    args = sys.argv[1:]
    for i, arg in enumerate(args):
        if arg == "--days" and i + 1 < len(args):
            days = int(args[i + 1])
        elif arg == "--input" and i + 1 < len(args):
            input_path = args[i + 1]
        elif arg == "--output" and i + 1 < len(args):
            output_path = args[i + 1]

    cutoff = datetime.utcnow() - timedelta(days=days)
    kept = 0
    dropped = 0
    no_date = 0

    with open(input_path, encoding="utf-8", newline="") as fin, \
         open(output_path, "w", encoding="utf-8", newline="") as fout:
        reader = csv.DictReader(fin)
        writer = csv.DictWriter(fout, fieldnames=reader.fieldnames)
        writer.writeheader()
        for row in reader:
            date_str = (row.get("createdAt") or row.get("datePosted") or "").strip()[:10]
            if not date_str:
                # Keep jobs with no date (e.g. Lever, SmartRecruiters adapters don't emit it)
                writer.writerow(row)
                no_date += 1
                continue
            try:
                posted = datetime.strptime(date_str, "%Y-%m-%d")
                if posted >= cutoff:
                    writer.writerow(row)
                    kept += 1
                else:
                    dropped += 1
            except ValueError:
                writer.writerow(row)
                no_date += 1

    total = kept + dropped + no_date
    print(f"Cutoff: {cutoff.date()} (last {days} days)")
    print(f"Input:  {input_path}  ({total} rows)")
    print(f"Output: {output_path}")
    print(f"  Kept (within {days}d): {kept}")
    print(f"  Kept (no date):        {no_date}")
    print(f"  Dropped (too old):     {dropped}")

if __name__ == "__main__":
    main()
