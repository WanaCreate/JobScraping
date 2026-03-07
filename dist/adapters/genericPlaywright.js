import { chromium } from "playwright";
import { extractJobsFromJson } from "../utils/extractJobsFromJson.js";
import { safeAbsoluteUrl } from "../utils/http.js";
const URL_HINT = /\/(job|jobs|career|careers|position|positions|opening|openings)\b/i;
const TITLE_HINT = /\b(job|role|position|designer|engineer|manager|specialist|lead|director|artist|writer)\b/i;
const PAGE_HINT = /(\/(jobs|career|careers|search|open-positions|opportunit)\b|\/c\/[a-z0-9-]+-jobs\b|work-with-us|join-us)/i;
const NOISE_TITLE = /\b(home|about|learn more|privacy|terms|cookie|login|sign in|register|filter|location|all jobs|search|faq)\b/i;
function baseDomain(hostname) {
    const host = hostname.toLowerCase().replace(/^www\./, "");
    const parts = host.split(".").filter(Boolean);
    if (parts.length <= 2)
        return host;
    const tld = parts[parts.length - 1] ?? "";
    const sld = parts[parts.length - 2] ?? "";
    const isCcTld = tld.length === 2;
    const isSecondLevelCc = isCcTld && /^(co|com|org|net|gov|ac|edu)$/i.test(sld);
    const keep = isSecondLevelCc ? 3 : 2;
    return parts.slice(-keep).join(".");
}
function isKnownAtsHost(hostname) {
    return (/(greenhouse\.io|lever\.co|smartrecruiters\.com|myworkdayjobs\.com|icims\.com|amazon\.jobs|ashbyhq\.com|phenompeople\.com)$/i.test(hostname) || hostname.toLowerCase().includes(".phenompeople.com"));
}
function isAllowedCrawlUrl(candidateUrl, rootUrl) {
    try {
        const candidateHost = new URL(candidateUrl).hostname.toLowerCase();
        const rootHost = new URL(rootUrl).hostname.toLowerCase();
        if (candidateHost === rootHost)
            return true;
        if (isKnownAtsHost(candidateHost))
            return true;
        const rootBase = baseDomain(rootHost);
        const sameCompany = candidateHost === rootBase || candidateHost.endsWith(`.${rootBase}`);
        if (!sameCompany)
            return false;
        if (/^(jobs|careers)\./i.test(candidateHost))
            return true;
        return false;
    }
    catch {
        return false;
    }
}
async function gotoWithRetries(page, url) {
    const waitUntilOptions = [
        "domcontentloaded",
        "load"
    ];
    for (const waitUntil of waitUntilOptions) {
        try {
            await page.goto(url, { waitUntil, timeout: 90000 });
            return true;
        }
        catch {
            continue;
        }
    }
    return false;
}
function uniq(items) {
    return Array.from(new Set(items.filter(Boolean)));
}
export async function scrapeGenericPlaywright(url, options) {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        ignoreHTTPSErrors: true,
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
    });
    const page = await context.newPage();
    const jobs = [];
    const candidatePages = [];
    const visited = new Set();
    try {
        await page.route("**/*", (route) => {
            const request = route.request();
            const type = request.resourceType();
            if (type === "image" || type === "font" || type === "media") {
                route.abort().catch(() => { });
                return;
            }
            route.continue().catch(() => { });
        });
        page.on("response", async (response) => {
            try {
                const contentType = (response.headers()["content-type"] ?? "").toLowerCase();
                const responseUrl = response.url();
                if (!contentType.includes("json") && !responseUrl.includes(".json") && !responseUrl.includes("/api/"))
                    return;
                if (response.status() >= 400)
                    return;
                const body = await response.text();
                if (!body || body.length < 2 || body.length > 2_000_000)
                    return;
                const parsed = JSON.parse(body);
                jobs.push(...extractJobsFromJson(parsed, responseUrl));
            }
            catch {
                return;
            }
        });
        candidatePages.push(url);
        if (options?.seedUrls?.length)
            candidatePages.push(...options.seedUrls);
        const maxPages = options?.maxPages ?? 5;
        const queue = uniq(candidatePages);
        for (let index = 0; index < queue.length; index += 1) {
            const target = queue[index];
            if (visited.size >= maxPages)
                break;
            if (visited.has(target))
                continue;
            visited.add(target);
            const didNavigate = await gotoWithRetries(page, target);
            if (!didNavigate)
                continue;
            try {
                await page.waitForTimeout(2000);
                const pageUrl = page.url();
                const anchors = await page.$$eval("a[href]", (elements) => elements.map((anchor) => ({
                    title: (anchor.textContent || "").replace(/\s+/g, " ").trim(),
                    href: anchor.getAttribute("href") || ""
                })));
                for (const anchor of anchors) {
                    const title = anchor.title.trim();
                    const href = anchor.href.trim();
                    if (!href)
                        continue;
                    const absolute = safeAbsoluteUrl(href, pageUrl);
                    if (!absolute)
                        continue;
                    if (PAGE_HINT.test(absolute) && isAllowedCrawlUrl(absolute, url) && !visited.has(absolute)) {
                        if (!queue.includes(absolute))
                            queue.push(absolute);
                    }
                    if (!title || title.length < 4 || title.length > 150)
                        continue;
                    if (NOISE_TITLE.test(title))
                        continue;
                    if (!URL_HINT.test(absolute) && !TITLE_HINT.test(title))
                        continue;
                    jobs.push({
                        title,
                        url: absolute,
                        location: null,
                        ats: "generic"
                    });
                }
                const embeddedJson = await page.$$eval("script[type='application/ld+json'], script#__NEXT_DATA__", (elements) => elements.map((element) => element.textContent || "").filter(Boolean));
                for (const jsonText of embeddedJson) {
                    try {
                        const parsed = JSON.parse(jsonText);
                        jobs.push(...extractJobsFromJson(parsed, pageUrl));
                    }
                    catch {
                        continue;
                    }
                }
            }
            catch {
                continue;
            }
        }
    }
    finally {
        await context.close();
        await browser.close();
    }
    return jobs;
}
