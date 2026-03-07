import csv
import re

INPUT = r"C:\Users\vyash\Desktop\Business\Wana\_Code\JobScraping\outputs\api-ready\results_with_logos.csv"
OUTPUT = r"C:\Users\vyash\Desktop\Business\Wana\_Code\JobScraping\outputs\api-ready\results_with_logos_sorted.csv"

# Score by title keywords (primary) + first 200 chars of desc (secondary)
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

def score_title_desc(title, desc_snippet):
    text = (title + " " + desc_snippet).lower()

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
