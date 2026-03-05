import { safeAbsoluteUrl } from "../utils/http.js";
function unique(values) {
    return Array.from(new Set(values.filter(Boolean)));
}
function parseFirstMatch(text, patterns) {
    for (const pattern of patterns) {
        const match = pattern.exec(text);
        if (match?.[1])
            return match[1];
    }
    return null;
}
function extractWorkdayEndpoints(html, baseUrl) {
    const regex = /https?:\/\/[^"'\s<>]+\/wday\/cxs\/[^"'\s<>]+\/jobs(?:\?[^"'\s<>]*)?/gi;
    const found = html.match(regex) ?? [];
    const normalized = found.map((url) => url.replace(/\\u0026/g, "&").replace(/\\/g, ""));
    const relativeRegex = /\/wday\/cxs\/[^"'\s<>]+\/jobs(?:\?[^"'\s<>]*)?/gi;
    const relativeMatches = html.match(relativeRegex) ?? [];
    for (const relative of relativeMatches) {
        const abs = safeAbsoluteUrl(relative, baseUrl);
        if (abs)
            normalized.push(abs);
    }
    return unique(normalized);
}
function extractIcimsSearchEndpoint(html, finalUrl) {
    const direct = html.match(/https?:\/\/[^"'\s<>]*icims\.com\/jobs\/search[^"'\s<>]*/gi) ?? [];
    if (direct.length > 0)
        return unique(direct.map((x) => x.replace(/\\u0026/g, "&")));
    try {
        const host = new URL(finalUrl).hostname;
        if (host.includes("icims.com")) {
            return [`https://${host}/jobs/search?ss=1`];
        }
    }
    catch {
        return [];
    }
    return [];
}
export function extractTenant(html, finalUrl, ats) {
    const lowerHtml = html.toLowerCase();
    const lowerFinalUrl = finalUrl.toLowerCase();
    const joined = `${lowerHtml}\n${lowerFinalUrl}`;
    const metadata = {};
    const endpoints = [];
    if (ats === "greenhouse") {
        const tenant = parseFirstMatch(joined, [
            /boards\.greenhouse\.io\/([a-z0-9_-]+)/i,
            /job-boards\.greenhouse\.io\/([a-z0-9_-]+)/i,
            /embed\/job_board\?for=([a-z0-9_-]+)/i
        ]);
        return { tenant, metadata, endpoints };
    }
    if (ats === "lever") {
        const tenant = parseFirstMatch(joined, [
            /jobs\.lever\.co\/([a-z0-9_-]+)/i,
            /api\.lever\.co\/v0\/postings\/([a-z0-9_-]+)/i
        ]);
        return { tenant, metadata, endpoints };
    }
    if (ats === "smartrecruiters") {
        const tenant = parseFirstMatch(joined, [
            /careers\.smartrecruiters\.com\/([a-z0-9_-]+)/i,
            /smartrecruiters\.com\/([a-z0-9_-]+)\/jobs/i
        ]);
        return { tenant, metadata, endpoints };
    }
    if (ats === "workday") {
        const detectedEndpoints = extractWorkdayEndpoints(html, finalUrl);
        endpoints.push(...detectedEndpoints);
        let tenant = parseFirstMatch(joined, [
            /\/wday\/cxs\/([a-z0-9_-]+)\/[a-z0-9_-]+\/jobs/i,
            /https?:\/\/([a-z0-9-]+)\.wd\d+\.myworkdayjobs\.com/i
        ]) ?? null;
        if (!tenant) {
            tenant = parseFirstMatch(joined, [/myworkdayjobs\.com\/([a-z0-9_-]+)/i]);
        }
        if (detectedEndpoints.length === 0 && tenant) {
            const wdHostMatch = finalUrl.match(/https?:\/\/([a-z0-9.-]*myworkdayjobs\.com)/i);
            if (wdHostMatch?.[1]) {
                const host = wdHostMatch[1];
                endpoints.push(`https://${host}/wday/cxs/${tenant}/External/jobs`, `https://${host}/wday/cxs/${tenant}/Careers/jobs`);
            }
        }
        return { tenant, metadata, endpoints: unique(endpoints) };
    }
    if (ats === "icims") {
        const tenant = parseFirstMatch(joined, [/\/\/([a-z0-9-]+)\.icims\.com/i, /clientid=([a-z0-9-]+)/i]) ?? null;
        endpoints.push(...extractIcimsSearchEndpoint(html, finalUrl));
        return { tenant, metadata, endpoints: unique(endpoints) };
    }
    if (ats === "ashby") {
        const tenant = parseFirstMatch(joined, [
            /jobs\.ashbyhq\.com\/([a-z0-9_-]+)/i,
            /api\.ashbyhq\.com\/posting-api\/job-board\/([a-z0-9_-]+)/i
        ]) ?? null;
        return { tenant, metadata, endpoints };
    }
    if (ats === "amazon") {
        let tenant = null;
        try {
            const host = new URL(finalUrl).hostname;
            tenant = host.replace(/^www\./, "");
        }
        catch {
            tenant = null;
        }
        return { tenant, metadata, endpoints };
    }
    if (ats === "phenom") {
        const tenant = parseFirstMatch(html, [/"refNum"\s*:\s*"([A-Z0-9_-]+)"/i, /content-us\.phenompeople\.com\/api\/([A-Z0-9_-]+)\//i]) ??
            null;
        const widgetEndpoint = parseFirstMatch(html, [/"widgetApiEndpoint"\s*:\s*"([^"]+)"/i, /https?:\/\/[^"'\s<>]+\/widgets/i]) ?? null;
        if (widgetEndpoint)
            endpoints.push(widgetEndpoint);
        return { tenant, metadata, endpoints: unique(endpoints) };
    }
    return { tenant: null, metadata, endpoints };
}
