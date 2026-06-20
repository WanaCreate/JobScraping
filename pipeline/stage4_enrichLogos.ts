/**
 * Stage 4: Enrich CSV rows with company logos, then shuffle rows so
 * same-company jobs aren't adjacent.
 *
 * - Resolves logos via Google Favicon API (https://www.google.com/s2/favicons?domain=X&sz=256)
 * - Maintains a persistent logo_cache.json so each company is resolved only once
 * - Handles job-board websites, career subdomain stripping, and name-based domain guessing
 * - Shuffles output rows so consecutive rows don't share the same company logo
 *
 * Usage:
 *   npx tsx pipeline/stage4_enrichLogos.ts [options]
 *
 * Options:
 *   --input <path>    CSV input  (default: outputs/api-ready/latest/results_enriched_api_gpt.csv)
 *   --output <path>   CSV output (default: overwrites input)
 *   --cache <path>    Logo cache JSON (default: logo_cache.json)
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import https from "node:https";
import http from "node:http";
import crypto from "node:crypto";

// ─── Types ────────────────────────────────────────────────────────

interface CsvJobRow {
  title: string;
  description: string;
  jobType: string;
  deadline: string;
  keywords: string;
  skills: string;
  jobLink: string;
  hiringTeam: string;
  workType: string;
  workEmail: string;
  createdAt: string;
  numberOfPositions: string;
  company: string;
  companyWebsite: string;
  companyLogo: string;
  companyEmail: string;
  locationName: string;
  formattedAddress: string;
  city: string;
  state: string;
  country: string;
  latitude: string;
  longitude: string;
  salaryMin: string;
  salaryMax: string;
  salaryCurrency: string;
  salaryPeriod: string;
}

interface CacheEntry {
  domain: string;
  logoUrl: string;
  source: string;
}

type LogoCache = Record<string, CacheEntry>;

// ─── Constants ───────────────────────────────────────────────────

const FAVICON_URL = "https://www.google.com/s2/favicons?domain={domain}&sz=256";
const MIN_LOGO_BYTES = 100;
const MAX_LOGO_BYTES = 256 * 1024;

// Fallback avatar for companies with no resolvable real logo. DiceBear
// identicon — free, no API key, SVG, deterministic per company name (same
// company always gets the same avatar).
const DEFAULT_AVATAR_BASE = "https://api.dicebear.com/9.x/identicon/svg";

// SHA-256 of Google's generic "globe" favicon — the placeholder it serves for
// any domain with no real icon (confirmed: 726 bytes, final HTTP 404). It is
// already excluded by the non-200 reject in fetchBytes, but we also screen by
// content hash in case Google ever returns the globe with a 200. The runtime
// capture below augments this set so it self-heals if the bytes change.
const KNOWN_GLOBE_SHA256 = new Set<string>([
  "59bfe9bc385ad69f50793ce4a53397316d7a875a7148a63c16df9b674c6cda64",
]);

// Registrable ATS / job-board domains. isJobBoardDomain matches these as a
// suffix, so every subdomain is covered (e.g. greenhouse.io catches
// boards.greenhouse.io, job-boards.greenhouse.io, job-boards.eu.greenhouse.io).
// Resolving a logo for any of these would yield the ATS's own favicon, not the
// hiring company's — so we skip the website and guess from the company name.
const JOB_BOARD_DOMAINS = new Set([
  "amazon.jobs", "greenhouse.io", "lever.co", "smartrecruiters.com",
  "ashbyhq.com", "workable.com", "myworkdayjobs.com", "myworkdaysite.com",
  "icims.com", "jobvite.com", "ultipro.com", "schooljobs.com",
  "paycomonline.net", "bamboohr.com", "breezy.hr", "recruitee.com",
  "teamtailor.com", "applytojob.com", "pinpointhq.com", "jobvite.com",
]);

const CAREER_SUBDOMAINS = new Set([
  "careers", "jobs", "career", "job", "hire", "hiring",
]);

const DOMAIN_OVERRIDES: Record<string, string> = {
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
  "lucia gonz\u00e1lez": "",
  "northwest missouri state university": "nwmissouri.edu",
  "contrast ux": "contrastux.com",
  "fort robotics": "fortrobotics.com",
  "mrm": "mrm.com",
};

// ─── CLI ─────────────────────────────────────────────────────────

function getArg(flag: string): string | null {
  const idx = process.argv.indexOf(flag);
  if (idx < 0) return null;
  const value = process.argv[idx + 1];
  return value && !value.startsWith("--") ? value : null;
}

// ─── CSV Parsing (same as other stages) ──────────────────────────

const CSV_HEADERS: (keyof CsvJobRow)[] = [
  "title", "description", "jobType", "deadline", "keywords", "skills",
  "jobLink", "hiringTeam", "workType", "workEmail", "createdAt",
  "numberOfPositions", "company", "companyWebsite", "companyLogo", "companyEmail",
  "locationName", "formattedAddress", "city", "state", "country",
  "latitude", "longitude", "salaryMin", "salaryMax", "salaryCurrency", "salaryPeriod",
];

function parseCsvFields(content: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  let i = 0;

  while (i < content.length) {
    const char = content[i];
    if (inQuotes) {
      if (char === '"') {
        if (i + 1 < content.length && content[i + 1] === '"') {
          current += '"';
          i += 2;
        } else {
          inQuotes = false;
          i++;
        }
      } else {
        current += char;
        i++;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
        i++;
      } else if (char === ",") {
        fields.push(current);
        current = "";
        i++;
      } else if (char === "\n" || (char === "\r" && content[i + 1] === "\n")) {
        fields.push(current);
        current = "";
        if (char === "\r") i += 2;
        else i++;
      } else if (char === "\r") {
        fields.push(current);
        current = "";
        i++;
      } else {
        current += char;
        i++;
      }
    }
  }
  if (current || fields.length > 0) {
    fields.push(current);
  }
  return fields;
}

function parseCsvContent(content: string): CsvJobRow[] {
  const rows: CsvJobRow[] = [];
  const fields = parseCsvFields(content);
  const colCount = CSV_HEADERS.length;

  for (let i = colCount; i + colCount <= fields.length; i += colCount) {
    const row: Record<string, string> = {};
    for (let c = 0; c < colCount; c++) {
      row[CSV_HEADERS[c]] = (fields[i + c] ?? "").trim();
    }
    rows.push(row as unknown as CsvJobRow);
  }
  return rows;
}

function csvEscape(value: string): string {
  if (value.includes(",") || value.includes("\n") || value.includes('"')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function rowToCsv(row: CsvJobRow): string {
  return CSV_HEADERS.map(h => csvEscape(row[h] ?? "")).join(",");
}

function allRowsToCsv(rows: CsvJobRow[]): string {
  const header = CSV_HEADERS.join(",");
  return [header, ...rows.map(r => rowToCsv(r))].join("\n");
}

// ─── Cache ───────────────────────────────────────────────────────

async function loadCache(cachePath: string): Promise<LogoCache> {
  try {
    const raw = await readFile(cachePath, "utf8");
    return JSON.parse(raw) as LogoCache;
  } catch {
    return {};
  }
}

async function saveCache(cachePath: string, cache: LogoCache): Promise<void> {
  await writeFile(cachePath, JSON.stringify(cache, null, 2), "utf8");
}

// ─── Domain helpers ──────────────────────────────────────────────

function extractDomainFromUrl(url: string): string {
  if (!url) return "";
  try {
    const full = url.includes("://") ? url : `http://${url}`;
    const parsed = new URL(full);
    let host = parsed.hostname || "";
    if (host.startsWith("www.")) host = host.slice(4);
    return host.toLowerCase();
  } catch {
    return "";
  }
}

function isJobBoardDomain(domain: string): boolean {
  for (const jb of JOB_BOARD_DOMAINS) {
    if (domain === jb || domain.endsWith(`.${jb}`)) return true;
  }
  return false;
}

function stripCareerSubdomain(domain: string): string {
  const parts = domain.split(".");
  if (parts.length > 2 && CAREER_SUBDOMAINS.has(parts[0])) {
    return parts.slice(1).join(".");
  }
  return domain;
}

function guessDomains(companyName: string): string[] {
  const lower = companyName.toLowerCase().trim();
  if (lower in DOMAIN_OVERRIDES) {
    const override = DOMAIN_OVERRIDES[lower];
    return override ? [override] : [];
  }

  let cleaned = lower
    .replace(/\s*(inc\.?|llc|ltd\.?|limited|corp\.?|corporation|gmbh|pvt\.?|private|software|services|athletics|retail|uk|spa)\s*$/i, "")
    .replace(/,\s*$/, "")
    .trim();
  cleaned = cleaned.replace(/[^a-z0-9\s]/g, "").trim().replace(/\s+/g, "");

  if (!cleaned || cleaned.length < 2) return [];
  return [`${cleaned}.com`, `${cleaned}.io`, `${cleaned}.co`];
}

// ─── Logo validation ─────────────────────────────────────────────

function fetchBytes(url: string, maxBytes: number, timeoutMs = 5000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? https : http;
    const req = mod.get(url, { timeout: timeoutMs }, (res) => {
      if (res.statusCode && (res.statusCode >= 300 && res.statusCode < 400) && res.headers.location) {
        fetchBytes(res.headers.location, maxBytes, timeoutMs).then(resolve, reject);
        res.resume();
        return;
      }
      if (!res.statusCode || res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const contentType = res.headers["content-type"] || "";
      if (!contentType.includes("image")) {
        res.resume();
        reject(new Error(`Not an image: ${contentType}`));
        return;
      }
      const chunks: Buffer[] = [];
      let total = 0;
      res.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
        total += chunk.length;
        if (total >= maxBytes) {
          res.destroy();
        }
      });
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("close", () => resolve(Buffer.concat(chunks)));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
  });
}

function sha256(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

async function validateLogoUrl(url: string): Promise<string | null> {
  try {
    const buf = await fetchBytes(url, MAX_LOGO_BYTES);
    if (buf.length < MIN_LOGO_BYTES) return null;
    // Reject Google's generic globe placeholder by content hash (identical
    // bytes for every domain with no real favicon).
    if (KNOWN_GLOBE_SHA256.has(sha256(buf))) return null;
    return url;
  } catch {
    return null;
  }
}

/**
 * Fetch what Google serves for a guaranteed-nonexistent domain — its generic
 * globe — following redirects and tolerating the 404 it ends on. Resolves to
 * the body buffer regardless of status (or null on transport failure).
 */
