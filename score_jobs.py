import csv
import json
import os
import re
import sys

INPUT = r"C:\Users\vyash\Desktop\Business\Wana\_Code\JobScraping\outputs\api-ready\results_with_logos.csv"
OUTPUT = r"C:\Users\vyash\Desktop\Business\Wana\_Code\JobScraping\outputs\api-ready\results_with_logos_sorted.csv"

# Path to the weekly-generated weights file (same directory as this script → pipeline/)
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_SCORE_JSON = os.path.join(_SCRIPT_DIR, "pipeline", "creativeScore.json")

# ---------------------------------------------------------------------------
# Hardcoded fallback tiers (kept intact — used when creativeScore.json is
# missing or unparseable).
# ---------------------------------------------------------------------------
SCORE_10 = [
    r'\billustrat', r'\banimator\b', r'\banimation\b', r'\bart director\b',
    r'\bgraphic design', r'\bvisual design', r'\bux design', r'\bui design',
    r'\bui/ux\b', r'\bux/ui\b', r'\bvideo edit', r'\bmotion design',
    r'\bmotion graphic', r'\bgame design', r'\bcharacter design',
    r'\btypograph', r'\bfashion design', r'\bjewelry design',
    r'\bindustrial design', r'\bproduct design', r'\binteraction design',
    r'\bexperience design', r'\bcreative direct', r'\bart lead\b',
    r'\bconceptual artist\b', r'\bconcept artist\b', r'\bdigital artist\b',
    r'\bfine art\b', r'\bphotograph', r'\bvideograph', r'\bcinematograph',
    r'\bsound design', r'\bmusic produc', r'\baudio engineer',
    r'\bvfx\b', r'\bspecial effects\b', r'\b3d artist\b', r'\b3d model',
    r'\bsculptor\b', r'\bstoryboard', r'\bcomic\b', r'\bcartoon',
    r'\bfootwear design', r'\btextile design', r'\bapparel design',
    r'\bpackaging design', r'\bprint design',
]

SCORE_8 = [
    r'\bcopywriter\b', r'\bcreative writer\b', r'\bcontent creator\b',
    r'\bbrand design', r'\bbrand identity\b', r'\bcreative strateg',
    r'\bcreative produc', r'\bvisual storytell', r'\bsocial media content\b',
    r'\beditorial design', r'\bweb design', r'\bfront.end design',
    r'\bcreative services\b', r'\bcreative team\b', r'\bcreative manager\b',
    r'\bcreative lead\b', r'\bcreative specialist\b',
    r'\bsenior designer\b', r'\blead designer\b', r'\bstaff designer\b',
    r'\bux researcher\b', r'\buser research', r'\bproduct designer\b',
    r'\bspatial design', r'\benvironmental design',
    r'\bmusician\b', r'\bcomposer\b', r'\blyricist\b',
    r'\bfilm\b.*\bproduc', r'\bproduction design',
    r'\bcontent design', r'\bcreative content\b',
]

SCORE_6 = [
    r'\bmarketing design', r'\bcampaign manag', r'\bbrand manag',
    r'\bcontent manag', r'\bcontent strateg', r'\bcontent market',
    r'\bsocial media manag', r'\bcommunity manag',
    r'\bux\b', r'\bui\b', r'\buser experience\b', r'\buser interface\b',
    r'\bcreative\b', r'\bdesign\b', r'\bvisual\b',
    r'\bwriter\b', r'\beditor\b', r'\bproducer\b',
    r'\bstylish\b', r'\bstylist\b', r'\bfashion\b',
    r'\barch(itect|itectur)', r'\binterior\b',
    r'\bgame dev', r'\bgame artist\b',
    r'\bphotoshop\b', r'\bsketch\b.*\bdesign',
    r'\bdigital market', r'\becommerce.*design',
    r'\bcreative ops\b', r'\bcreative operat',
    r'\bnarrat', r'\bstorytell',
    r'\bweb content\b', r'\bcopyedit',
    r'\bpost produc', r'\bbroadcast',
]

SCORE_4 = [
    r'\bmarketing\b', r'\bbrand\b', r'\bcommunic',
    r'\bsocial media\b', r'\bpublic relation', r'\bpr\b',
    r'\bproduct manag', r'\bprogram manag',
    r'\bproject manag.*creative', r'\bcreative.*project',
    r'\bcustomer experienc', r'\bcx\b',
    r'\bcontent\b', r'\bmedia\b',
    r'\btraining.*design', r'\binstructional design',
    r'\bevent\b',  r'\bshow\b.*\bproduc',
    r'\bstudio manag', r'\bstudio operat',
    r'\bdigital.*manag', r'\bdigital prod',
]

