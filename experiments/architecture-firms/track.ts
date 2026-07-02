/**
 * Phase 2 — daily tracker.
 *
 * Re-scrapes the firms we can scrape successfully (every firm in firms.json whose
 * `scraper` is not "skip"), filters to architecture roles, and DIFFS the result
 * against a persistent state file to report only *new* postings since the last
 * run. Also surfaces a posted date for every role (from the ATS where available,
 * otherwise the date we first saw it).
 *
 * State lives in   output/_state/seen_jobs.json   (one entry per job, keyed by a
 * stable firm+url identity, carrying firstSeen / lastSeen / status).
 *
 * Run:  npx tsx experiments/architecture-firms/track.ts
 * Flags:
 *   --firm "Gensler"    only this firm (substring) — handy for testing
 *   --limit 5           first N eligible firms only
 *   --concurrency 4     parallel firms (default 4)
 *   --dry-run           do everything except writing state (preview a run)
 *   --no-seed           ignore past snapshots; today's full scrape becomes the
 *   (alias --fresh)     baseline (firstSeen = today for all, posted dates from source)
 *   --reseed            rebuild the baseline state from past output/<date>/arch_jobs.json
 *                       runs, then diff (use once to seed from the Phase-1 baseline)
 *
 * Output (in output/<Month><Day>-<Year>/):
 *   new_jobs_<date>.csv        the daily deliverable — only roles new since last run
 *   open_arch_jobs_<date>.csv  full current snapshot (every open arch role + firstSeen)
 *   daily_summary.json         per-firm counts (scraped / arch / new / closed) + lists
 * Plus, cumulative:
 *   output/_state/seen_jobs.json     the running state
 *   output/_state/new_jobs_log.csv   every new role ever detected, appended each run
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, appendFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { type Firm, type ArchJobRow, processFirm, pool, toCsv } from "./scrape.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = join(__dirname, "output");
const STATE_DIR = join(OUTPUT_DIR, "_state");
const STATE_FILE = join(STATE_DIR, "seen_jobs.json");
const NEW_LOG_FILE = join(STATE_DIR, "new_jobs_log.csv");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

// ---------------------------------------------------------------------------
// Job identity + state
// ---------------------------------------------------------------------------
interface JobState {
  firm: string;
  title: string;
  location: string;
  url: string;
  ats: string;
  datePosted: string;   // raw value the ATS gave us (ISO, or "Posted 5 Days Ago", or "")
  postedDate: string;   // normalized YYYY-MM-DD when we could derive one, else ""
  firstSeen: string;    // YYYY-MM-DD we first saw this role
  lastSeen: string;     // YYYY-MM-DD we last saw it open
  status: "open" | "closed";
  closedOn?: string;
}
type State = Record<string, JobState>;

/**
 * Stable identity for a posting. The URL carries the ATS req id, so it's the best
 * key — but some ATSes put that id in the QUERY (UltiPro `?opportunityId=`,
 * Eightfold `?pid=`), so we must keep the query and only strip the hash + known
 * tracking params, not the whole query string.
 */
const TRACKING_PARAMS = /^(utm_|ssrc$|src$|gh_src$|fbclid$|gclid$|domain$)/i;
function normalizeUrl(url: string): string {
  const raw = url.trim();
  if (!raw) return "";
  try {
    const u = new URL(raw);
    u.hash = "";
    for (const k of Array.from(u.searchParams.keys())) {
      if (TRACKING_PARAMS.test(k)) u.searchParams.delete(k);
    }
    u.searchParams.sort();
    let s = u.toString().toLowerCase();
    if (s.endsWith("/")) s = s.slice(0, -1);
    return s;
  } catch {
    return raw.toLowerCase().replace(/#.*$/, "");
  }
}
function jobKey(firm: string, url: string, title: string, location: string): string {
  const norm = (s: string) => s.toLowerCase().trim();
  const u = normalizeUrl(url);
  if (u) return `${norm(firm)}||${u}`;
  return `${norm(firm)}||${norm(title)}||${norm(location)}`;
}

function loadState(): State {
  if (!existsSync(STATE_FILE)) return {};
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8")) as State;
  } catch {
    return {};
  }
}

