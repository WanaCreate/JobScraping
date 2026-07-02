"""
Drop jobs whose description was never properly cleaned by Stage 3 (Haiku).

A valid Stage-3 description is single-line HTML built from <p>/<strong>/<ul>/
<li>/<em>. Rows that bypassed enrichment keep raw scraped page content — CSS,
JavaScript, nav menus, footers, demo/test boards, or mojibake-only text — none
of which carry that structure. We detect "improper" purely by the ABSENCE of
that HTML, then label each dropped row with a specific reason for auditing.

Outputs (next to the input):
  <input>_cleaned.csv   kept rows (same columns as input)
  <input>_dropped.csv   dropped rows + a leading `drop_reason` column

Usage:
  python scripts/drop_improper_descriptions.py <input.csv>
  python scripts/drop_improper_descriptions.py <input.csv> --out-clean <p> --out-dropped <p>
"""
import csv
import os
import re
import sys

csv.field_size_limit(10 ** 9)

# Structural tags Stage 3 always emits for a real description.
HAIKU_HTML = re.compile(r"<(p|ul|ol|li|strong|em)\b", re.I)

# Specific reasons for the audit trail. First match wins; order matters.
# These only ever apply to rows that already lack HAIKU_HTML.
REASON_PATTERNS = [
    ("demo/fictional listing", re.compile(r"Demo Job Listing for Lever|fictional job|\bheadliest\b", re.I)),
    ("test board placeholder", re.compile(r"\bTEST BOARD\b", re.I)),
    ("raw CSS leaked",         re.compile(r"\{\s*(display|position|font-size|background-color|margin|padding|color)\s*:", re.I)),
    ("raw JS leaked",          re.compile(r"document\.(addEventListener|getElementById|querySelector)|function\s*\(|var\s+\w+\s*=", re.I)),
    ("nav/careers boilerplate", re.compile(r"About us\s+About us|Leadership team\s+Board|All departments\s*All locations|Experience level\s*Junior", re.I)),
    ("scrape fragment",        re.compile(r"^(for this job|apply for this job)", re.I)),
    ("fallback placeholder (no description)", re.compile(r"^for more details, click apply$", re.I)),
]


def drop_reason(description):
    """Return a reason string if the description is improper, else None."""
    d = description.strip()
    if HAIKU_HTML.search(d):
        return None  # properly formatted — keep
    for reason, rx in REASON_PATTERNS:
        if rx.search(d):
            return reason
    return "raw scrape / no formatting"  # no HTML and no specific marker


def get_arg(args, flag):
    if flag in args:
        i = args.index(flag)
        return args[i + 1], args[:i] + args[i + 2:]
    return None, args


def main():
    args = sys.argv[1:]
    out_clean, args = get_arg(args, "--out-clean")
    out_dropped, args = get_arg(args, "--out-dropped")
    if not args:
        sys.exit("Usage: python drop_improper_descriptions.py <input.csv> [--out-clean P] [--out-dropped P]")

    inp = os.path.abspath(args[0])
    if not os.path.isfile(inp):
        sys.exit(f"Input not found: {inp}")

    base, ext = os.path.splitext(inp)
    out_clean = out_clean or f"{base}_cleaned{ext}"
    out_dropped = out_dropped or f"{base}_dropped{ext}"

    with open(inp, encoding="utf-8", newline="") as f:
        reader = csv.reader(f)
        header = next(reader)
        rows = list(reader)

    di = header.index("description")
    ti = header.index("title") if "title" in header else 0

    kept, dropped = [], []
    reason_counts = {}
    for r in rows:
        if di >= len(r):
            continue
        reason = drop_reason(r[di])
        if reason is None:
            kept.append(r)
        else:
            dropped.append((reason, r))
            reason_counts[reason] = reason_counts.get(reason, 0) + 1

    with open(out_clean, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(header)
        w.writerows(kept)

    with open(out_dropped, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(["drop_reason", *header])
        for reason, r in dropped:
            w.writerow([reason, *r])

    print(f"Input:   {inp}  ({len(rows)} rows)")
    print(f"Kept:    {len(kept)}")
    print(f"Dropped: {len(dropped)}")
    print("\nDrop reasons:")
    for reason in sorted(reason_counts, key=lambda k: -reason_counts[k]):
        print(f"  {reason_counts[reason]:4}  {reason}")
    print(f"\nWrote:\n  {out_clean}\n  {out_dropped}")


if __name__ == "__main__":
    main()
