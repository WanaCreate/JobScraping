import { chromium } from "playwright";
import { fetchPageWithRetry } from "./http.js";
let sharedBrowser = null;
let sharedContext = null;
const PLAYWRIGHT_DOMAINS = [
    "greenhouse.io",
    "lever.co",
    "smartrecruiters.com",
    "myworkdayjobs.com",
    "workdayjobs.com",
    "icims.com",
    "ashbyhq.com",
    "phenompeople.com",
    "amazon.jobs",
    "workable.com",
];
/** Generic subdomains that indicate the real content is JS-rendered via an ATS embed */
const JS_RENDERED_SUBDOMAINS = new Set(["careers", "career", "jobs", "job", "apply", "hire"]);
function needsPlaywright(url) {
    try {
        const parsed = new URL(url);
        const host = parsed.hostname.toLowerCase();
        if (PLAYWRIGHT_DOMAINS.some(domain => host.includes(domain)))
            return true;
        // careers.X.com and jobs.X.com often embed JS-rendered ATS widgets
        const parts = host.split(".");
        if (parts.length >= 3 && JS_RENDERED_SUBDOMAINS.has(parts[0]))
            return true;
        return false;
    }
    catch {
        return false;
    }
}
async function getSharedContext() {
    if (sharedContext)
        return sharedContext;
    sharedBrowser = await chromium.launch({ headless: true });
    sharedContext = await sharedBrowser.newContext({
        ignoreHTTPSErrors: true,
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    });
    return sharedContext;
}
async function fetchWithPlaywright(url) {
    const context = await getSharedContext();
    const page = await context.newPage();
    try {
        await page.goto(url, { waitUntil: "networkidle", timeout: 45000 });
        await page.waitForTimeout(2000);
        const html = await page.content();
        const finalUrl = page.url();
        return { html, finalUrl };
    }
    catch {
        return null;
    }
    finally {
        await page.close();
    }
}
function stripApplyPath(url) {
    try {
        const parsed = new URL(url);
        if (/\/apply\/?$/i.test(parsed.pathname)) {
            parsed.pathname = parsed.pathname.replace(/\/apply\/?$/i, "");
            return parsed.toString();
        }
    }
    catch { /* no-op */ }
    return url;
}
/** Quick check: does the HTML look like a JS shell with very little visible content? */
function looksLikeJsShell(html) {
    // Strip all tags, collapse whitespace, measure visible text
    const visibleText = html.replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    // If the visible text is very short relative to the HTML, it's likely a JS shell
    // Typical shell: 10KB+ of HTML but only a few hundred chars of visible text
    return html.length > 2000 && visibleText.length < 500;
}
export async function fetchJobPage(rawUrl) {
    const url = stripApplyPath(rawUrl);
    const playwrightNeeded = needsPlaywright(url);
    // For known JS-rendered domains, skip HTTP and go straight to Playwright
    if (playwrightNeeded) {
        const result = await fetchWithPlaywright(url);
        if (result && result.html.length >= 500) {
            return result;
        }
        // Fall through to HTTP if Playwright failed
    }
    // Try plain HTTP (faster for static pages)
    let httpResult = null;
    try {
        httpResult = await fetchPageWithRetry(url, { maxAttempts: 2, baseDelayMs: 500 });
    }
    catch { /* no result */ }
    if (httpResult && httpResult.html && httpResult.html.length >= 500) {
        // Check if HTTP result is a JS shell with minimal visible content
        if (!looksLikeJsShell(httpResult.html)) {
            return httpResult;
        }
        // Looks like a JS shell — fall through to Playwright
    }
    // Playwright fallback for pages that returned a JS shell or too little HTML
    if (!playwrightNeeded) {
        const result = await fetchWithPlaywright(url);
        if (result && result.html.length >= 200) {
            return result;
        }
    }
    // Return whatever HTTP gave us if Playwright also failed
    if (httpResult && httpResult.html && httpResult.html.length >= 200) {
        return httpResult;
    }
    return null;
}
export async function closeBrowser() {
    if (sharedContext) {
        await sharedContext.close().catch(() => { });
        sharedContext = null;
    }
    if (sharedBrowser) {
        await sharedBrowser.close().catch(() => { });
        sharedBrowser = null;
    }
}