/**
 * Build a baseline state from past Phase-1 snapshots (output/<date>/arch_jobs.json),
 * so the first tracked run diffs against history instead of flagging everything new.
 * firstSeen is taken from each snapshot's run date (earliest wins).
 */
function seedFromHistory(): State {
  const state: State = {};
  if (!existsSync(OUTPUT_DIR)) return state;

  const snapshots: { date: string; rows: ArchJobRow[] }[] = [];
  for (const entry of readdirSync(OUTPUT_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "_state") continue;
    const file = join(OUTPUT_DIR, entry.name, "arch_jobs.json");
    if (!existsSync(file)) continue;
    try {
      const rows = JSON.parse(readFileSync(file, "utf8")) as ArchJobRow[];
      const date = rows[0]?.scrapedAt ? toDate(rows[0].scrapedAt) : entry.name;
      snapshots.push({ date, rows });
    } catch {
      /* ignore unreadable snapshot */
    }
  }
  // oldest first so the earliest run sets firstSeen
  snapshots.sort((a, b) => a.date.localeCompare(b.date));

  for (const snap of snapshots) {
    for (const r of snap.rows) {
      const key = jobKey(r.firm, r.url, r.title, r.location);
      const existing = state[key];
      if (existing) {
        existing.lastSeen = snap.date;
        if (!existing.datePosted && r.datePosted) existing.datePosted = r.datePosted;
        continue;
      }
      state[key] = {
        firm: r.firm,
        title: r.title,
        location: r.location,
        url: r.url,
        ats: r.ats,
        datePosted: r.datePosted ?? "",
        postedDate: normalizePostedDate(r.datePosted ?? "", snap.date),
        firstSeen: snap.date,
        lastSeen: snap.date,
        status: "open",
      };
    }
  }
  return state;
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------
/** YYYY-MM-DD from a Date. */
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
/** YYYY-MM-DD from an ISO-ish string (returns "" if unparseable). */
function toDate(s: string): string {
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? "" : isoDate(d);
}

/**
 * Best-effort normalized posted date (YYYY-MM-DD). Handles real timestamps
 * (Oracle / SmartRecruiters / UltiPro / Eightfold) and Workday's relative
 * "Posted N Days Ago" / "Posted Today" / "Posted Yesterday" strings, resolved
 * against the run date. Returns "" when nothing usable is present.
 */
function normalizePostedDate(raw: string, runDate: string): string {
  const v = (raw ?? "").trim();
  if (!v) return "";

  // Real date/timestamp first.
  const direct = toDate(v);
  if (direct) return direct;

  // Workday-style relative phrasing.
  const ref = new Date(runDate);
  if (Number.isNaN(ref.getTime())) return "";
  const lower = v.toLowerCase();
  if (/posted\s+today/.test(lower)) return isoDate(ref);
  if (/posted\s+yesterday/.test(lower)) {
    ref.setUTCDate(ref.getUTCDate() - 1);
    return isoDate(ref);
  }
  const days = lower.match(/posted\s+(\d+)\+?\s*days?\s+ago/);
  if (days) {
    ref.setUTCDate(ref.getUTCDate() - Number(days[1]));
    return isoDate(ref);
  }
  const months = lower.match(/posted\s+(\d+)\+?\s*months?\s+ago/);
  if (months) {
    ref.setUTCMonth(ref.getUTCMonth() - Number(months[1]));
    return isoDate(ref);
  }
  return "";
}

// ---------------------------------------------------------------------------
// CSV (daily new-jobs deliverable carries the tracker columns)
// ---------------------------------------------------------------------------
interface TrackedRow extends ArchJobRow {
  postedDate: string;
  firstSeen: string;
  newToday: boolean;
}

function csvEscape(v: string): string {
  if (/[",\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}
const TRACK_HEADER = ["firm", "title", "location", "url", "ats", "datePosted", "postedDate", "firstSeen", "sourceUrl", "scrapedAt"];
function trackRowCells(r: TrackedRow): string[] {
  return [r.firm, r.title, r.location, r.url, r.ats, r.datePosted, r.postedDate, r.firstSeen, r.sourceUrl, r.scrapedAt];
}
function toTrackedCsv(rows: TrackedRow[]): string {
  const lines = [TRACK_HEADER.join(",")];
  for (const r of rows) lines.push(trackRowCells(r).map(csvEscape).join(","));
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const allFirms: Firm[] = JSON.parse(readFileSync(join(__dirname, "firms.json"), "utf8"));

  // "Companies we scraped successfully" = everything with a real, non-deferred scraper.
  let selected = allFirms.filter((f) => f.scraper !== "skip" && !!f.url);
  const firmFilter = arg("firm");
  if (firmFilter) selected = selected.filter((f) => f.name.toLowerCase().includes(firmFilter.toLowerCase()));
  const limit = arg("limit");
  if (limit) selected = selected.slice(0, Number(limit));

  const concurrency = Number(arg("concurrency") ?? 4);
  const dryRun = flag("dry-run");
  const reseed = flag("reseed");
  const noSeed = flag("no-seed") || flag("fresh");

  const now = new Date();
  const scrapedAt = now.toISOString();
  const runDate = isoDate(now);
  const dateFolder = `${now.toLocaleString("en-US", { month: "long" })}${now.getDate()}-${now.getFullYear()}`;

  // Load (or build) prior state.
  let priorState = loadState();
  let baselineRun = false;
  const hasState = Object.keys(priorState).length > 0;
  if (noSeed && !hasState) {
    // Fresh baseline: ignore past snapshots entirely. Today's full scrape (with
    // real posted dates from source) IS the baseline; firstSeen = today for all.
    baselineRun = true;
    console.log(`Fresh baseline run — ignoring past snapshots; today's full scrape establishes the baseline.`);
  } else if ((reseed || !hasState) && !noSeed) {
    const seeded = seedFromHistory();
    if (Object.keys(seeded).length > 0) {
      priorState = reseed ? seeded : { ...seeded, ...priorState };
      console.log(`Seeded baseline from past snapshots: ${Object.keys(seeded).length} prior roles.`);
    } else if (!hasState) {
      baselineRun = true;
      console.log(`No prior state and no past snapshots — this run establishes the baseline.`);
    }
  }

  console.log(`\nTracking ${selected.length} firms (concurrency ${concurrency})${dryRun ? " [dry-run]" : ""}...\n`);

  const outcomes = await pool(selected, concurrency, async (firm, idx) => {
    const out = await processFirm(firm, scrapedAt);
    const r = out.result;
    const tag = r.status === "ok" ? "OK " : r.status === "error" ? "ERR" : r.status === "no-jobs" ? "---" : "SKP";
    console.log(`[${idx + 1}/${selected.length}] ${tag} ${firm.name}: ${r.archJobsFound} arch / ${r.totalJobsFound} total${r.error ? `  (${r.error.slice(0, 70)})` : ""}`);
    return out;
  });

  const archRows = outcomes.flatMap((o) => o.archRows);
  const scrapedFirms = new Set(selected.map((f) => f.name));

  // Diff against prior state.
  const state: State = { ...priorState };
  const currentKeys = new Set<string>();
  const trackedRows: TrackedRow[] = [];
  const newRows: TrackedRow[] = [];

  for (const r of archRows) {
    const key = jobKey(r.firm, r.url, r.title, r.location);
    currentKeys.add(key);
    const prior = state[key];
    const postedDate = normalizePostedDate(r.datePosted, runDate);

    let firstSeen: string;
    let isNew: boolean;
    if (prior) {
      firstSeen = prior.firstSeen;
      isNew = false;
      state[key] = {
        ...prior,
        // refresh fields that can change / fill gaps
        location: r.location || prior.location,
        ats: r.ats || prior.ats,
        datePosted: r.datePosted || prior.datePosted,
        postedDate: postedDate || prior.postedDate,
        lastSeen: runDate,
        status: "open",
        closedOn: undefined,
      };
    } else {
      firstSeen = runDate;
      isNew = !baselineRun; // baseline run: record but don't flag a flood of "new"
      state[key] = {
        firm: r.firm, title: r.title, location: r.location, url: r.url, ats: r.ats,
        datePosted: r.datePosted, postedDate, firstSeen, lastSeen: runDate, status: "open",
      };
    }

    const tracked: TrackedRow = { ...r, postedDate: postedDate || firstSeen, firstSeen, newToday: isNew };
    trackedRows.push(tracked);
    if (isNew) newRows.push(tracked);
  }

  // Roles that were open but didn't appear this run (only for firms we actually scraped).
  const closedThisRun: JobState[] = [];
  for (const [key, js] of Object.entries(state)) {
    if (currentKeys.has(key)) continue;
    if (!scrapedFirms.has(js.firm)) continue; // firm not in this run's scope — leave untouched
    if (js.status === "closed") continue;
    js.status = "closed";
    js.closedOn = runDate;
    closedThisRun.push(js);
  }

  // Per-firm rollup.
  const perFirm = outcomes.map((o) => {
    const firm = o.result.firm;
    const newCount = newRows.filter((r) => r.firm === firm).length;
    const closedCount = closedThisRun.filter((r) => r.firm === firm).length;
    return {
      firm,
      ats: o.result.detectedAts,
      status: o.result.status,
      totalJobsFound: o.result.totalJobsFound,
      archJobsFound: o.result.archJobsFound,
      newToday: newCount,
      closedToday: closedCount,
      error: o.result.error,
    };
  });

  // ---- Write outputs ----
  const outDir = join(OUTPUT_DIR, dateFolder);
  mkdirSync(outDir, { recursive: true });

  // sort new jobs newest-posted first for readability
  newRows.sort((a, b) => (b.postedDate || "").localeCompare(a.postedDate || ""));
  writeFileSync(join(outDir, `new_jobs_${dateFolder}.csv`), toTrackedCsv(newRows), "utf8");
  writeFileSync(join(outDir, `open_arch_jobs_${dateFolder}.csv`), toTrackedCsv(trackedRows), "utf8");

  const summary = {
    runDate,
    scrapedAt,
    baselineRun,
    dryRun,
    firmsScraped: selected.length,
    totalArchOpen: trackedRows.length,
    newToday: newRows.length,
    closedToday: closedThisRun.length,
    perFirm,
    newJobs: newRows.map((r) => ({ firm: r.firm, title: r.title, location: r.location, postedDate: r.postedDate, url: r.url })),
    closedJobs: closedThisRun.map((r) => ({ firm: r.firm, title: r.title, location: r.location, url: r.url })),
  };
  writeFileSync(join(outDir, "daily_summary.json"), JSON.stringify(summary, null, 2), "utf8");

  if (!dryRun) {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");

    // Append new roles to the cumulative running log.
    if (newRows.length > 0) {
      const header = ["detectedOn", ...TRACK_HEADER].join(",");
      if (!existsSync(NEW_LOG_FILE)) writeFileSync(NEW_LOG_FILE, header + "\n", "utf8");
      const lines = newRows.map((r) => [runDate, ...trackRowCells(r)].map(csvEscape).join(",")).join("\n");
      appendFileSync(NEW_LOG_FILE, lines + "\n", "utf8");
    }
  }

  // ---- Console report ----
  console.log(`\n=== Daily tracker — ${runDate} ===`);
  if (baselineRun) console.log(`(baseline run — current roles recorded as the starting point, not flagged new)`);
  console.log(`Firms scraped: ${selected.length} | open arch roles: ${trackedRows.length}`);
  console.log(`NEW since last run: ${newRows.length} | closed since last run: ${closedThisRun.length}`);
  if (newRows.length) {
    console.log(`\nNew postings:`);
    for (const r of newRows.slice(0, 40)) {
      console.log(`  + [${r.firm}] ${r.title} — ${r.location || "—"} (posted ${r.postedDate || "?"})`);
    }
    if (newRows.length > 40) console.log(`  … and ${newRows.length - 40} more (see CSV)`);
  }
  if (dryRun) console.log(`\n[dry-run] state NOT written.`);
  console.log(`\nOutput: ${outDir}`);
  console.log(`  new_jobs_${dateFolder}.csv  (${newRows.length} rows)`);
  console.log(`  open_arch_jobs_${dateFolder}.csv  (${trackedRows.length} rows)`);
  if (!dryRun) console.log(`State: ${STATE_FILE}`);
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
