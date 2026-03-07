import { http } from "../utils/http.js";
function formatLocation(location) {
    if (!location)
        return null;
    const parts = [location.city, location.region, location.country].filter(Boolean);
    if (parts.length === 0 && location.remote)
        return "Remote";
    if (parts.length === 0)
        return null;
    return parts.join(", ");
}
export async function scrapeSmartRecruiters(tenant) {
    const limit = 100;
    let offset = 0;
    const jobs = [];
    const maxPages = 200;
    let page = 0;
    while (page < maxPages) {
        const url = `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(tenant)}/postings?offset=${offset}&limit=${limit}`;
        const response = await http.get(url);
        const postings = response.data?.content ?? [];
        if (postings.length === 0)
            break;
        for (const posting of postings) {
            jobs.push({
                title: posting.name ?? null,
                url: posting.ref
                    ? `https://jobs.smartrecruiters.com/${encodeURIComponent(tenant)}/${posting.ref}`
                    : null,
                location: formatLocation(posting.location),
                ats: "smartrecruiters"
            });
        }
        offset += postings.length;
        page += 1;
        if (postings.length < limit)
            break;
    }
    return jobs;
}
