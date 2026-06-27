/**
 * Lightweight direct-API adapters for ATS platforms the main pipeline doesn't
 * cover yet but that expose clean public JSON. Used by the architecture-firms
 * experiment. Each returns RawJob[] in the same shape as the repo's adapters.
 */
import { chromium } from "playwright";
import type { RawJob } from "../../types.js";
import { http } from "../../utils/http.js";

// ---------------------------------------------------------------------------
// Eightfold.ai  (Arcadis)
// URL: https://jobs.{company}.com/careers?domain={domain}&pid=...&query=...
// Public REST: https://{host}/api/apply/v2/jobs?domain={domain}&start=&num=
// ---------------------------------------------------------------------------
interface EightfoldPos {
  id?: string | number;
  name?: string;
  location?: string;
  canonicalPositionUrl?: string;
  t_create?: number;
}

export async function scrapeEightfold(url: string): Promise<RawJob[]> {
  const u = new URL(url);
  const host = u.host;
  const domain = u.searchParams.get("domain") ?? host.replace(/^jobs\./, "");

  const jobs: RawJob[] = [];
  const num = 50;
  let start = 0;
  let total = Infinity;

  for (let pageNo = 0; pageNo < 100 && start < total; pageNo += 1) {
    const endpoint =
      `https://${host}/api/apply/v2/jobs?domain=${encodeURIComponent(domain)}` +
      `&start=${start}&num=${num}&sort_by=relevance`;
    const res = await http.get<{ positions?: EightfoldPos[]; count?: number }>(endpoint, {
      headers: { Accept: "application/json" },
    });
    const positions = res.data?.positions ?? [];
    total = res.data?.count ?? positions.length;
    if (positions.length === 0) break;

    for (const p of positions) {
      if (!p.name) continue;
      jobs.push({
        title: p.name,
        url: p.canonicalPositionUrl ?? `https://${host}/careers?pid=${p.id}&domain=${domain}`,
        location: p.location ?? null,
        ats: "generic",
      });
    }

    start += num;
    if (positions.length < num) break;
  }

  return jobs;
}

// ---------------------------------------------------------------------------
// Oracle Cloud Recruiting (ORC / Fusion CX)  (Stantec)
// Apply URL: https://{host}/hcmUI/CandidateExperience/en/sites/{SITE}/job/{id}
// Public REST: /hcmRestApi/resources/latest/recruitingCEJobRequisitions
// ---------------------------------------------------------------------------
interface OracleReq {
  Id?: string;
  Title?: string;
  PrimaryLocation?: string;
  PrimaryLocationCountry?: string;
  PostedDate?: string;
}

/** Parse host + site from any Oracle CX URL (apply link or careers site URL). */
export function parseOracle(url: string): { host: string; site: string } | null {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/\/sites\/([^/]+)/i);
    const site = m?.[1] ?? "CX_1";
    if (!/oraclecloud\.com$/i.test(u.host)) return null;
    return { host: u.host, site };
  } catch {
    return null;
  }
}

export async function scrapeOracle(url: string): Promise<RawJob[]> {
  const parsed = parseOracle(url);
  if (!parsed) throw new Error(`Oracle: could not parse host/site from ${url}`);
  const { host, site } = parsed;

  const jobs: RawJob[] = [];
  const limit = 200;
  let offset = 0;

  for (let pageNo = 0; pageNo < 50; pageNo += 1) {
    const finder = `findReqs;siteNumber=${site},limit=${limit},offset=${offset},sortBy=POSTING_DATES_DESC`;
    const endpoint =
      `https://${host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions` +
      `?onlyData=true&expand=requisitionList.secondaryLocations,flexFieldsFacet.values&finder=${encodeURIComponent(finder)}`;

    const res = await http.get<{ items?: Array<{ requisitionList?: OracleReq[]; TotalJobsCount?: number }> }>(
      endpoint,
      { headers: { Accept: "application/json" } }
    );
    const list = res.data?.items?.[0]?.requisitionList ?? [];
    if (list.length === 0) break;

    for (const r of list) {
      if (!r.Title) continue;
      jobs.push({
        title: r.Title,
        url: r.Id
          ? `https://${host}/hcmUI/CandidateExperience/en/sites/${site}/job/${r.Id}`
          : url,
        location: r.PrimaryLocation ?? r.PrimaryLocationCountry ?? null,
        ats: "generic",
        datePosted: r.PostedDate ?? null,
      });
    }

    offset += limit;
    if (list.length < limit) break;
  }

  return jobs;
}