function fetchFaviconRaw(url: string, timeoutMs = 8000, hops = 0): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const mod = url.startsWith("https") ? https : http;
    const req = mod.get(url, { timeout: timeoutMs }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops < 5) {
        res.resume();
        fetchFaviconRaw(res.headers.location, timeoutMs, hops + 1).then(resolve);
        return;
      }
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("close", () => resolve(Buffer.concat(chunks)));
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
  });
}

/**
 * Augment KNOWN_GLOBE_SHA256 with the live globe signature so screening
 * self-heals if Google changes the placeholder bytes. Best-effort: on any
 * failure the hardcoded hash still covers the common case.
 */
async function captureDefaultFaviconSig(): Promise<void> {
  for (const domain of ["asdkfjqwoeiruzxcv12345.invalid-xyz.com", "no-such-domain-zzqq1734xy.com"]) {
    const buf = await fetchFaviconRaw(FAVICON_URL.replace("{domain}", domain));
    if (buf && buf.length >= MIN_LOGO_BYTES) {
      const hash = sha256(buf);
      const known = KNOWN_GLOBE_SHA256.has(hash);
      KNOWN_GLOBE_SHA256.add(hash);
      console.log(`  Globe-favicon signature: ${buf.length} bytes ${hash.slice(0, 12)}… ${known ? "(matches hardcoded)" : "(new — added)"}`);
      return;
    }
  }
  console.log(`  Globe-favicon: live capture failed; using hardcoded hash only`);
}

