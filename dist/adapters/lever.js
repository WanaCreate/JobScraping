import { http } from "../utils/http.js";
export async function scrapeLever(tenant) {
    const limit = 100;
    let skip = 0;
    const jobs = [];
    const maxPages = 200;
    let page = 0;
    while (page < maxPages) {
        const url = `https://api.lever.co/v0/postings/${encodeURIComponent(tenant)}?mode=json&limit=${limit}&skip=${skip}`;
        const response = await http.get(url);
        const postings = response.data ?? [];
        if (postings.length === 0)
            break;
        for (const posting of postings) {
            if (posting.state && posting.state.toLowerCase() === "closed")
                continue;
            jobs.push({
                title: posting.text ?? null,
                url: posting.hostedUrl ?? null,
                location: posting.categories?.location ?? null,
                ats: "lever"
            });
        }
        if (postings.length < limit)
            break;
        skip += limit;
        page += 1;
    }
    return jobs;
}
