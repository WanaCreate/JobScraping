const CREATIVE_KEYWORDS = [
    "designer",
    "design",
    "ux",
    "ui",
    "visual",
    "product design",
    "graphic",
    "artist",
    "illustrator",
    "animator",
    "motion",
    "3d",
    "videographer",
    "photographer",
    "editor",
    "producer",
    "writer",
    "copywriter",
    "journalist",
    "editorial",
    "music",
    "audio",
    "sound",
    "composer",
    "creative",
    "brand",
    "content",
    "campaign",
    "fashion",
    "stylist",
    "apparel",
    "character artist",
    "environment artist"
];
const CREATIVE_REGEX = new RegExp(`\\b(${CREATIVE_KEYWORDS.map((keyword) => keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`, "i");
export function filterCreativeJobs(jobs) {
    return jobs.filter((job) => CREATIVE_REGEX.test(job.title));
}