function defaultAvatarUrl(company: string): string {
  const seed = encodeURIComponent(company.trim());
  return `${DEFAULT_AVATAR_BASE}?seed=${seed}`;
}

async function resolveLogoForDomain(domain: string): Promise<string | null> {
  if (!domain) return null;
  const url = FAVICON_URL.replace("{domain}", domain);
  return validateLogoUrl(url);
}

// ─── Logo resolution ─────────────────────────────────────────────

async function resolveLogoForCompany(
  company: string,
  website: string,
  cache: LogoCache,
): Promise<string | null> {
  const cacheKey = company.toLowerCase().trim();

  if (cacheKey in cache) {
    return cache[cacheKey].logoUrl || null;
  }

  process.stdout.write(`  Resolving: ${company}`);

  // Try domain from website
  let domain = extractDomainFromUrl(website);
  if (domain && isJobBoardDomain(domain)) domain = "";
  if (domain) domain = stripCareerSubdomain(domain);

  if (domain) {
    const logoUrl = await resolveLogoForDomain(domain);
    if (logoUrl) {
      console.log(` -> ${domain} [from website]`);
      cache[cacheKey] = { domain, logoUrl, source: "website" };
      return logoUrl;
    }
  }

  // Guess domains from company name
  const guesses = guessDomains(company);
  for (const guess of guesses) {
    const logoUrl = await resolveLogoForDomain(guess);
    if (logoUrl) {
      console.log(` -> ${guess} [guessed]`);
      cache[cacheKey] = { domain: guess, logoUrl, source: "guessed" };
      return logoUrl;
    }
  }

  console.log(` -> UNRESOLVED`);
  cache[cacheKey] = { domain: "", logoUrl: "", source: "unresolved" };
  return null;
}

// ─── Shuffle ─────────────────────────────────────────────────────

