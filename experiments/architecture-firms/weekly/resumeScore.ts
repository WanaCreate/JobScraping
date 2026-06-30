/**
 * Resume-tuned fit scorer for the WEEKLY tracker pipeline.
 *
 * Scores an architecture job 0–10 by how well it matches the target candidate's
 * resume (Hasini Kadaru — entry-level Architectural Designer, M.Arch May 2026,
 * CPHC; Revit / AutoCAD / SketchUp / Enscape / passive-house & sustainability;
 * construction documentation, permit sets, ADA & life-safety; seeking
 * "Architectural Designer I / Junior Designer" roles on US projects).
 *
 * Design mirrors the repo's creativeScoreLib (max-matching tiered patterns) but is
 * tuned to entry-level building-architecture fit, not generic "creative":
 *   - title tier         → base score (entry-level roles score highest)
 *   - seniority penalty  → subtract for senior/lead/principal/director/manager
 *   - skill bonus        → +1 when the description names her tools (stage 2 only)
 * Clamped to [0, 10]. The pipeline keeps titles at/above a threshold (default 6).
 *
 * Self-contained — lives under experiments/, imports nothing from the main pipeline.
 */

interface Tier {
  score: number;
  patterns: RegExp[];
}

// Highest first; we take the score of the first tier that matches the title.
const TITLE_TIERS: Tier[] = [
  {
    // Bullseye: explicitly entry-level architectural design roles.
    score: 10,
    patterns: [
      /\barchitectural\s+designer\b/i,
      /\bjunior\s+(architect|designer)\b/i,
      /\b(architect|designer)\s*(i|1)\b/i,
      /\bentry[\s-]*level\b/i,
      /\bgraduate\s+architect\b/i,
      /\bdesigner,?\s+architecture\b/i,
    ],
  },
  {
    // Internships / job captain — strong fit for a new M.Arch grad.
    score: 9,
    patterns: [
      /\barchitectural\s+intern(ship)?\b/i,
      /\bdesign(er)?\s+intern(ship)?\b/i,
      /\bintern\s+architect\b/i,
      /\bjob\s+captain\b/i,
    ],
  },
  {
    // Closely-aligned design/documentation roles + her specialties.
    score: 8,
    patterns: [
      /\bdesign\s+architect\b/i,
      /\bproject\s+designer\b/i,
      /\binterior\s+designer\b/i,
      /\bsustainab(le|ility)\s+designer\b/i,
      /\bpassive\s+house\b/i,
      /\bbim\s+(coordinator|specialist|technician|designer)\b/i,
      /\brevit\b/i,
    ],
  },
  {
    // Relevant but level-ambiguous (often mid-level): general architect roles.
    score: 6,
    patterns: [
      /\bproject\s+architect\b/i,
      /\barchitectural\s+(staff|associate)\b/i,
      /\b(staff|registered|licensed)\s+architect\b/i,
      /\barchitect\b/i,
      /\bdesigner\b/i,
      /\barchitectural\s+drafter\b/i,
      /\bdrafter\b/i,
      /\bcad\s+technician\b/i,
      /\bbim\b/i,
    ],
  },
];

// Seniority signals — she's targeting junior roles, so these push a title down.
const SENIOR_STRONG = /\b(senior|sr\.?|lead|principal|director|head\s+of|vice\s+president|vp|associate\s+principal|partner)\b/i;
const SENIOR_LEVEL = /\b(architect|designer)\s*(iii|iv|v)\b|\b(iii|iv)\b/i;

// Her toolset / domain — rewarded once the description is available (stage 2).
const SKILL_HINTS = [
  /\brevit\b/i, /\bautocad\b/i, /\bsketchup\b/i, /\benscape\b/i, /\blumion\b/i,
  /\bbluebeam\b/i, /\bcove\.?tool\b/i, /\btherm\b/i, /\bpassive\s+house\b/i,
  /\bphius\b/i, /\bleed\b/i, /\bcphc\b/i, /\bada\b/i, /\blife[\s-]*safety\b/i,
  /\bconstruction\s+document/i, /\bpermit\s+set/i, /\bschematic\s+design\b/i,
  /\bdesign\s+development\b/i, /\bconstruction\s+administration\b/i,
];

function baseTitleScore(title: string): number {
  const t = (title ?? "").trim();
  if (!t) return 0;
  for (const tier of TITLE_TIERS) {
    if (tier.patterns.some((p) => p.test(t))) return tier.score;
  }
  return 3; // architecture role (already arch-filtered) but no specific signal
}

export interface ScoreBreakdown {
  score: number;
  base: number;
  seniorityPenalty: number;
  skillBonus: number;
}

/**
 * Score a job for resume fit. Pass the description (stage 2) to enable the
 * skill bonus; title-only (stage 1) skips it.
 */
export function scoreResumeFit(title: string, description?: string | null): ScoreBreakdown {
  const base = baseTitleScore(title);

  let seniorityPenalty = 0;
  if (SENIOR_STRONG.test(title)) seniorityPenalty += 5;
  if (SENIOR_LEVEL.test(title)) seniorityPenalty += 3;

  let skillBonus = 0;
  if (description) {
    const matches = SKILL_HINTS.filter((p) => p.test(description)).length;
    if (matches >= 1) skillBonus += 1;
    if (matches >= 3) skillBonus += 1; // strong tooling overlap
  }

  const score = Math.max(0, Math.min(10, base - seniorityPenalty + skillBonus));
  return { score, base, seniorityPenalty, skillBonus };
}

/** Convenience: title-only fit score (stage 1 gate). */
export function scoreTitleFit(title: string): number {
  return scoreResumeFit(title).score;
}
