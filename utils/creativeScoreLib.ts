/**
 * utils/creativeScoreLib.ts
 *
 * Shared creative-scoring logic — single source of truth for scrape-time and
 * promote/prune-time scoring. Mirrors score_jobs.py exactly:
 *   1. Load weights from creativeScore.json ({ "weights": { keyword: number } }).
 *   2. Score text by the MAX matching keyword weight (word-boundary regex),
 *      rounded and clamped to [2, 10]. No match → 3 (neutral default).
 *   3. If the JSON is missing/malformed, fall back to the hardcoded tier
 *      patterns (10 > 8 > 6 > 4 > 2, default 3).
 *
 * Callers pass the path to creativeScore.json so this stays location-agnostic.
 */

import { readFile } from "node:fs/promises";

export type JsonWeightEntry = [RegExp, number]; // [compiled pattern, weight]

// Hardcoded tier fallback patterns (verbatim from score_jobs.py)
const SCORE_10_PATTERNS = [
  /\billustrat/i, /\banimator\b/i, /\banimation\b/i, /\bart director\b/i,
  /\bgraphic design/i, /\bvisual design/i, /\bux design/i, /\bui design/i,
  /\bui\/ux\b/i, /\bux\/ui\b/i, /\bvideo edit/i, /\bmotion design/i,
  /\bmotion graphic/i, /\bgame design/i, /\bcharacter design/i,
  /\btypograph/i, /\bfashion design/i, /\bjewelry design/i,
  /\bindustrial design/i, /\bproduct design/i, /\binteraction design/i,
  /\bexperience design/i, /\bcreative direct/i, /\bart lead\b/i,
  /\bconceptual artist\b/i, /\bconcept artist\b/i, /\bdigital artist\b/i,
  /\bfine art\b/i, /\bphotograph/i, /\bvideograph/i, /\bcinematograph/i,
  /\bsound design/i, /\bmusic produc/i, /\baudio engineer/i,
  /\bvfx\b/i, /\bspecial effects\b/i, /\b3d artist\b/i, /\b3d model/i,
  /\bsculptor\b/i, /\bstoryboard/i, /\bcomic\b/i, /\bcartoon/i,
  /\bfootwear design/i, /\btextile design/i, /\bapparel design/i,
  /\bpackaging design/i, /\bprint design/i,
];

const SCORE_8_PATTERNS = [
  /\bcopywriter\b/i, /\bcreative writer\b/i, /\bcontent creator\b/i,
  /\bbrand design/i, /\bbrand identity\b/i, /\bcreative strateg/i,
  /\bcreative produc/i, /\bvisual storytell/i, /\bsocial media content\b/i,
  /\beditorial design/i, /\bweb design/i, /\bfront.end design/i,
  /\bcreative services\b/i, /\bcreative team\b/i, /\bcreative manager\b/i,
  /\bcreative lead\b/i, /\bcreative specialist\b/i,
  /\bsenior designer\b/i, /\blead designer\b/i, /\bstaff designer\b/i,
  /\bux researcher\b/i, /\buser research/i, /\bproduct designer\b/i,
  /\bspatial design/i, /\benvironmental design/i,
  /\bmusician\b/i, /\bcomposer\b/i, /\blyricist\b/i,
  /\bfilm\b.*\bproduc/i, /\bproduction design/i,
  /\bcontent design/i, /\bcreative content\b/i,
];

const SCORE_6_PATTERNS = [
  /\bmarketing design/i, /\bcampaign manag/i, /\bbrand manag/i,
  /\bcontent manag/i, /\bcontent strateg/i, /\bcontent market/i,
  /\bsocial media manag/i, /\bcommunity manag/i,
  /\bux\b/i, /\bui\b/i, /\buser experience\b/i, /\buser interface\b/i,
  /\bcreative\b/i, /\bdesign\b/i, /\bvisual\b/i,
  /\bwriter\b/i, /\beditor\b/i, /\bproducer\b/i,
  /\bstylish\b/i, /\bstylist\b/i, /\bfashion\b/i,
  /\barch(itect|itectur)/i, /\binterior\b/i,
  /\bgame dev/i, /\bgame artist\b/i,
  /\bphotoshop\b/i, /\bsketch\b.*\bdesign/i,
  /\bdigital market/i, /\becommerce.*design/i,
  /\bcreative ops\b/i, /\bcreative operat/i,
  /\bnarrat/i, /\bstorytell/i,
  /\bweb content\b/i, /\bcopyedit/i,
  /\bpost produc/i, /\bbroadcast/i,
];

