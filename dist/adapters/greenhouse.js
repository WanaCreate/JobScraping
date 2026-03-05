import * as cheerio from "cheerio";
import { http, safeAbsoluteUrl } from "../utils/http.js";
export async function scrapeGreenhouse(tenant) {
    const url = `https://boards.greenhouse.io/embed/job_board?for=${encodeURIComponent(tenant)}`;
    const response = await http.get(url, { responseType: "text" });
    const $ = cheerio.load(response.data);
    const jobs = [];
    $("a").each((_, element) => {
        const title = $(element).text().trim();
        const href = ($(element).attr("href") ?? "").trim();
        if (!title || !href)
            return;
        if (!/\/jobs\/\d+/i.test(href))
            return;
        const absolute = safeAbsoluteUrl(href, "https://boards.greenhouse.io");
        if (!absolute)
            return;
        const location = $(element).closest(".opening").find(".location").text().trim() ||
            $(element).closest("li").find(".location").text().trim() ||
            null;
        jobs.push({
            title,
            url: absolute,
            location,
            ats: "greenhouse"
        });
    });
    return jobs;
}
