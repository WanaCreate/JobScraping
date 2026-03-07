import { scrapeAmazon } from "../adapters/amazon.js";
import { scrapeAshby } from "../adapters/ashby.js";
import { scrapeGenericHtmlCrawler } from "../adapters/genericHtmlCrawler.js";
import { scrapeGenericPlaywright } from "../adapters/genericPlaywright.js";
import { scrapeGreenhouse } from "../adapters/greenhouse.js";
import { scrapeIcims } from "../adapters/icims.js";
import { scrapeLever } from "../adapters/lever.js";
import { scrapeSmartRecruiters } from "../adapters/smartrecruiters.js";
import { scrapeWorkday } from "../adapters/workday.js";
import { detectATS } from "../ats/detectATS.js";
import { extractTenant } from "../ats/extractTenant.js";
import { filterCreativeJobs } from "../filters/creativeFilter.js";
import { fetchPage } from "../utils/http.js";
import { isLikelyJobEntryLoose, isLikelyJobPosting } from "../utils/jobHeuristics.js";
import { logError, logInfo, logWarn } from "../utils/logger.js";
import { normalizeJobs } from "../utils/normalize.js";
function inferTenantFromJobUrls(ats, jobs) {
    for (const job of jobs) {
        const url = job.url ?? "";
        if (!url)
            continue;
        if (ats === "greenhouse") {
            const match = url.match(/(?:job-boards|boards)\.greenhouse\.io\/([a-z0-9_-]+)/i);
            if (match?.[1])
                return match[1];
        }
        if (ats === "lever") {
            const match = url.match(/jobs\.lever\.co\/([a-z0-9_-]+)/i);
            if (match?.[1])
                return match[1];
        }
        if (ats === "smartrecruiters") {
            const match = url.match(/jobs\.smartrecruiters\.com\/([a-z0-9_-]+)/i);
            if (match?.[1])
                return match[1];
        }
        if (ats === "workday") {
            const match = url.match(/\/wday\/cxs\/([a-z0-9_-]+)\//i);
            if (match?.[1])
                return match[1];
        }
        if (ats === "icims") {
            const match = url.match(/\/\/([a-z0-9-]+)\.icims\.com/i);
            if (match?.[1])
                return match[1];
        }
        if (ats === "ashby") {
            const match = url.match(/jobs\.ashbyhq\.com\/([a-z0-9_-]+)/i);
            if (match?.[1])
                return match[1];
        }
    }
    return null;
}
async function extractViaAdapter(params) {
    const { ats, sourceUrl, tenant, endpoints } = params;
    switch (ats) {
        case "greenhouse":
            return tenant ? scrapeGreenhouse(tenant) : [];
        case "lever":
            return tenant ? scrapeLever(tenant) : [];
        case "workday":
            return scrapeWorkday({ sourceUrl, tenant, endpoints });
        case "smartrecruiters":
            return tenant ? scrapeSmartRecruiters(tenant) : [];
        case "icims":
            return scrapeIcims({ tenant, endpoints });
        case "ashby":
            return tenant ? scrapeAshby(tenant) : [];
        case "amazon":
            return scrapeAmazon(sourceUrl);
        default:
            return [];
    }
}
export async function scrapeCareers(sourceUrl) {
    let ats = "generic";
    let tenant = null;
    let html = "";
    let finalUrl = sourceUrl;
    try {
        let tenantInfo = { tenant: null, metadata: {}, endpoints: [] };
        try {
            const fetched = await fetchPage(sourceUrl);
            html = fetched.html;
            finalUrl = fetched.finalUrl;
            ats = detectATS(html, finalUrl);
            tenantInfo = extractTenant(html, finalUrl, ats);
            tenant = tenantInfo.tenant;
        }
        catch (error) {
            logWarn("Initial HTTP fetch failed; continuing with generic fallbacks", {
                source: sourceUrl,
                reason: error instanceof Error ? error.message : String(error)
            });
        }
        logInfo("Detected ATS", { source: sourceUrl, ats, tenant });
        let jobs = [];
        const fallbackAts = ats === "generic" ? "generic" : ats;
        let adapterJobsFound = false;
        if (ats !== "generic") {
            try {
                jobs = await extractViaAdapter({
                    ats,
                    sourceUrl: finalUrl,
                    tenant,
                    endpoints: tenantInfo.endpoints
                });
                adapterJobsFound = jobs.length > 0;
                logInfo("Adapter extraction completed", { source: sourceUrl, ats, count: jobs.length });
            }
            catch (error) {
                logWarn("Adapter extraction failed; falling back to generic extractors", {
                    source: sourceUrl,
                    ats,
                    reason: error instanceof Error ? error.message : String(error)
                });
            }
        }
        if (jobs.length === 0) {
            try {
                const htmlFallback = await scrapeGenericHtmlCrawler({
                    sourceUrl,
                    initialHtml: html || undefined,
                    initialFinalUrl: finalUrl,
                    maxPages: ats === "phenom" ? 14 : 10
                });
                jobs = htmlFallback.jobs.map((job) => ({
                    ...job,
                    ats: fallbackAts
                }));
                logInfo("HTML fallback extraction completed", {
                    source: sourceUrl,
                    fallbackCount: jobs.length,
                    pagesVisited: htmlFallback.discoveredPages.length
                });
            }
            catch (error) {
                logWarn("HTML fallback extraction failed", {
                    source: sourceUrl,
                    reason: error instanceof Error ? error.message : String(error)
                });
            }
        }
        const trueJobCountAfterHtml = jobs.filter((job) => isLikelyJobPosting(job)).length;
        if (jobs.length === 0 || trueJobCountAfterHtml === 0) {
            const seedUrls = [];
            if (finalUrl !== sourceUrl)
                seedUrls.push(finalUrl);
            try {
                const baseJobsPath = new URL("/jobs", finalUrl).toString();
                seedUrls.push(baseJobsPath);
            }
            catch {
                // no-op
            }
            const playwrightJobs = (await scrapeGenericPlaywright(sourceUrl, { seedUrls, maxPages: 5 })).map((job) => ({
                ...job,
                ats: fallbackAts
            }));
            jobs = [...jobs, ...playwrightJobs];
            logInfo("Playwright fallback extraction completed", {
                source: sourceUrl,
                fallbackCount: playwrightJobs.length
            });
        }
        if (!tenant) {
            tenant = inferTenantFromJobUrls(ats, jobs);
        }
        const strictJobs = jobs.filter((job) => isLikelyJobPosting(job));
        const looseJobs = jobs.filter((job) => isLikelyJobEntryLoose(job));
        const selectedJobs = adapterJobsFound ? jobs : strictJobs.length > 0 ? strictJobs : looseJobs.length > 0 ? looseJobs : jobs;
        const normalized = normalizeJobs(selectedJobs, sourceUrl, ats);
        const creativeJobs = filterCreativeJobs(normalized);
        return {
            source: sourceUrl,
            ats,
            tenant,
            jobs_count: normalized.length,
            creative_jobs: creativeJobs
        };
    }
    catch (error) {
        logError("Failed to scrape source", {
            source: sourceUrl,
            reason: error instanceof Error ? error.message : String(error)
        });
        return {
            source: sourceUrl,
            ats,
            tenant,
            jobs_count: 0,
            creative_jobs: []
        };
    }
}
