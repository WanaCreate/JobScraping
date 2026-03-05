const CREATIVE_TITLE_TERMS = [
    "design",
    "designer",
    "ux",
    "ui",
    "product design",
    "graphic",
    "visual",
    "art director",
    "creative director",
    "brand",
    "branding",
    "content",
    "copywriter",
    "writer",
    "editor",
    "motion",
    "animation",
    "animator",
    "illustrator",
    "video",
    "videographer",
    "photographer",
    "stylist",
    "fashion",
    "3d",
    "vfx",
    "game artist",
    "sound",
    "music"
];
const NON_CREATIVE_TITLE_TERMS = [
    "account executive",
    "accounts payable",
    "bookkeeper",
    "tax",
    "auditor",
    "compliance",
    "legal counsel",
    "paralegal",
    "salesforce admin",
    "warehouse",
    "driver",
    "recruiter",
    "talent acquisition",
    "customer support",
    "customer success",
    "business analyst",
    "financial analyst"
];
const CREATIVE_SKILL_TERMS = [
    "figma",
    "adobe creative suite",
    "after effects",
    "premiere pro",
    "photoshop",
    "illustrator",
    "indesign",
    "blender",
    "cinema 4d",
    "maya",
    "storyboard",
    "typography",
    "color grading",
    "interaction design",
    "design system",
    "copywriting",
    "brand strategy",
    "visual identity",
    "motion graphics"
];
const titlePositiveRegex = new RegExp(`\\b(${CREATIVE_TITLE_TERMS.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`, "i");
const titleNegativeRegex = new RegExp(`\\b(${NON_CREATIVE_TITLE_TERMS.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`, "i");
const descriptionCreativeRegex = new RegExp(`\\b(${CREATIVE_SKILL_TERMS.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`, "i");
export function scoreCreativeText(input) {
    const text = input.toLowerCase();
    let score = 0;
    if (titlePositiveRegex.test(text))
        score += 2;
    if (descriptionCreativeRegex.test(text))
        score += 2;
    if (/\b(creative|design|visual|brand|content)\b/i.test(text))
        score += 1;
    if (/\b(software engineer|backend|frontend|devops|accountant|finance|legal)\b/i.test(text))
        score -= 2;
    return score;
}
export function isCreativeTitleStrict(title) {
    const normalized = title.trim();
    if (!normalized)
        return false;
    if (!titlePositiveRegex.test(normalized))
        return false;
    if (titleNegativeRegex.test(normalized) && !/\b(design|creative|content|brand|art)\b/i.test(normalized)) {
        return false;
    }
    return true;
}
export function passesCreativeGate(params) {
    const { title, description, url, minScore = 2 } = params;
    const combined = [title, description ?? "", url ?? ""].join(" ");
    const score = scoreCreativeText(combined);
    return isCreativeTitleStrict(title) && score >= minScore;
}