// ---------------------------------------------------------------------------
// DirectEmployers ".jobs" microsites backed by prod-search-api.jobsyn.org
// (Stantec, AECOM, HNTB). The search API rejects direct/replayed calls
// ("mismatched origin" / 403) — it validates a cookie + origin the page sets.
// So we load the page in a real browser and CAPTURE the page's own authenticated
// XHR responses, paginating by scrolling + clicking next until no new jobs.
// ---------------------------------------------------------------------------
interface JobsynJob {
  title_exact?: string;
  location_exact?: string;
  title_slug?: string;
  guid?: string;
  reqid?: string;
}

export async function scrapeJobsyn(url: string): Promise<RawJob[]> {
  const host = new URL(url).host;
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  });
  const page = await ctx.newPage();
  const byKey = new Map<string, RawJob>();
  let totalPages = 1;

  page.on("response", async (res) => {
    try {
      if (!/jobsyn|solr\/search|\/api\/v1/i.test(res.url())) return;
      const ct = (res.headers()["content-type"] ?? "").toLowerCase();
      if (!ct.includes("json")) return;
      const d: any = JSON.parse(await res.text());
      const pg = d.pagination ?? {};
      const tp = Number(pg.total_pages ?? pg.num_pages ?? pg.pages ?? 0);
      if (tp > totalPages) totalPages = tp;
      const jobs: JobsynJob[] = d.jobs ?? d.results ?? d.docs ?? [];
      for (const j of jobs) {
        const title = j.title_exact?.trim();
        if (!title) continue;
        const key = j.guid ?? j.reqid ?? `${title}|${j.location_exact ?? ""}`;
        if (byKey.has(key)) continue;
        const jobUrl =
          j.title_slug && j.guid
            ? `https://${host}/${j.title_slug}/${j.guid}/job/`
            : url;
        byKey.set(key, { title, url: jobUrl, location: j.location_exact ?? null, ats: "generic" });
      }
    } catch {
      /* ignore */
    }
  });

  const pageUrl = (n: number): string => {
    const u = new URL(url);
    u.searchParams.set("page", String(n));
    return u.toString();
  };

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(4000);

    // Navigate page-by-page (the SPA reads ?page=N and re-calls the search API,
    // which we capture in the response handler). Cap at 40 pages (~2000 jobs).
    const cap = Math.min(totalPages || 1, 40);
    for (let n = 2; n <= cap; n += 1) {
      const before = byKey.size;
      await page.goto(pageUrl(n), { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
      await page.waitForTimeout(2500);
      if (byKey.size === before) break; // no new jobs -> pagination not advancing
    }
  } finally {
    await ctx.close();
    await browser.close();
  }

  return Array.from(byKey.values());
}

// ---------------------------------------------------------------------------
// Workday — build the cxs JSON endpoint straight from the careers URL.
// URL: https://{tenant}.{wdN}.myworkdayjobs.com/[{locale}/]{SITE}
// API: https://{host}/wday/cxs/{tenant}/{SITE}/jobs   (POST, paginated)
// The repo's adapter only guesses External/Careers site names; real sites use
// custom names (genslercareers, HKSCareers, stv, KPF_Careers), so we derive the
// site from the URL path here.
// ---------------------------------------------------------------------------
export function buildWorkdayEndpoint(url: string): { host: string; tenant: string; endpoint: string } | null {
  try {
    const u = new URL(url);
    const m = u.host.match(/^([a-z0-9-]+)\.wd\d+\.myworkdayjobs\.com$/i);
    if (!m) return null;
    const tenant = m[1];
    const segs = u.pathname.split("/").filter(Boolean).filter((s) => !/^[a-z]{2}-[A-Z]{2}$/.test(s));
    const site = segs[segs.length - 1];
    if (!site) return null;
    return { host: u.host, tenant, endpoint: `https://${u.host}/wday/cxs/${tenant}/${site}/jobs` };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// UltiPro / UKG Recruiting  (Perkins & Will, WATG)
// URL: https://recruiting2.ultipro.com/{TENANT}/JobBoard/{BOARD_GUID}/...
// ---------------------------------------------------------------------------
interface UltiProOpportunity {
  Id?: number | string;
  Title?: string;
  RequisitionNumber?: string;
  Locations?: Array<{
    LocalizedDescription?: string;
    Address?: { City?: string; State?: { Name?: string }; Country?: { Name?: string } };
  }>;
}
interface UltiProResponse {
  opportunities?: UltiProOpportunity[];
  totalCount?: number;
}

function parseUltiPro(url: string): { host: string; tenant: string; board: string } | null {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean); // [TENANT, "JobBoard", BOARD_GUID, ...]
    const tenant = parts[0];
    const boardIdx = parts.findIndex((p) => p.toLowerCase() === "jobboard");
    const board = boardIdx >= 0 ? parts[boardIdx + 1] : undefined;
    if (!tenant || !board) return null;
    return { host: u.host, tenant, board };
  } catch {
    return null;
  }
}

