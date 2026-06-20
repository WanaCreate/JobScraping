"""
enrich_logos.py — Enrich a job CSV with company logos via Google Favicon API (256px).

TEMPORARY SCRIPT: Delete this file after the logo extraction logic is integrated
into the pipeline as stage4_enrichLogos.ts. See pipeline/run.ts for the pipeline.

Usage:
    python enrich_logos.py
    python enrich_logos.py --input path/to/input.csv --output path/to/output.csv

Defaults:
    --input:  outputs/api-ready/results_cleaned_final.csv
    --output: outputs/api-ready/results_with_logos.csv
    --cache:  ./logo_cache.json

NOTE: To point this at the pipeline output instead, change the default INPUT_CSV
      below to: outputs/api-ready/latest/results_enriched_api_gpt.csv
"""

import argparse
import csv
import json
import os
import re
import sys
import time
from urllib.parse import urlparse
from pathlib import Path

import requests

SCRIPT_DIR = Path(__file__).parent.resolve()
CACHE_FILE = SCRIPT_DIR / "logo_cache.json"

INPUT_CSV = str(SCRIPT_DIR / "outputs" / "api-ready" / "results_cleaned_final.csv")
OUTPUT_CSV = str(SCRIPT_DIR / "outputs" / "api-ready" / "results_with_logos.csv")

FAVICON_URL = "https://www.google.com/s2/favicons?domain={domain}&sz=256"

# Minimum image size in bytes to consider valid (filters out default/placeholder icons)
MIN_LOGO_BYTES = 100

# Domains that are job boards / ATS, not actual company sites
JOB_BOARD_DOMAINS = {
    "amazon.jobs", "jobs.lever.co", "boards.greenhouse.io",
    "jobs.smartrecruiters.com", "jobs.ashbyhq.com", "apply.workable.com",
    "myworkdayjobs.com", "icims.com", "jobvite.com", "ultipro.com",
    "schooljobs.com", "paycomonline.net", "wd1.myworkdaysite.com",
    "wd5.myworkdaysite.com",
}

# Manual domain overrides for tricky company names
DOMAIN_OVERRIDES = {
    "nike retail services": "nike.com",
    "new balance athletic shoes (uk) limited": "newbalance.com",
    "new balance athletics, inc.": "newbalance.com",
    "us063 oliver wyman, llc": "oliverwyman.com",
    "shutterstock (uk) ltd": "shutterstock.com",
    "shutterstock, inc.": "shutterstock.com",
    "razorpaysoftwareprivatelimited": "razorpay.com",
    "financialtimes33": "ft.com",
    "zyngacareers": "zynga.com",
    "pininfarina spa": "pininfarina.com",
    "mid sussex district council": "midsussex.gov.uk",
    "taketwo": "take2games.com",
    "voxmedia": "voxmedia.com",
    "insomniac": "insomniac.games",
    "spe": "sonypictures.com",
    "dept": "deptagency.com",
    "brucemaudesign": "brucemaudesign.com",
    "apple tree": "appletree.agency",
    "lucia gonz\u00e1lez": "",  # skip — person name, not a company
    "northwest missouri state university": "nwmissouri.edu",
    "contrast ux": "contrastux.com",
    "fort robotics": "fortrobotics.com",
    "mrm": "mrm.com",
}