function shuffleRows(rows: CsvJobRow[]): CsvJobRow[] {
  const total = rows.length;
  if (total === 0) return [];

  // Group by company
  const groups = new Map<string, CsvJobRow[]>();
  const noCompany: CsvJobRow[] = [];

  for (const row of rows) {
    const name = row.company.trim().toLowerCase();
    if (name) {
      const existing = groups.get(name);
      if (existing) existing.push(row);
      else groups.set(name, [row]);
    } else {
      noCompany.push(row);
    }
  }

  // Sort groups largest-first
  const sortedGroups = [...groups.values()].sort((a, b) => b.length - a.length);

  // Slot-based distribution: place each group at evenly-spaced positions
  const result: (CsvJobRow | null)[] = new Array(total).fill(null);
  const filled: boolean[] = new Array(total).fill(false);

  for (const group of sortedGroups) {
    const count = group.length;
    const spacing = total / count;
    for (let idx = 0; idx < count; idx++) {
      const ideal = Math.floor(idx * spacing + spacing / 2) % total;
      let pos = ideal;
      let searched = 0;
      while (filled[pos] && searched < total) {
        pos = (pos + 1) % total;
        searched++;
      }
      if (!filled[pos]) {
        result[pos] = group[idx];
        filled[pos] = true;
      }
    }
  }

  // Place no-company rows in remaining slots
  for (const row of noCompany) {
    for (let i = 0; i < total; i++) {
      if (!filled[i]) {
        result[i] = row;
        filled[i] = true;
        break;
      }
    }
  }

  return result.filter((r): r is CsvJobRow => r !== null);
}

// ─── Main ────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const inputPath = path.resolve(
    process.cwd(),
    getArg("--input") ?? "outputs/api-ready/latest/results_enriched_api_claude.csv",
  );
  const outputPath = path.resolve(
    process.cwd(),
    getArg("--output") ?? inputPath,
  );
  const cachePath = path.resolve(
    process.cwd(),
    getArg("--cache") ?? "logo_cache.json",
  );

  console.log(`[STAGE 4] Logo enrichment`);
  console.log(`  Input:  ${inputPath}`);
  console.log(`  Output: ${outputPath}`);
  console.log(`  Cache:  ${cachePath}`);

  const csvContent = await readFile(inputPath, "utf8");
  let rows = parseCsvContent(csvContent);
  console.log(`  Parsed ${rows.length} rows`);

  // Extract unique companies
  const companies = new Map<string, string>();
  for (const row of rows) {
    const name = row.company.trim();
    const website = row.companyWebsite.trim();
    if (name && !companies.has(name)) {
      companies.set(name, website);
    }
  }
  console.log(`  Found ${companies.size} unique companies`);

  // Load cache and resolve
  const cache = await loadCache(cachePath);
  const cachedCount = [...companies.keys()].filter(c => c.toLowerCase().trim() in cache).length;
  console.log(`  Already cached: ${cachedCount}/${companies.size}\n`);

  await captureDefaultFaviconSig();

  let resolved = 0;
  let unresolved = 0;
  for (const [name, website] of companies) {
    const logoUrl = await resolveLogoForCompany(name, website, cache);
    if (logoUrl) resolved++;
    else unresolved++;
  }

  await saveCache(cachePath, cache);

  console.log(`\n  Resolved: ${resolved}/${companies.size}`);
  console.log(`  Unresolved: ${unresolved}/${companies.size}`);

  if (unresolved > 0) {
    console.log(`\n  Unresolved companies:`);
    for (const name of companies.keys()) {
      const entry = cache[name.toLowerCase().trim()];
      if (!entry?.logoUrl) console.log(`    - ${name}`);
    }
  }

  // Apply logos to rows; fall back to a deterministic identicon avatar when a
  // company has no resolvable real logo.
  let updated = 0;
  let avatars = 0;
  for (const row of rows) {
    const name = row.company.trim();
    if (!name || row.companyLogo.trim()) continue;
    const entry = cache[name.toLowerCase().trim()];
    if (entry?.logoUrl) {
      row.companyLogo = entry.logoUrl;
      updated++;
    } else {
      row.companyLogo = defaultAvatarUrl(name);
      avatars++;
    }
  }
  console.log(`\n  Updated ${updated} rows with real logos`);
  console.log(`  Filled ${avatars} rows with fallback identicon avatars`);

  // Shuffle
  rows = shuffleRows(rows);
  console.log(`  Shuffled rows to spread companies apart`);

  // Write output
  const outputDir = path.dirname(outputPath);
  await mkdir(outputDir, { recursive: true });
  await writeFile(outputPath, allRowsToCsv(rows), "utf8");
  console.log(`  Written to: ${outputPath}`);
}

const directRunHref = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === directRunHref) {
  main().catch((error) => {
    console.error("[FATAL]", error);
    process.exit(1);
  });
}