function ultiProLocation(o: UltiProOpportunity): string | null {
  const loc = o.Locations?.[0];
  if (!loc) return null;
  if (loc.LocalizedDescription) return loc.LocalizedDescription;
  const a = loc.Address;
  if (!a) return null;
  return [a.City, a.State?.Name, a.Country?.Name].filter(Boolean).join(", ") || null;
}

export async function scrapeUltiPro(url: string): Promise<RawJob[]> {
  const parsed = parseUltiPro(url);
  if (!parsed) throw new Error(`UltiPro: could not parse tenant/board from ${url}`);
  const { host, tenant, board } = parsed;
  const endpoint = `https://${host}/${tenant}/JobBoard/${board}/JobBoardView/LoadSearchResults`;

  const jobs: RawJob[] = [];
  const top = 50;
  let skip = 0;

  for (let page = 0; page < 100; page += 1) {
    const body = {
      opportunitySearch: {
        Top: top,
        Skip: skip,
        QueryString: "",
        OrderBy: [{ Value: "postedDateDesc", PropertyName: "PostedDate", Ascending: false }],
        Filters: [],
      },
      matchCriteria: {
        PreferredJobs: [], Educations: [], LicenseAndCertifications: [], Skills: [],
        JobInformationLanguages: [], Languages: [], Certifications: [], Locations: [],
        JobTitles: [], CompanyNames: [], CategoryNames: [], Industries: [],
      },
    };

    const res = await http.post<UltiProResponse>(endpoint, body, {
      headers: { "Content-Type": "application/json" },
    });
    const opps = res.data?.opportunities ?? [];
    if (opps.length === 0) break;

    for (const o of opps) {
      jobs.push({
        title: o.Title ?? null,
        url: o.Id != null
          ? `https://${host}/${tenant}/JobBoard/${board}/OpportunityDetail?opportunityId=${o.Id}`
          : url,
        location: ultiProLocation(o),
        ats: "generic",
      });
    }

    skip += top;
    if (opps.length < top) break;
  }

  return jobs;
}

// ---------------------------------------------------------------------------
// BambooHR  (CetraRuddy)
// URL: https://{TENANT}.bamboohr.com/careers  ->  /careers/list returns JSON
// ---------------------------------------------------------------------------
interface BambooJob {
  id?: number | string;
  jobOpeningName?: string;
  location?: { city?: string; state?: string; country?: string } | null;
  locationLabel?: string | null;
  departmentLabel?: string | null;
  employmentStatusLabel?: string | null;
}
interface BambooResponse {
  result?: BambooJob[];
}

function bambooLocation(j: BambooJob): string | null {
  if (j.locationLabel) return j.locationLabel;
  const l = j.location;
  if (!l) return null;
  return [l.city, l.state, l.country].filter(Boolean).join(", ") || null;
}

export async function scrapeBambooHr(url: string): Promise<RawJob[]> {
  const u = new URL(url);
  const tenant = u.host.split(".")[0];
  const endpoint = `https://${u.host}/careers/list`;

  const res = await http.get<BambooResponse>(endpoint, {
    headers: { Accept: "application/json" },
  });
  const result = res.data?.result ?? [];

  return result.map((j) => ({
    title: j.jobOpeningName ?? null,
    url: j.id != null ? `https://${tenant}.bamboohr.com/careers/${j.id}` : url,
    location: bambooLocation(j),
    ats: "generic" as const,
  }));
}
