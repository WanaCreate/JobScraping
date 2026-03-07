import { http, safeAbsoluteUrl } from "../utils/http.js";
function formatLocation(posting) {
    const parts = [posting.city, posting.state, posting.country].filter(Boolean);
    if (parts.length > 0)
        return parts.join(", ");
    return posting.location ?? null;
}
export async function scrapeAmazon(sourceUrl) {
    const base = new URL(sourceUrl);
    const searchUrl = `${base.origin}/en/search.json`;
    const limit = 100;
    let offset = 0;
    const jobs = [];
    const seen = new Set();
    const maxPages = 500;
    let page = 0;
    while (page < maxPages) {
        const response = await http.get(searchUrl, {
            params: {
                offset,
                result_limit: limit
            }
        });
        const postings = response.data?.jobs ?? [];
        if (postings.length === 0)
            break;
        let newCount = 0;
        for (const posting of postings) {
            const path = posting.job_path ?? "";
            if (path && seen.has(path))
                continue;
            if (path)
                seen.add(path);
            newCount += 1;
            jobs.push({
                title: posting.title ?? null,
                url: safeAbsoluteUrl(path, "https://www.amazon.jobs"),
                location: formatLocation(posting),
                company: "Amazon",
                ats: "amazon"
            });
        }
        if (newCount === 0)
            break;
        offset += postings.length;
        page += 1;
        if (postings.length < limit)
            break;
    }
    return jobs;
}