SCORE_2 = [
    r'\bengine', r'\bdevelop', r'\bsoftware\b', r'\bdata\b',
    r'\banalyst\b', r'\banalysis\b', r'\bscient',
    r'\bfinance\b', r'\bfinancial\b', r'\baccounting\b',
    r'\boperat', r'\blogistic', r'\bsupply chain\b',
    r'\bproject manag\b', r'\bprogram manag\b',
    r'\bhr\b', r'\bhuman resource', r'\brecruit',
    r'\bsafety\b', r'\bcomplian', r'\blegal\b',
    r'\bsales\b', r'\bbusiness dev', r'\baccount exec',
    r'\bcustomer support\b', r'\bcustomer service\b',
    r'\bwarehouse\b', r'\bmanufactur', r'\bproduct',
    r'\badmin\b', r'\bcoordinat', r'\bassistant\b',
]


def _score_fallback(text):
    """Hardcoded tier-based scoring. Returns int 2–10 (or 3 as default)."""
    for pattern in SCORE_10:
        if re.search(pattern, text):
            return 10
    for pattern in SCORE_8:
        if re.search(pattern, text):
            return 8
    for pattern in SCORE_6:
        if re.search(pattern, text):
            return 6
    for pattern in SCORE_4:
        if re.search(pattern, text):
            return 4
    for pattern in SCORE_2:
        if re.search(pattern, text):
            return 2
    return 3  # default mid-low


# ---------------------------------------------------------------------------
# Try to load weights from creativeScore.json.
# _JSON_WEIGHTS is a list of (compiled_regex, weight_float) sorted by
# descending weight so the first match wins the highest available score.
# Patterns are compiled ONCE here at module load — not per row — for
# performance across 261+ keywords × every CSV row.
# Falls back to None if the file is missing or malformed.
# ---------------------------------------------------------------------------
_JSON_WEIGHTS = None  # type: list[tuple[re.Pattern, float]] | None

try:
    with open(_SCORE_JSON, encoding="utf-8") as _f:
        _data = json.load(_f)
    _raw = _data.get("weights", {})
    if not isinstance(_raw, dict) or not _raw:
        raise ValueError("'weights' key missing or empty")
    # Sort descending by weight so higher-scored keywords match first
    # (not strictly required when we take MAX, but keeps intent clear).
    # Compile each keyword into a word-boundary regex so single-word keys
    # like "art" don't false-match inside "start", "heart", "designation",
    # while multi-word phrases like "3d artist" still work correctly.
    _JSON_WEIGHTS = sorted(
        (
            (re.compile(r"\b" + re.escape(k.lower()) + r"\b"), float(v))
            for k, v in _raw.items()
        ),
        key=lambda x: x[1],
        reverse=True,
    )
    print(f"[score_jobs] Loaded {len(_JSON_WEIGHTS)} keyword weights from creativeScore.json")
except FileNotFoundError:
    print(
        f"[score_jobs] WARNING: {_SCORE_JSON} not found — falling back to hardcoded tiers.",
        file=sys.stderr,
    )
except Exception as _e:
    print(
        f"[score_jobs] WARNING: Could not parse creativeScore.json ({_e}) — falling back to hardcoded tiers.",
        file=sys.stderr,
    )


def _score_from_json(text):
    """
    Score using creativeScore.json weights.

    Scans the combined title+desc snippet for every compiled regex pattern
    (word-boundary anchored, case-insensitive — the text is already
    lowercased by the caller).  Takes the MAX weight across all matching
    keywords, rounds to the nearest integer, and clamps to [2, 10] so the
    column stays compatible with existing downstream consumers.

    Single-word keys like "art" only match as whole words and will NOT
    false-match inside "start", "heart", or "designation".  Multi-word
    phrases like "3d artist" continue to work because \b anchors apply at
    the phrase boundaries, not between words inside the phrase.

    Returns None if no keyword matches (caller should fall back to
    _score_fallback or return the default 3).
    """
    best = None
    for pattern, weight in _JSON_WEIGHTS:
        if pattern.search(text):
            if best is None or weight > best:
                best = weight
    if best is None:
        return None
    return max(2, min(10, round(best)))


def score_title_desc(title, desc_snippet):
    text = (title + " " + desc_snippet).lower()

    if _JSON_WEIGHTS is not None:
        result = _score_from_json(text)
        if result is not None:
            return result
        # No keyword matched at all — use a neutral default (3, same as
        # the original fallback default).
        return 3

    # JSON weights unavailable: use hardcoded tier logic.
    return _score_fallback(text)


with open(INPUT, encoding='utf-8', newline='') as f:
    reader = csv.DictReader(f)
    rows = list(reader)
    fieldnames = reader.fieldnames

for row in rows:
    title = row.get('title', '')
    desc = row.get('description', '')[:200]
    row['creative_score'] = score_title_desc(title, desc)

rows.sort(key=lambda r: r['creative_score'])

out_fieldnames = list(fieldnames) + ['creative_score']

with open(OUTPUT, 'w', encoding='utf-8', newline='') as f:
    writer = csv.DictWriter(f, fieldnames=out_fieldnames)
    writer.writeheader()
    writer.writerows(rows)

# Print distribution
from collections import Counter
dist = Counter(r['creative_score'] for r in rows)
print("Score distribution:")
for score in sorted(dist):
    print(f"  {score}: {dist[score]} jobs")
print(f"\nDone! Written to {OUTPUT}")
