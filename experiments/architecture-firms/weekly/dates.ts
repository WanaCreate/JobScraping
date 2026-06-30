/**
 * Date helpers for the weekly pipeline. Self-contained (no imports from the
 * tracker) so the weekly pipeline stays independent.
 */

/** YYYY-MM-DD from a Date. */
export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** YYYY-MM-DD from an ISO-ish string; "" if unparseable. */
export function toDate(s: string): string {
  if (!s) return "";
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? "" : isoDate(d);
}

/** Whole-day difference (toISO - fromISO). */
export function daysBetween(fromISO: string, toISO: string): number {
  const a = new Date(fromISO + "T00:00:00Z").getTime();
  const b = new Date(toISO + "T00:00:00Z").getTime();
  return Math.round((b - a) / 86_400_000);
}

/** runDate shifted back by `days`, as YYYY-MM-DD. */
export function cutoffDate(runDate: string, days: number): string {
  return isoDate(new Date(new Date(runDate + "T00:00:00Z").getTime() - days * 86_400_000));
}

/**
 * Normalize a raw posted-date value to YYYY-MM-DD. Handles real timestamps
 * (Oracle / SmartRecruiters / UltiPro / Eightfold / JSON-LD) and Workday-style
 * relative strings ("Posted Today" / "Posted Yesterday" / "Posted N Days Ago" /
 * "Posted N+ Months Ago") resolved against the run date. "" when nothing usable.
 */
export function normalizePostedDate(raw: string | null | undefined, runDate: string): string {
  const v = (raw ?? "").trim();
  if (!v) return "";

  const direct = toDate(v);
  if (direct) return direct;

  const ref = new Date(runDate + "T00:00:00Z");
  if (Number.isNaN(ref.getTime())) return "";
  const lower = v.toLowerCase();

  if (/\btoday\b|\bjust posted\b|\bposted today\b/.test(lower)) return isoDate(ref);
  if (/\byesterday\b/.test(lower)) {
    ref.setUTCDate(ref.getUTCDate() - 1);
    return isoDate(ref);
  }
  const days = lower.match(/(\d+)\+?\s*days?\s+ago/);
  if (days) {
    ref.setUTCDate(ref.getUTCDate() - Number(days[1]));
    return isoDate(ref);
  }
  const weeks = lower.match(/(\d+)\+?\s*weeks?\s+ago/);
  if (weeks) {
    ref.setUTCDate(ref.getUTCDate() - Number(weeks[1]) * 7);
    return isoDate(ref);
  }
  const months = lower.match(/(\d+)\+?\s*months?\s+ago/);
  if (months) {
    ref.setUTCMonth(ref.getUTCMonth() - Number(months[1]));
    return isoDate(ref);
  }
  const hours = lower.match(/(\d+)\+?\s*hours?\s+ago/);
  if (hours) return isoDate(ref);
  return "";
}
