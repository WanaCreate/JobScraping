/**
 * Filter step — runs over the tracker state (output/_state/seen_jobs.json), no
 * re-scraping, so we can iterate on heuristics cheaply.
 *
 * Filter A: recency — keep open roles whose effective date is within the last N
 * days (default 14). Effective date = source postedDate when we have one, else
 * firstSeen (the day we first saw the role). Each kept row is labelled with which
 * signal was used + how many days ago.
 *
 * Filter B: US-only — heuristic classification (see usGeo.ts). Recent roles are
 * split into US / foreign / location-unknown. The US bucket is the deliverable;
 * location-unknown (mostly custom sites that don't emit a location) is written to
 * a separate review file rather than dropped or guessed.
 *
 * Run:  npx tsx experiments/architecture-firms/filter.ts
 * Flags:
 *   --days 14         recency window in days (default 14)
 *   --on 2026-06-30   reference "today" (default: system date) — handy for testing
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { classifyLocation, type GeoClass } from "./usGeo.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = join(__dirname, "output");
const STATE_FILE = join(OUTPUT_DIR, "_state", "seen_jobs.json");

interface JobState {
  firm: string; title: string; location: string; url: string; ats: string;
  datePosted: string; postedDate: string; firstSeen: string; lastSeen: string;
  status: "open" | "closed"; closedOn?: string;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function isoDate(d: Date): string { return d.toISOString().slice(0, 10); }
function daysBetween(fromISO: string, toISO: string): number {
  const a = new Date(fromISO + "T00:00:00Z").getTime();
  const b = new Date(toISO + "T00:00:00Z").getTime();
  return Math.round((b - a) / 86_400_000);
}

function csvEscape(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function main() {
  if (!existsSync(STATE_FILE)) {
    console.error(`No state file at ${STATE_FILE}. Run track.ts first.`);
    process.exit(1);
  }
  const state = JSON.parse(readFileSync(STATE_FILE, "utf8")) as Record<string, JobState>;
  const open = Object.values(state).filter((j) => j.status === "open");

  const days = Number(arg("days") ?? 14);
  const today = arg("on") ?? isoDate(new Date());
  const cutoff = isoDate(new Date(new Date(today + "T00:00:00Z").getTime() - days * 86_400_000));

  const recent = open
    .map((j) => {
      const effective = j.postedDate || j.firstSeen;
      const source: "posted" | "firstSeen" = j.postedDate ? "posted" : "firstSeen";
      return {
        ...j,
        effective,
        dateSource: source,
        daysAgo: daysBetween(effective, today),
        geo: classifyLocation(j.location),
      };
    })
    .filter((j) => j.effective >= cutoff)
    .sort((a, b) => a.daysAgo - b.daysAgo);

  type Row = (typeof recent)[number];
  const us = recent.filter((r) => r.geo === "us");
  const foreign = recent.filter((r) => r.geo === "foreign");
  const unknown = recent.filter((r) => r.geo === "unknown");

  // ---- Write CSVs ----
  const now = new Date();
  const dateFolder = `${now.toLocaleString("en-US", { month: "long" })}${now.getDate()}-${now.getFullYear()}`;
  const outDir = join(OUTPUT_DIR, dateFolder);
  mkdirSync(outDir, { recursive: true });

  const header = ["firm", "title", "location", "geo", "daysAgo", "effectiveDate", "dateSource", "datePosted", "firstSeen", "ats", "url"];
  const toCsv = (rows: Row[]): string => {
    const lines = [header.join(",")];
    for (const j of rows) {
      lines.push([j.firm, j.title, j.location, j.geo, String(j.daysAgo), j.effective, j.dateSource, j.datePosted, j.firstSeen, j.ats, j.url].map(csvEscape).join(","));
    }
    return lines.join("\n");
  };

  const usFile = join(outDir, `recent_${days}d_US_${dateFolder}.csv`);
  const allFile = join(outDir, `recent_${days}d_all_${dateFolder}.csv`);
  const reviewFile = join(outDir, `recent_${days}d_location_unknown_${dateFolder}.csv`);
  writeFileSync(usFile, toCsv(us), "utf8");
  writeFileSync(allFile, toCsv(recent), "utf8");
  writeFileSync(reviewFile, toCsv(unknown), "utf8");

  // ---- Report ----
  console.log(`=== Recency filter — within ${days} days of ${today} (cutoff ${cutoff}) ===`);
  console.log(`Open roles: ${open.length}  →  within ${days}d: ${recent.length}`);
  const bySource = { posted: recent.filter((r) => r.dateSource === "posted").length, firstSeen: recent.filter((r) => r.dateSource === "firstSeen").length };
  console.log(`  date signal:  real posted date = ${bySource.posted}   |   firstSeen fallback = ${bySource.firstSeen}`);

  console.log(`\n=== US filter (heuristic) on the ${recent.length} recent roles ===`);
  console.log(`  US:                ${us.length}   <- deliverable`);
  console.log(`  Foreign:           ${foreign.length}   (excluded)`);
  console.log(`  Location-unknown:  ${unknown.length}   (review — mostly custom sites with no location field)`);

  const usByFirm: Record<string, number> = {};
  for (const r of us) usByFirm[r.firm] = (usByFirm[r.firm] ?? 0) + 1;
  console.log(`\nUS roles by firm:`);
  for (const f of Object.keys(usByFirm).sort((a, b) => usByFirm[b] - usByFirm[a])) {
    console.log(`  ${String(usByFirm[f]).padStart(4)}  ${f}`);
  }

  const unkByFirm: Record<string, number> = {};
  for (const r of unknown) unkByFirm[r.firm] = (unkByFirm[r.firm] ?? 0) + 1;
  if (unknown.length) {
    console.log(`\nLocation-unknown by firm (these need a location-capture fix or a firm-level region tag):`);
    for (const f of Object.keys(unkByFirm).sort((a, b) => unkByFirm[b] - unkByFirm[a])) {
      console.log(`  ${String(unkByFirm[f]).padStart(4)}  ${f}`);
    }
  }

  console.log(`\nWrote:`);
  console.log(`  ${usFile}   (${us.length} rows)`);
  console.log(`  ${reviewFile}   (${unknown.length} rows)`);
  console.log(`  ${allFile}   (${recent.length} rows, all 3 buckets w/ geo column)`);
}

main();