def load_cache() -> dict:
    if CACHE_FILE.exists():
        with open(CACHE_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    return {}


def save_cache(cache: dict):
    with open(CACHE_FILE, "w", encoding="utf-8") as f:
        json.dump(cache, f, indent=2, ensure_ascii=False)


def extract_domain_from_url(url: str) -> str:
    """Extract a clean root domain from a URL."""
    if not url:
        return ""
    try:
        parsed = urlparse(url if "://" in url else f"http://{url}")
        host = parsed.hostname or ""
        if host.startswith("www."):
            host = host[4:]
        return host.lower()
    except Exception:
        return ""


def is_job_board_domain(domain: str) -> bool:
    """Check if domain is a known job board / ATS."""
    for jb in JOB_BOARD_DOMAINS:
        if domain == jb or domain.endswith("." + jb):
            return True
    return False


def guess_domain_from_name(company_name: str) -> list:
    """Guess possible domains from company name."""
    name_lower = company_name.lower().strip()

    # Check manual overrides first
    if name_lower in DOMAIN_OVERRIDES:
        override = DOMAIN_OVERRIDES[name_lower]
        return [override] if override else []

    # Clean the name: strip common suffixes
    cleaned = re.sub(
        r'\s*(inc\.?|llc|ltd\.?|limited|corp\.?|corporation|gmbh|pvt\.?|private|'
        r'software|services|athletics|retail|uk|spa)\s*$',
        '', name_lower, flags=re.IGNORECASE
    ).strip().rstrip(",").strip()

    # Remove special chars, collapse spaces
    cleaned = re.sub(r'[^a-z0-9\s]', '', cleaned).strip()
    cleaned = re.sub(r'\s+', '', cleaned)  # smash together for domain

    if not cleaned or len(cleaned) < 2:
        return []

    return ["{}.com".format(cleaned), "{}.io".format(cleaned), "{}.co".format(cleaned)]


def validate_logo_url(url, timeout=5.0):
    """Check if a logo URL returns a valid image.
    Returns the URL if valid, None otherwise."""
    try:
        resp = requests.head(url, timeout=timeout, allow_redirects=True)
        if resp.status_code != 200:
            return None
        content_type = resp.headers.get("Content-Type", "")
        if "image" not in content_type:
            return None
        # HEAD doesn't always have Content-Length, do a GET with stream
        resp2 = requests.get(url, timeout=timeout, stream=True)
        chunk = resp2.raw.read(MIN_LOGO_BYTES + 100)
        resp2.close()
        if len(chunk) < MIN_LOGO_BYTES:
            return None
        return url
    except Exception:
        return None


def resolve_logo_for_domain(domain, timeout=5.0):
    """Check if Google Favicon API returns a valid icon for this domain.
    Returns the favicon URL if valid, None otherwise."""
    if not domain:
        return None
    url = FAVICON_URL.format(domain=domain)
    return validate_logo_url(url, timeout)


def resolve_logo_for_company(company, website, cache):
    """Resolve a logo URL for a company. Returns URL or None."""
    cache_key = company.lower().strip()

    # Already cached
    if cache_key in cache:
        entry = cache[cache_key]
        return entry.get("logoUrl") or None

    print("  Resolving: {}".format(company), end="", flush=True)

    # Step 1: Try domain from website
    domain = extract_domain_from_url(website)

    # If it's a job board URL, try to extract the real company domain
    if domain and is_job_board_domain(domain):
        domain = ""

    # For websites like "careers.etsy.com", extract root domain
    if domain:
        parts = domain.split(".")
        if len(parts) > 2 and parts[0] in ("careers", "jobs", "career", "job", "hire", "hiring"):
            domain = ".".join(parts[1:])

    # Step 2: Validate the website domain favicon
    if domain:
        logo_url = resolve_logo_for_domain(domain)
        if logo_url:
            print(" -> {} [from website]".format(domain))
            cache[cache_key] = {"domain": domain, "logoUrl": logo_url, "source": "website"}
            return logo_url

    # Step 3: Guess domain from company name
    guesses = guess_domain_from_name(company)
    for guess in guesses:
        logo_url = resolve_logo_for_domain(guess)
        if logo_url:
            print(" -> {} [guessed]".format(guess))
            cache[cache_key] = {"domain": guess, "logoUrl": logo_url, "source": "guessed"}
            return logo_url

    # Failed
    print(" -> UNRESOLVED")
    cache[cache_key] = {"domain": "", "logoUrl": "", "source": "unresolved"}
    return None


def shuffle_rows(rows):
    """Shuffle rows so that consecutive rows don't share the same company logo.
    Uses slot-based distribution: the largest group gets evenly spaced slots,
    then smaller groups fill remaining slots."""
    from collections import defaultdict

    # Group rows by company name
    groups = defaultdict(list)
    no_company = []
    for row in rows:
        name = (row.get("company") or "").strip().lower()
        if name:
            groups[name].append(row)
        else:
            no_company.append(row)

    total = len(rows)
    result = [None] * total

    # Sort groups largest-first
    sorted_groups = sorted(groups.values(), key=len, reverse=True)

    # Place each group's rows at evenly-spaced positions
    filled = [False] * total
    for group in sorted_groups:
        count = len(group)
        # Calculate ideal spacing
        spacing = total / count if count > 0 else total
        placed = 0
        for idx in range(count):
            # Ideal position for this item
            ideal = int(idx * spacing + spacing / 2) % total
            # Find nearest open slot
            pos = ideal
            searched = 0
            while filled[pos] and searched < total:
                pos = (pos + 1) % total
                searched += 1
            if not filled[pos]:
                result[pos] = group[idx]
                filled[pos] = True
                placed += 1

    # Place no-company rows in remaining slots
    for row in no_company:
        for i in range(total):
            if not filled[i]:
                result[i] = row
                filled[i] = True
                break

    # Filter out any None slots (shouldn't happen, but safety)
    result = [r for r in result if r is not None]

    return result


def main():
    global CACHE_FILE

    parser = argparse.ArgumentParser(description="Enrich job CSV with company logos")
    parser.add_argument("--input", default=INPUT_CSV, help="Input CSV path")
    parser.add_argument("--output", default=OUTPUT_CSV, help="Output CSV path")
    parser.add_argument("--cache", default=str(CACHE_FILE), help="Logo cache JSON path")
    args = parser.parse_args()

    CACHE_FILE = Path(args.cache)

    print("[INPUT]  {}".format(args.input))
    print("[OUTPUT] {}".format(args.output))
    print("[CACHE]  {}".format(CACHE_FILE))
    print()

    # Read CSV
    with open(args.input, "r", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        fieldnames = reader.fieldnames
        rows = list(reader)

    print("Read {} rows from CSV".format(len(rows)))

    # Extract unique companies
    companies = {}  # company_name -> website
    for row in rows:
        name = (row.get("company") or "").strip()
        website = (row.get("companyWebsite") or "").strip()
        if name and name not in companies:
            companies[name] = website

    print("Found {} unique companies".format(len(companies)))
    print()

    # Load cache and resolve logos
    cache = load_cache()
    cached_count = sum(1 for c in companies if c.lower().strip() in cache)
    print("Already cached: {}/{}".format(cached_count, len(companies)))
    print()

    print("Resolving logos:")
    resolved = 0
    unresolved = 0
    for company_name, website in companies.items():
        logo_url = resolve_logo_for_company(company_name, website, cache)
        if logo_url:
            resolved += 1
        else:
            unresolved += 1

    # Save cache after all resolutions
    save_cache(cache)

    print()
    print("Resolved: {}/{}".format(resolved, len(companies)))
    print("Unresolved: {}/{}".format(unresolved, len(companies)))

    # List unresolved for manual review
    if unresolved > 0:
        print("\nUnresolved companies (need manual logo URLs):")
        for company_name in companies:
            entry = cache.get(company_name.lower().strip(), {})
            if not entry.get("logoUrl"):
                print("  - {}".format(company_name))

    # Write logos into rows
    updated = 0
    for row in rows:
        name = (row.get("company") or "").strip()
        if not name:
            continue
        entry = cache.get(name.lower().strip(), {})
        logo_url = entry.get("logoUrl", "")
        if logo_url and not (row.get("companyLogo") or "").strip():
            row["companyLogo"] = logo_url
            updated += 1

    print("\nUpdated {} rows with logo URLs".format(updated))

    # Shuffle rows so same-company jobs aren't clumped together
    rows = shuffle_rows(rows)
    print("Shuffled rows to spread companies apart")

    # Write output CSV
    os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)
    with open(args.output, "w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)

    print("Written to: {}".format(args.output))


if __name__ == "__main__":
    main()