const SCORE_4_PATTERNS = [
  /\bmarketing\b/i, /\bbrand\b/i, /\bcommunic/i,
  /\bsocial media\b/i, /\bpublic relation/i, /\bpr\b/i,
  /\bproduct manag/i, /\bprogram manag/i,
  /\bproject manag.*creative/i, /\bcreative.*project/i,
  /\bcustomer experienc/i, /\bcx\b/i,
  /\bcontent\b/i, /\bmedia\b/i,
  /\btraining.*design/i, /\binstructional design/i,
  /\bevent\b/i, /\bshow\b.*\bproduc/i,
  /\bstudio manag/i, /\bstudio operat/i,
  /\bdigital.*manag/i, /\bdigital prod/i,
];

const SCORE_2_PATTERNS = [
  /\bengine/i, /\bdevelop/i, /\bsoftware\b/i, /\bdata\b/i,
  /\banalyst\b/i, /\banalysis\b/i, /\bscient/i,
  /\bfinance\b/i, /\bfinancial\b/i, /\baccounting\b/i,
  /\boperat/i, /\blogistic/i, /\bsupply chain\b/i,
  /\bproject manag\b/i, /\bprogram manag\b/i,
  /\bhr\b/i, /\bhuman resource/i, /\brecruit/i,
  /\bsafety\b/i, /\bcomplian/i, /\blegal\b/i,
  /\bsales\b/i, /\bbusiness dev/i, /\baccount exec/i,
  /\bcustomer support\b/i, /\bcustomer service\b/i,
  /\bwarehouse\b/i, /\bmanufactur/i, /\bproduct/i,
  /\badmin\b/i, /\bcoordinat/i, /\bassistant\b/i,
];

/** Hardcoded fallback scoring (score_jobs.py: _score_fallback). */
export function scoreFallback(text: string): number {
  for (const p of SCORE_10_PATTERNS) if (p.test(text)) return 10;
  for (const p of SCORE_8_PATTERNS) if (p.test(text)) return 8;
  for (const p of SCORE_6_PATTERNS) if (p.test(text)) return 6;
  for (const p of SCORE_4_PATTERNS) if (p.test(text)) return 4;
  for (const p of SCORE_2_PATTERNS) if (p.test(text)) return 2;
  return 3;
}

/** Load and compile JSON weights from creativeScore.json. Returns null if missing/malformed. */
export async function loadJsonWeights(scoreJsonPath: string): Promise<JsonWeightEntry[] | null> {
  try {
    const raw = await readFile(scoreJsonPath, "utf-8");
    const data: unknown = JSON.parse(raw);
    if (
      typeof data !== "object" ||
      data === null ||
      !("weights" in data) ||
      typeof (data as Record<string, unknown>).weights !== "object" ||
      (data as Record<string, unknown>).weights === null
    ) {
      throw new Error("'weights' key missing or not an object");
    }
    const weightsObj = (data as { weights: Record<string, unknown> }).weights;
    const entries: JsonWeightEntry[] = [];
    for (const [key, val] of Object.entries(weightsObj)) {
      const weight = typeof val === "number" ? val : parseFloat(String(val));
      if (!Number.isFinite(weight)) continue;
      // word-boundary pattern: \b<escaped-keyword>\b (same as score_jobs.py)
      const pattern = new RegExp("\\b" + key.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "i");
      entries.push([pattern, weight]);
    }
    if (entries.length === 0) throw new Error("no valid weight entries");
    entries.sort((a, b) => b[1] - a[1]); // descending; we take MAX anyway
    return entries;
  } catch (err) {
    console.warn(
      `[creativeScore] WARNING: Could not load ${scoreJsonPath} (${(err as Error).message}) — using hardcoded fallback tiers.`
    );
    return null;
  }
}

/**
 * Score a job title using the same logic as score_jobs.py:score_title_desc.
 * Title-only when no description snippet is available (Stage 1 creative_jobs
 * carries no snippet) — identical to score_jobs.py with desc "".
 */
export function scoreTitle(title: string, weights: JsonWeightEntry[] | null): number {
  const text = (title ?? "").toLowerCase();

  if (weights !== null) {
    let best: number | null = null;
    for (const [pattern, weight] of weights) {
      if (pattern.test(text)) {
        if (best === null || weight > best) best = weight;
      }
    }
    if (best !== null) return Math.max(2, Math.min(10, Math.round(best)));
    return 3; // no keyword matched → neutral default
  }

  return scoreFallback(text);
}
