const ROLE_HINT = /\b(designer|design|artist|writer|editor|producer|engineer|developer|manager|director|specialist|scientist|architect|analyst|intern|coordinator)\b/i;
const KNOWN_JOB_HOST = /(greenhouse\.io|lever\.co|smartrecruiters\.com|myworkdayjobs\.com|icims\.com|amazon\.jobs|ashbyhq\.com)/i;
const NOISE_TITLE = /^(skip to\b|learn more\b|read more\b|home$|about$|privacy$|cookie$|terms$|newsroom$|careers?$|search jobs?$|view all jobs?$|view all teams?$|join our talent community$|see next steps$|explore university opportunities$)/i;
const URL_HINT = /(job|jobs|career|careers|position|positions|opening|openings|opportunit|vacanc|requisition)/i;
function safeParse(url) {
    try {
        return new URL(url);
    }
    catch {
        return null;
    }
}
export function isLikelyJobPosting(job) {
    const title = (job.title ?? "").trim();
    const url = (job.url ?? "").trim();
    if (!title || !url)
        return false;
    if (title.length < 3 || title.length > 180)
        return false;
    if (NOISE_TITLE.test(title))
        return false;
    const parsed = safeParse(url);
    if (!parsed)
        return false;
    const path = parsed.pathname.toLowerCase().replace(/\/+$/, "") || "/";
    const query = parsed.search.toLowerCase();
    const host = parsed.hostname.toLowerCase();
    // Listing/category pages (not individual job detail pages).
    const listingPath = /^\/(jobs|job|careers|career|search|search-results|open-positions|opportunities|teams|departments)$/.test(path) || /^\/c\/[a-z0-9-]+-jobs$/.test(path);
    if (listingPath)
        return false;
    if (/\/search\/jobdetail\//.test(path) || /\/jobdetail\//.test(path))
        return true;
    if (/[?&](gh_jid|jobid|job_id|job|posting|postingid|requisition|reqid)=/.test(query))
        return true;
    if (KNOWN_JOB_HOST.test(host)) {
        if (/(\/job\/|\/jobs\/)/.test(path))
            return true;
        if (/jobs\.lever\.co/.test(host) && path.split("/").filter(Boolean).length >= 2)
            return true;
        if (/jobs\.smartrecruiters\.com/.test(host) && path.split("/").filter(Boolean).length >= 2)
            return true;
        if (/myworkdayjobs\.com/.test(host) && /(\/job\/|\/apply$)/.test(path))
            return true;
        if (/icims\.com/.test(host) && /\/jobs\/\d+/.test(path))
            return true;
        if (/ashbyhq\.com/.test(host) && path.split("/").filter(Boolean).length >= 2)
            return true;
    }
    if (/\/jobs?\/[^/]*\d[^/]*$/.test(path))
        return true;
    if (/\/job\/[a-z0-9-]{6,}$/.test(path))
        return true;
    if (/\/details\/\d+/.test(path))
        return true;
    // Generic fallback: title looks like a role and URL path strongly looks job-related.
    if (ROLE_HINT.test(title) && /(\/jobs?\/|\/position\/|\/opening\/|\/requisition\/)/.test(path))
        return true;
    return false;
}
export function isLikelyJobEntryLoose(job) {
    const title = (job.title ?? "").trim();
    const url = (job.url ?? "").trim();
    if (!title || !url)
        return false;
    if (title.length < 3 || title.length > 180)
        return false;
    if (NOISE_TITLE.test(title))
        return false;
    if (!ROLE_HINT.test(title))
        return false;
    const parsed = safeParse(url);
    if (!parsed)
        return false;
    if (!/^https?:$/i.test(parsed.protocol))
        return false;
    const path = parsed.pathname.toLowerCase();
    const query = parsed.search.toLowerCase();
    const host = parsed.hostname.toLowerCase();
    if (path === "/" || path === "")
        return false;
    if (/\/(privacy|terms|about|contact|news|press|investor|team|teams|locations)\b/.test(path))
        return false;
    if (/^\/(jobs|job|careers|career|search|search-results|open-positions|opportunities)$/.test(path))
        return false;
    if (/^\/c\/[a-z0-9-]+-jobs$/.test(path))
        return false;
    if (KNOWN_JOB_HOST.test(host) && path.split("/").filter(Boolean).length >= 2)
        return true;
    if (/\/(search\/jobdetail|jobdetail)\//.test(path))
        return true;
    if (/\/jobs?\/[^/]*\d/.test(path))
        return true;
    if (/\/job\/[a-z0-9-]{6,}/.test(path))
        return true;
    if (/\/details\/\d+/.test(path))
        return true;
    if (/[?&](jobid|job_id|job|posting|requisition|reqid)=/.test(query))
        return true;
    if (URL_HINT.test(path) && ROLE_HINT.test(title))
        return true;
    return false;
}
