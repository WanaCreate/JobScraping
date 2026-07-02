/** Shared IO helpers for the weekly pipeline stages. */
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** experiments/architecture-firms (parent of weekly/) */
export const EXP_DIR = join(__dirname, "..");
/** weekly outputs live alongside the tracker's, under output/weekly/<date>/ */
export const WEEKLY_OUTPUT_DIR = join(EXP_DIR, "output", "weekly");

export function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
export function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

/** "June30-2026" style folder name for a Date. */
export function dateFolderName(d: Date): string {
  return `${d.toLocaleString("en-US", { month: "long" })}${d.getDate()}-${d.getFullYear()}`;
}

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

export function writeJson(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data, null, 2), "utf8");
}

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function csvEscape(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** Build a CSV from an ordered header + a row->cells mapper. */
export function toCsv<T>(rows: T[], header: string[], cells: (row: T) => (string | number)[]): string {
  const lines = [header.join(",")];
  for (const r of rows) lines.push(cells(r).map((c) => csvEscape(String(c ?? ""))).join(","));
  return lines.join("\n");
}

/** True when this module's importer is the directly-executed entrypoint. */
export function isMain(importMetaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fileURLToPath(importMetaUrl) === resolve(entry);
  } catch {
    return false;
  }
}
