/**
 * Hybrid job enrichment pipeline.
 *
 * Reads a CSV of (title, jobLink), fetches each page, extracts structured
 * data via JSON-LD first, then falls back to Claude Haiku for incomplete
 * records. Outputs API-ready JSON and CSV.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... npx tsx pipeline/enrichFromCsv.ts [options]
 *
 * Options:
 *   --input <path>         CSV input (default: outputs/api-ready/latest/Joblistings.csv)
 *   --concurrency <n>      Parallel fetches (default: 6)
 *   --aiConcurrency <n>    Parallel AI calls (default: 4)
 *   --hiringTeamUid <uid>  UID for hiringTeam (default: system-scraper)
 *   --maxJobs <n>          Process at most N jobs
 *   --skipAi               Skip AI enrichment, use heuristic only
 *   --outputDir <dir>      Output directory (default: outputs/api-ready/latest)
 */
/**
 * Maintainer note:
 * Before changing extraction, sanitization, merge, or CSV serialization logic here,
 * read and update job-collection-instructions.json in the repo root so behavior and
 * documented collection rules stay in sync.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { load } from "cheerio";
import { fetchJobPage, closeBrowser } from "../utils/pageFetcher.js";
import { enrichWithAi, needsAiEnrichment } from "../utils/aiEnricher.js";
import { reviewJobs } from "../utils/qualityReview.js";
import { logInfo, logWarn } from "../utils/logger.js";
function getArg(flag) {
    const idx = process.argv.indexOf(flag);
    if (idx < 0)
        return null;
    const value = process.argv[idx + 1];
    return value && !value.startsWith("--") ? value : null;
}
function parseCliOptions() {
    return {
        input: getArg("--input") ?? "outputs/api-ready/latest/Joblistings.csv",
        outputDir: getArg("--outputDir") ?? "outputs/api-ready/latest",
        concurrency: Number(getArg("--concurrency") ?? "6"),
        aiConcurrency: Number(getArg("--aiConcurrency") ?? "4"),
        hiringTeamUid: getArg("--hiringTeamUid") ?? process.env.HIRING_TEAM_UID ?? "system-scraper",
        maxJobs: getArg("--maxJobs") ? Number(getArg("--maxJobs")) : null,
        skipAi: process.argv.includes("--skipAi"),
    };
}
function parseCsv(content) {
    const lines = content.split(/\r?\n/).filter(line => line.trim());
    if (lines.length < 2)
        return [];
    const rows = [];
    // Skip header line
    for (let i = 1; i < lines.length; i++) {
        const row = parseCsvLine(lines[i]);
        if (row.length >= 2) {
            const title = row[0].trim();
            const jobLink = row[1].trim();
            if (title && jobLink && /^https?:\/\//i.test(jobLink)) {
                rows.push({ title, jobLink });
            }
        }
    }
    return rows;
}
function parseCsvLine(line) {
    const fields = [];
    let current = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (inQuotes) {
            if (char === '"') {
                if (i + 1 < line.length && line[i + 1] === '"') {
                    current += '"';
                    i++;
                }
                else {
                    inQuotes = false;
                }
            }
            else {
                current += char;
            }
        }
        else {
            if (char === '"') {
                inQuotes = true;
            }
            else if (char === ",") {
                fields.push(current);
                current = "";
            }
            else {
                current += char;
            }
        }
    }
    fields.push(current);
    return fields;
}
// ─── JSON-LD Extraction ──────────────────────────────────────────
function extractJsonLdJobPosting(html) {
    const $ = load(html);
    const scripts = $("script[type='application/ld+json']").toArray();
    const queue = [];
    for (const script of scripts) {
        try {
            const parsed = JSON.parse($(script).text());
            queue.push(parsed);
        }
        catch { /* skip malformed JSON-LD */ }
    }
    while (queue.length > 0) {
        const current = queue.shift();
        if (!current)
            continue;
        if (Array.isArray(current)) {
            for (const item of current)
                queue.push(item);
            continue;
        }
        if (typeof current !== "object")
            continue;
        const record = current;
        const rawType = record["@type"];
        const typeStr = Array.isArray(rawType) ? rawType.join(" ") : String(rawType ?? "");
        if (/jobposting/i.test(typeStr))
            return record;
        for (const nested of Object.values(record))
            queue.push(nested);
    }
    return null;
}
// ─── Heuristic Extraction (from JSON-LD + HTML) ──────────────────
const COUNTRY_CODES = {
    US: "United States", UK: "United Kingdom", GB: "United Kingdom",
    CA: "Canada", AU: "Australia", DE: "Germany", FR: "France",
    ES: "Spain", IT: "Italy", NL: "Netherlands", SE: "Sweden",
    NO: "Norway", DK: "Denmark", FI: "Finland", IE: "Ireland",
    CH: "Switzerland", AT: "Austria", NZ: "New Zealand", IN: "India",
    SG: "Singapore", JP: "Japan", BR: "Brazil", MX: "Mexico",
    AE: "United Arab Emirates",
};
const US_STATES = new Set([
    "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID", "IL", "IN",
    "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV",
    "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN",
    "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY", "DC",
]);
function cleanText(value) {
    if (!value)
        return "";
    return value.replace(/\u00A0/g, " ").replace(/[\t\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}
const DESCRIPTION_SELECTORS = [
    "[data-automation-id='jobPostingDescription']",
    "[data-automation-id='job-posting-description']",
    "[data-automation-id='jobDescription']",
    ".css-kyg8or",
    "#job-detail-body",
    "[id*='job-description']",
    "[data-qa='job-description']",
    "[data-testid*='description']",
    "[class*='JobDescription']",
    ".posting-description",
    ".job-description",
    ".job-details",
    ".iCIMS_InfoMsg_Job",
    "#content .content",
    "#content",
    "[class*='description']",
    "article",
    "main",
];
const DESCRIPTION_FORM_NOISE = [
    "submit application",
    "first name*",
    "last name*",
    "resume/cv",
    "cover letter",
    "voluntary self identification",
    "attach dropbox",
    "google drive",
    "select...",
];
const KEYWORD_TERMS = [
    "design",
    "creative",
    "brand",
    "content",
    "visual",
    "motion",
    "animation",
    "ux",
    "ui",
    "product design",
    "graphic design",
    "art direction",
    "copywriting",
    "video",
    "research",
];
const SKILL_TAXONOMY = {
    figma: ["figma"],
    sketch: ["sketch"],
    photoshop: ["photoshop", "adobe photoshop"],
    illustrator: ["illustrator", "adobe illustrator"],
    indesign: ["indesign", "adobe indesign"],
    after_effects: ["after effects", "adobe after effects"],
    premiere_pro: ["premiere pro", "adobe premiere"],
    adobe_creative_suite: ["adobe creative suite", "creative suite", "adobe cc"],
    prototyping: ["prototyping", "prototype"],
    wireframing: ["wireframing", "wireframe"],
    design_systems: ["design systems", "design tokens"],
    ux_research: ["ux research", "user research"],
    interaction_design: ["interaction design", "ixd"],
    html: ["html"],
    css: ["css"],
    javascript: ["javascript", "typescript", "react", "next.js", "nextjs"],
    drawing: ["drawing", "hand drawing", "life drawing"],
    painting: ["painting", "oil painting", "watercolor"],
    sculpture: ["sculpture", "3d sculpting"],
    photography: ["photography", "photo editing"],
    art_history: ["art history"],
    typography: ["typography", "typesetting"],
    branding: ["branding", "brand identity", "brand design"],
    motion_graphics: ["motion graphics", "motion design"],
    video_editing: ["video editing", "video production"],
    blender: ["blender"],
    cinema_4d: ["cinema 4d", "c4d"],
    procreate: ["procreate"],
    storybook: ["storybook"],
    design_tokens: ["design tokens"],
    information_architecture: ["information architecture", "ia"],
    copywriting: ["copywriting", "copy writing"],
    seo: ["seo", "search engine optimization"],
};
const SKILL_STOP_WORDS = new Set([
    "and", "or", "with", "in", "of", "to", "the", "a", "an",
    "experience", "proficiency", "knowledge", "ability", "skills", "skill",
]);
const DESCRIPTION_ALLOWED_TAGS = new Set([
    "a", "b", "blockquote", "br", "code", "em", "h1", "h2", "h3", "h4", "h5", "h6",
    "hr", "i", "li", "ol", "p", "pre", "strong", "u", "ul",
]);
const DESCRIPTION_BLOCK_TAGS = new Set([
    "blockquote", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "li", "ol", "p", "pre", "ul",
]);
const DESCRIPTION_WRAPPER_TAGS = new Set([
    "article", "div", "main", "section", "span",
]);
const DESCRIPTION_NOISE_TEXT = [
    /^back to jobs?$/i,
    /^careers?$/i,
    /^home\s*(>|&gt;).+$/i,
    /^home\s*>\s*careers?(?:\s*>\s*.+)?$/i,
    /^view all jobs?$/i,
    /^share (this )?job$/i,
    /^refer (a )?friend$/i,
    /^apply( now| for this job)?$/i,
    /^save job$/i,
];
function stripHtmlToPlain(input) {
    return cleanText(input.replace(/<[^>]+>/g, " "));
}
function dedupeStrings(values) {
    return Array.from(new Set(values.map(v => cleanText(v.toLowerCase())).filter(Boolean)));
}
function escapeHtml(value) {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}
function sanitizeDescriptionHtml(fragment) {
    if (!fragment)
        return "";
    const $ = load(`<div id="desc-root">${fragment}</div>`);
    const root = $("#desc-root");
    root.find("script,style,noscript,svg,canvas,iframe,nav,header,footer").remove();
    root.find("form,input,button,select,textarea,fieldset,legend").remove();
    root.find("img,picture,source,video,audio,figure,figcaption").remove();
    root.find("[id*='apply' i],[class*='apply' i],[data-qa*='apply' i],[data-testid*='apply' i]").remove();
    root.find("[id*='application' i],[class*='application' i],[data-qa*='application' i]").remove();
    root.find("[id*='cookie' i],[class*='cookie' i],[aria-label*='cookie' i]").remove();
    root.find("[class*='nav' i],[class*='breadcrumb' i],[class*='share' i],[class*='social' i]").remove();
    root.find("a,button").each((_, element) => {
        const label = cleanText($(element).text());
        if (DESCRIPTION_NOISE_TEXT.some(pattern => pattern.test(label))) {
            $(element).remove();
        }
    });
    root.find("*").toArray().reverse().forEach(element => {
        const tag = String(element.tagName || element.name || "").toLowerCase();
        if (!tag)
            return;
        if (tag === "a") {
            const href = cleanText($(element).attr("href"));
            const safeHref = /^(https?:\/\/|mailto:)/i.test(href) ? href : "";
            for (const attr of Object.keys(element.attribs ?? {})) {
                $(element).removeAttr(attr);
            }
            if (!cleanText($(element).text())) {
                $(element).remove();
                return;
            }
            if (safeHref) {
                $(element).attr("href", safeHref);
            }
            else {
                $(element).replaceWith($(element).contents());
            }
            return;
        }
        if (DESCRIPTION_WRAPPER_TAGS.has(tag)) {
            const html = $(element).html()?.trim() ?? "";
            const text = cleanText($(element).text());
            const hasBlockChildren = $(element)
                .children()
                .toArray()
                .some(child => {
                const childTag = String(child.tagName || child.name || "").toLowerCase();
                return DESCRIPTION_BLOCK_TAGS.has(childTag) || DESCRIPTION_WRAPPER_TAGS.has(childTag);
            });
            for (const attr of Object.keys(element.attribs ?? {})) {
                $(element).removeAttr(attr);
            }
            if (!text && !/<br\s*\/?>|<hr\s*\/?>/i.test(html)) {
                $(element).remove();
            }
            else if (tag === "div" && !hasBlockChildren) {
                $(element).replaceWith(`<p>${html}</p>`);
            }
            else {
                $(element).replaceWith($(element).contents());
            }
            return;
        }
        if (!DESCRIPTION_ALLOWED_TAGS.has(tag)) {
            $(element).replaceWith($(element).contents());
            return;
        }
        for (const attr of Object.keys(element.attribs ?? {})) {
            $(element).removeAttr(attr);
        }
        const text = cleanText($(element).text());
        if ((DESCRIPTION_NOISE_TEXT.some(pattern => pattern.test(text)) || !text)
            && !["br", "hr"].includes(tag)
            && $(element).children().length === 0) {
            $(element).remove();
        }
    });
    let cleaned = (root.html() ?? "").trim();
    if (!cleaned)
        return "";
    const cutoff = /(?:submit application|voluntary self identification|first name\*|resume\/cv|cover letter|attach dropbox|google drive)/i;
    const cutoffMatch = cleaned.match(cutoff);
    if (cutoffMatch && typeof cutoffMatch.index === "number" && cutoffMatch.index > 180) {
        cleaned = cleaned.slice(0, cutoffMatch.index).trim();
    }
    cleaned = cleaned
        .replace(/>\s+</g, "><")
        .replace(/\s*<br\s*\/?>\s*/gi, "<br>")
        .replace(/(<br>){3,}/gi, "<br><br>")
        .replace(/\s{2,}/g, " ")
        .trim();
    const plain = stripHtmlToPlain(cleaned);
    if (plain.length < 80) {
        return plain ? `<p>${escapeHtml(plain)}</p>` : "";
    }
    return cleaned;
}
function scoreDescriptionCandidate(htmlFragment, priorityBoost) {
    const plain = stripHtmlToPlain(htmlFragment);
    if (plain.length < 60)
        return -1;
    let score = Math.min(plain.length, 20000) + priorityBoost;
    if (/<(p|ul|ol|li|h2|h3|h4|br)\b/i.test(htmlFragment))
        score += 140;
    if (/\b(responsibilit|qualification|requirement|what you'll|you will|about the role|benefits)\b/i.test(plain))
        score += 120;
    if (/\b(cookie|privacy policy|sign in|log in)\b/i.test(plain))
        score -= 800;
    if (DESCRIPTION_FORM_NOISE.some(token => plain.toLowerCase().includes(token)))
        score -= 900;
    if (plain.length > 16000)
        score -= 200;
    return score;
}
function extractDescriptionHtml(html, _jsonLd) {
    const $ = load(html);
    let bestHtml = "";
    let bestScore = -1;
    for (let i = 0; i < DESCRIPTION_SELECTORS.length; i++) {
        const selector = DESCRIPTION_SELECTORS[i];
        const priorityBoost = Math.max(0, (DESCRIPTION_SELECTORS.length - i) * 25);
        const nodes = $(selector).toArray();
        for (const node of nodes) {
            const rawHtml = $.html(node)?.trim() ?? "";
            if (!rawHtml)
                continue;
            const cleanedHtml = sanitizeDescriptionHtml(rawHtml);
            if (!cleanedHtml)
                continue;
            const score = scoreDescriptionCandidate(cleanedHtml, priorityBoost);
            if (score > bestScore) {
                bestScore = score;
                bestHtml = cleanedHtml;
            }
        }
    }
    return bestScore >= 120 ? bestHtml : "";
}
function extractDescriptionFromHtml(html, jsonLd) {
    const htmlDescription = extractDescriptionHtml(html, jsonLd);
    if (htmlDescription) {
        const plain = stripHtmlToPlain(htmlDescription);
        if (plain.length >= 80)
            return plain;
    }
    const $ = load(html);
    $("script,style,noscript,svg,canvas,iframe,nav,footer,header").remove();
    let best = "";
    let bestScore = -1;
    for (let i = 0; i < DESCRIPTION_SELECTORS.length; i++) {
        const selector = DESCRIPTION_SELECTORS[i];
        const priorityBoost = Math.max(0, (DESCRIPTION_SELECTORS.length - i) * 20);
        const nodes = $(selector).toArray();
        for (const node of nodes) {
            const text = cleanText($(node).text());
            if (!text)
                continue;
            const pseudoHtml = `<p>${text}</p>`;
            const score = scoreDescriptionCandidate(pseudoHtml, priorityBoost);
            if (score > bestScore) {
                bestScore = score;
                best = text;
            }
        }
    }
    if (best.length >= 80)
        return best;
    if (jsonLd) {
        const desc = cleanText(String(jsonLd.description ?? ""));
        if (desc.length >= 80)
            return desc;
    }
    const metaDesc = cleanText($("meta[property='og:description']").attr("content"))
        || cleanText($("meta[name='description']").attr("content"));
    if (metaDesc && metaDesc.length >= 40)
        return metaDesc;
    return "";
}
function extractLocationFromJsonLd(jsonLd) {
    const jobLocation = jsonLd.jobLocation;
    const entry = Array.isArray(jobLocation) ? jobLocation[0] : jobLocation;
    if (!entry || typeof entry !== "object")
        return null;
    const record = entry;
    const address = record.address;
    if (!address || typeof address !== "object")
        return null;
    const addr = address;
    const city = cleanText(String(addr.addressLocality ?? ""));
    const state = cleanText(String(addr.addressRegion ?? ""));
    let country = cleanText(String(addr.addressCountry ?? ""));
    if (country.length <= 3)
        country = COUNTRY_CODES[country.toUpperCase()] ?? country;
    if (!city && !state && !country)
        return null;
    return {
        placeId: "",
        name: [city, state || country].filter(Boolean).join(", "),
        formattedAddress: [city, state, country].filter(Boolean).join(", "),
        latitude: 0, longitude: 0,
        city, state, country,
    };
}
function extractSalaryFromJsonLd(jsonLd) {
    const baseSalary = jsonLd.baseSalary;
    if (!baseSalary || typeof baseSalary !== "object")
        return null;
    const sal = baseSalary;
    const currency = cleanText(String(sal.currency ?? "USD")) || "USD";
    const value = sal.value;
    const min = value ? Number(value.minValue ?? NaN) : NaN;
    const max = value ? Number(value.maxValue ?? NaN) : NaN;
    const unitText = value ? String(value.unitText ?? "") : "";
    const periodMap = {
        hour: "HOURLY", day: "DAILY", week: "WEEKLY",
        month: "MONTHLY", year: "ANNUAL", annual: "ANNUAL",
    };
    const period = periodMap[unitText.toLowerCase()] ?? null;
    if (!Number.isFinite(min) && !Number.isFinite(max))
        return null;
    return {
        min: Number.isFinite(min) ? min : null,
        max: Number.isFinite(max) ? max : null,
        currency, period,
    };
}
function extractSkillsFromJsonLd(jsonLd) {
    const raw = jsonLd.skills;
    if (!raw)
        return [];
    if (typeof raw === "string") {
        return dedupeStrings(raw.split(/[,;|]/).map(s => s.trim().toLowerCase().replace(/\s+/g, "_")).filter(Boolean));
    }
    if (Array.isArray(raw)) {
        return dedupeStrings(raw
            .filter((s) => typeof s === "string" && s.trim().length > 0)
            .map(s => s.trim().toLowerCase().replace(/\s+/g, "_")));
    }
    return [];
}
function extractKeywordsFromJsonLd(jsonLd) {
    const keywords = [];
    for (const field of ["occupationalCategory", "industry", "qualifications"]) {
        const val = jsonLd[field];
        if (typeof val === "string" && val.trim()) {
            keywords.push(...val.split(/[,;|]/).map(s => s.trim().toLowerCase()).filter(Boolean));
        }
        if (Array.isArray(val)) {
            keywords.push(...val.filter((s) => typeof s === "string" && s.trim().length > 0).map(s => s.trim().toLowerCase()));
        }
    }
    return dedupeStrings(keywords);
}
function extractKeywordsFromText(title, description) {
    const combined = `${title} ${description}`.toLowerCase();
    const found = [];
    for (const term of KEYWORD_TERMS) {
        if (combined.includes(term))
            found.push(term);
    }
    return dedupeStrings(found).slice(0, 20);
}
function normalizeSkillToken(raw) {
    const cleaned = raw
        .replace(/[()\[\]{}]/g, " ")
        .replace(/[^a-zA-Z0-9+.#\- ]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
    if (!cleaned || cleaned.length < 2 || cleaned.length > 45)
        return null;
    if (SKILL_STOP_WORDS.has(cleaned))
        return null;
    return cleaned;
}
function canonicalizeSkill(candidate) {
    const normalized = normalizeSkillToken(candidate);
    if (!normalized)
        return "";
    for (const [canonical, aliases] of Object.entries(SKILL_TAXONOMY)) {
        for (const alias of aliases) {
            if (normalized === alias || normalized.includes(alias) || alias.includes(normalized)) {
                return canonical;
            }
        }
    }
    return normalized.replace(/\s+/g, "_");
}
function extractSkillsFromText(title, description) {
    const lower = `${title} ${description}`.toLowerCase();
    const extracted = new Set();
    for (const [canonical, aliases] of Object.entries(SKILL_TAXONOMY)) {
        for (const alias of aliases) {
            const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            if (new RegExp(`\\b${escaped}\\b`, "i").test(lower)) {
                extracted.add(canonical);
                break;
            }
        }
    }
    const skillPhrasePattern = /\b(proficiency in|experience with|expertise in|strong knowledge of|hands[- ]on with|skilled in|required skills[:\s]*|skills[:\s]*|qualifications[:\s]*)\s+([^.;:\n]{3,160})/gi;
    let match = skillPhrasePattern.exec(description);
    while (match) {
        const phrase = match[2] ?? "";
        const segments = phrase
            .split(/,| and | or |\/|\|/i)
            .map(token => normalizeSkillToken(token))
            .filter((value) => Boolean(value));
        for (const segment of segments) {
            const canonical = canonicalizeSkill(segment);
            if (canonical)
                extracted.add(canonical);
        }
        match = skillPhrasePattern.exec(description);
    }
    return Array.from(extracted).slice(0, 30);
}
function extractWorkEmail(html, description) {
    const mailtoMatches = Array.from(html.matchAll(/mailto:([^"'?\s>]+)/gi))
        .map(m => cleanText(m[1]))
        .filter(Boolean);
    const textMatches = Array.from((`${html}\n${description}`).matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi))
        .map(m => cleanText(m[0]))
        .filter(Boolean);
    const candidates = dedupeStrings([...mailtoMatches, ...textMatches]);
    if (candidates.length === 0)
        return null;
    const preferred = candidates.find(value => !/no-?reply|donotreply|privacy|gdpr|legal|unsubscribe|support|info|hello|contact|admin|postmaster/i.test(value));
    return preferred ?? null;
}
/** Extract salary from description text when JSON-LD has no baseSalary */
function extractSalaryFromText(description) {
    const plain = description.replace(/<[^>]+>/g, " ");
    // Match patterns like "$80,000 - $120,000", "80k-120k", "$150,000/year"
    const salaryPattern = /\$\s?([\d,]+(?:\.\d+)?)\s*[kK]?\s*(?:[-–—to]+\s*\$?\s*([\d,]+(?:\.\d+)?)\s*[kK]?)?\s*(?:\/?\s*(hour|hr|year|yr|annual|annually|month|monthly|week|weekly|day|daily))?/i;
    const match = plain.match(salaryPattern);
    if (!match)
        return null;
    let min = parseFloat(match[1].replace(/,/g, ""));
    let max = match[2] ? parseFloat(match[2].replace(/,/g, "")) : null;
    // Handle "k" suffix in original text (e.g., "80k")
    if (/\d\s*[kK]\b/.test(match[0])) {
        if (min < 1000)
            min *= 1000;
        if (max !== null && max < 1000)
            max *= 1000;
    }
    const periodStr = (match[3] ?? "").toLowerCase();
    const periodMap = {
        hour: "HOURLY", hr: "HOURLY",
        day: "DAILY", daily: "DAILY",
        week: "WEEKLY", weekly: "WEEKLY",
        month: "MONTHLY", monthly: "MONTHLY",
        year: "ANNUAL", yr: "ANNUAL", annual: "ANNUAL", annually: "ANNUAL",
    };
    let period = periodMap[periodStr] ?? null;
    // Infer period from magnitude if not specified
    if (!period) {
        if (min >= 10000)
            period = "ANNUAL";
        else if (min >= 1000)
            period = "MONTHLY";
        else if (min >= 100)
            period = "DAILY";
        else
            period = "HOURLY";
    }
    if (!Number.isFinite(min))
        return null;
    return {
        min,
        max: max !== null && Number.isFinite(max) ? max : null,
        currency: "USD",
        period,
    };
}
function inferJobTypeFromJsonLd(jsonLd) {
    const raw = String(jsonLd.employmentType ?? "").toLowerCase();
    if (/intern|contract|temporary|fixed/i.test(raw))
        return "GIG";
    if (/part[- ]?time/i.test(raw))
        return "PARTTIME";
    if (/freelance/i.test(raw))
        return "FREELANCE";
    return "FULLTIME";
}
/** Known ATS/job-board hostnames — skip these when deriving company from URL */
const ATS_HOSTS = new Set([
    "greenhouse.io", "lever.co", "workday.com", "myworkdayjobs.com",
    "smartrecruiters.com", "ashbyhq.com", "breezy.hr", "recruitee.com",
    "jobs.lever.co", "boards.greenhouse.io", "jobvite.com", "icims.com",
    "ultipro.com", "taleo.net", "successfactors.com", "applytojob.com",
]);
/** Subdomains that are generic and should not be used as company names */
const GENERIC_SUBDOMAINS = new Set([
    "careers", "career", "jobs", "job", "job-boards", "boards", "apply",
    "hire", "hiring", "recruiting", "recruitment", "work", "www",
]);
/** Strip entity/subsidiary prefixes like "ADUS-Adobe Inc." → "Adobe Inc." */
function cleanCompanyName(name) {
    // Strip leading entity codes: "ADUS-", "NDIN-", "EMEA-" etc.
    const prefixStripped = name.replace(/^[A-Z]{2,6}-/, "");
    return prefixStripped.trim() || name;
}
/** Try to split joined words like "Foxfuelcreative" → "Foxfuel Creative" using simple heuristics */
function splitJoinedCompanyName(name) {
    // Don't touch names that already have spaces, are short, or are well-known single words
    if (name.includes(" ") || name.length <= 6)
        return name;
    // Split on camelCase boundaries: "BlackAirplane" → "Black Airplane"
    const camelSplit = name.replace(/([a-z])([A-Z])/g, "$1 $2");
    if (camelSplit !== name)
        return camelSplit;
    // Leave as-is if no clear boundary (flagged for AI review later)
    return name;
}
function extractCompanyFromJsonLd(jsonLd, fallbackUrl) {
    const org = jsonLd.hiringOrganization;
    if (org && typeof org === "object") {
        const rec = org;
        const rawName = cleanText(String(rec.name ?? ""));
        const name = cleanCompanyName(rawName);
        const website = cleanText(String(rec.sameAs ?? rec.url ?? ""));
        if (name)
            return { name, website: website || null, logo: null, email: null };
    }
    // Derive from URL
    try {
        const parsed = new URL(fallbackUrl);
        const host = parsed.hostname.replace(/^www\./i, "");
        const parts = host.split(".");
        // Skip ATS domains — try to extract company from subdomain or path
        const baseDomain = parts.slice(-2).join(".");
        if (ATS_HOSTS.has(baseDomain) || ATS_HOSTS.has(parts.slice(-3).join("."))) {
            // For ATS URLs, company is often the subdomain or first path segment
            const subdomain = parts.length > 2 ? parts[0] : null;
            if (subdomain && !GENERIC_SUBDOMAINS.has(subdomain.toLowerCase())) {
                const name = subdomain.charAt(0).toUpperCase() + subdomain.slice(1);
                return { name, website: null, logo: null, email: null };
            }
            // Try first meaningful path segment: /company-name/jobs/...
            const pathParts = parsed.pathname.split("/").filter(Boolean);
            if (pathParts.length > 0 && !GENERIC_SUBDOMAINS.has(pathParts[0].toLowerCase())) {
                const name = pathParts[0].charAt(0).toUpperCase() + pathParts[0].slice(1);
                return { name, website: null, logo: null, email: null };
            }
            return null;
        }
        // For company domains like careers.duolingo.com → use "duolingo"
        // Pick the first non-generic subdomain, or the domain name itself
        let companyPart = null;
        for (const part of parts) {
            if (!GENERIC_SUBDOMAINS.has(part.toLowerCase()) && part !== parts[parts.length - 1]) {
                // Skip TLD-like parts (com, org, io, etc.)
                if (part.length <= 3 && /^(com|org|net|io|co|eu|us|uk|de|fr|in|au|ca)$/i.test(part))
                    continue;
                companyPart = part;
                break;
            }
        }
        // Fallback: use the second-level domain (e.g., "duolingo" from "careers.duolingo.com")
        if (!companyPart && parts.length >= 2) {
            const sld = parts[parts.length - 2]; // second-level domain
            if (!GENERIC_SUBDOMAINS.has(sld.toLowerCase())) {
                companyPart = sld;
            }
        }
        if (companyPart) {
            const name = companyPart.charAt(0).toUpperCase() + companyPart.slice(1);
            return { name: splitJoinedCompanyName(name), website: `https://${host}`, logo: null, email: null };
        }
    }
    catch { /* no-op */ }
    return null;
}
/** Detect titles that are just "company careers" or "company jobs" rather than real job titles */
function isCareersPageTitle(title) {
    return /^.{2,30}\s+(careers?|jobs?|openings?|opportunities)$/i.test(title.trim());
}
function extractTitleFromPage(html, seedTitle, jsonLd) {
    if (jsonLd) {
        const t = cleanText(String(jsonLd.title ?? ""));
        if (t && !isCareersPageTitle(t))
            return t;
    }
    const $ = load(html);
    const h1 = cleanText($("h1").first().text());
    if (h1 && h1.length > 3 && h1.length < 200 && !isCareersPageTitle(h1))
        return h1;
    // If seed title is a careers-page title, still return it but it will be flagged for AI fix
    return seedTitle;
}
function inferWorkTypeFromJsonLd(jsonLd) {
    const locationType = cleanText(String(jsonLd.jobLocationType ?? "")).toUpperCase();
    if (locationType === "TELECOMMUTE")
        return "REMOTE";
    return null;
}
function inferWorkType(title, description, location) {
    const combined = `${title} ${description} ${location?.formattedAddress ?? ""}`.toLowerCase();
    if (/\b(remote|work from home|distributed)\b/.test(combined))
        return "REMOTE";
    if (/\b(hybrid|flexible office)\b/.test(combined))
        return "HYBRID";
    if (/\b(on[- ]?site|onsite|in office|studio based)\b/.test(combined))
        return "ONSITE";
    return null;
}
function getVisibleText(html) {
    const $ = load(html);
    $("script,style,noscript,svg,canvas,iframe").remove();
    return cleanText($("body").text()).slice(0, 15000);
}
// ─── Build job from heuristic extraction ─────────────────────────
export function buildJobFromHeuristics(html, finalUrl, seedTitle, jsonLd, hiringTeamUid) {
    const title = extractTitleFromPage(html, seedTitle, jsonLd);
    const description = extractDescriptionHtml(html, jsonLd) || extractDescriptionFromHtml(html, jsonLd) || "For job details, click apply.";
    const location = jsonLd ? extractLocationFromJsonLd(jsonLd) : null;
    const salary = (jsonLd ? extractSalaryFromJsonLd(jsonLd) : null) ?? extractSalaryFromText(description);
    const jobType = jsonLd ? inferJobTypeFromJsonLd(jsonLd) : "FULLTIME";
    const jsonLdWorkType = jsonLd ? inferWorkTypeFromJsonLd(jsonLd) : null;
    const workType = jsonLdWorkType ?? inferWorkType(title, description, location);
    const plainDescription = stripHtmlToPlain(description);
    const jsonLdSkills = jsonLd ? extractSkillsFromJsonLd(jsonLd) : [];
    const textSkills = extractSkillsFromText(title, plainDescription);
    const skills = dedupeStrings([...jsonLdSkills, ...textSkills]);
    const jsonLdKeywords = jsonLd ? extractKeywordsFromJsonLd(jsonLd) : [];
    const textKeywords = extractKeywordsFromText(title, plainDescription);
    const keywords = dedupeStrings([...jsonLdKeywords, ...textKeywords]);
    const workEmail = extractWorkEmail(html, plainDescription);
    let company = jsonLd ? extractCompanyFromJsonLd(jsonLd, finalUrl) : extractCompanyFromJsonLd({}, finalUrl);
    if (company && !company.email && workEmail) {
        company = { ...company, email: workEmail };
    }
    return {
        title,
        description,
        jobType,
        workType,
        location,
        salary,
        company,
        keywords,
        skills,
        deadline: jsonLd ? (cleanText(String(jsonLd.validThrough ?? "")) || null) : null,
        numberOfPositions: null,
        jobLink: finalUrl,
        hiringTeam: [hiringTeamUid],
        workEmail: workEmail ?? undefined,
        screeningQuestions: [],
        screeningRequired: false,
        allowEmailApplications: workEmail !== null,
    };
}
// ─── Merge AI results with heuristic data ────────────────────────
function mergeWithAi(heuristic, aiResult) {
    // AI provides better descriptions and field extraction,
    // but heuristic JSON-LD data is more reliable for structured fields
    return {
        ...aiResult,
        // Keep heuristic location/salary/company if they exist (from JSON-LD, more accurate)
        location: heuristic.location ?? aiResult.location,
        salary: heuristic.salary ?? aiResult.salary,
        company: heuristic.company?.name ? heuristic.company : aiResult.company,
        // Prefer AI description if heuristic was placeholder
        description: isPlaceholderDescription(heuristic.description) ? aiResult.description : heuristic.description,
        // Use AI for keywords/skills (better extraction)
        keywords: aiResult.keywords?.length ? aiResult.keywords : heuristic.keywords,
        skills: aiResult.skills?.length ? aiResult.skills : heuristic.skills,
        // Keep structured fields
        jobLink: heuristic.jobLink,
        hiringTeam: heuristic.hiringTeam,
        jobType: heuristic.jobType !== "FULLTIME" ? heuristic.jobType : aiResult.jobType,
        workType: heuristic.workType ?? aiResult.workType,
        deadline: heuristic.deadline ?? aiResult.deadline,
        numberOfPositions: heuristic.numberOfPositions ?? aiResult.numberOfPositions,
        screeningQuestions: [],
        screeningRequired: false,
        workEmail: heuristic.workEmail,
        allowEmailApplications: heuristic.allowEmailApplications ?? false,
    };
}
function isPlaceholderDescription(desc) {
    const plain = desc.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    return plain.length < 100 || /^for job details/i.test(plain);
}
// ─── Concurrency Helper ──────────────────────────────────────────
async function runConcurrent(items, concurrency, worker) {
    const results = new Array(items.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (true) {
            const i = cursor++;
            if (i >= items.length)
                break;
            results[i] = await worker(items[i], i);
        }
    });
    await Promise.all(workers);
    return results;
}
// ─── CSV Output ──────────────────────────────────────────────────
function csvEscape(value) {
    if (value.includes(",") || value.includes("\n") || value.includes('"')) {
        return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
}
function formatDescriptionForCsv(description) {
    const normalized = description.replace(/\r\n?/g, " ").trim();
    if (!normalized)
        return "";
    return normalized.replace(/>\s+</g, "><").replace(/\s{2,}/g, " ").trim();
}
export function toCsvRows(records) {
    const headers = [
        "title", "description", "jobType", "deadline", "keywords", "skills",
        "jobLink", "hiringTeam", "workType", "workEmail", "allowEmailApplications", "numberOfPositions",
        "company", "companyWebsite", "companyLogo", "companyEmail",
        "locationName", "formattedAddress", "city", "state", "country",
        "latitude", "longitude", "salaryMin", "salaryMax", "salaryCurrency", "salaryPeriod",
    ];
    const rows = [headers.join(",")];
    for (const job of records) {
        const descForCsv = formatDescriptionForCsv(job.description);
        const row = [
            job.title, descForCsv, job.jobType, job.deadline ?? "",
            (job.keywords ?? []).join("|"), (job.skills ?? []).join("|"),
            job.jobLink ?? "", (job.hiringTeam ?? []).join("|"),
            job.workType ?? "", job.workEmail ?? "",
            job.allowEmailApplications ? "true" : "false",
            job.numberOfPositions ? String(job.numberOfPositions) : "",
            job.company?.name ?? "", job.company?.website ?? "",
            job.company?.logo ?? "", job.company?.email ?? "",
            job.location?.name ?? "", job.location?.formattedAddress ?? "",
            job.location?.city ?? "", job.location?.state ?? "",
            job.location?.country ?? "",
            job.location ? String(job.location.latitude ?? 0) : "",
            job.location ? String(job.location.longitude ?? 0) : "",
            job.salary?.min != null ? String(job.salary.min) : "",
            job.salary?.max != null ? String(job.salary.max) : "",
            job.salary?.currency ?? "", job.salary?.period ?? "",
        ].map(v => csvEscape(String(v)));
        rows.push(row.join(","));
    }
    return rows.join("\n");
}
// ─── Deduplication ───────────────────────────────────────────────
function canonicalizeUrl(url) {
    try {
        const parsed = new URL(url);
        parsed.hash = "";
        for (const key of [...parsed.searchParams.keys()]) {
            if (/^utm_/i.test(key) || /^(ref|source|src|trk|tracking)$/i.test(key)) {
                parsed.searchParams.delete(key);
            }
        }
        return parsed.toString().replace(/\/$/, "");
    }
    catch {
        return url.trim();
    }
}
function dedupeJobs(jobs) {
    const seen = new Map();
    for (const job of jobs) {
        const key = `${(job.title ?? "").toLowerCase()}|${canonicalizeUrl(job.jobLink ?? "").toLowerCase()}`;
        if (!seen.has(key))
            seen.set(key, job);
    }
    return Array.from(seen.values());
}
// ─── Main Pipeline ───────────────────────────────────────────────
async function main() {
    const startedAt = new Date().toISOString();
    const options = parseCliOptions();
    const inputPath = path.resolve(process.cwd(), options.input);
    logInfo("Reading CSV input", { inputPath });
    const csvContent = await readFile(inputPath, "utf8");
    let rows = parseCsv(csvContent);
    logInfo(`Parsed ${rows.length} job URLs from CSV`);
    // Dedupe by URL
    const urlSeen = new Set();
    rows = rows.filter(row => {
        const key = canonicalizeUrl(row.jobLink).toLowerCase();
        if (urlSeen.has(key))
            return false;
        urlSeen.add(key);
        return true;
    });
    if (options.maxJobs) {
        rows = rows.slice(0, options.maxJobs);
    }
    logInfo(`Processing ${rows.length} unique jobs`, {
        concurrency: options.concurrency,
        skipAi: options.skipAi,
    });
    let fetchedCount = 0;
    let failedCount = 0;
    let jsonLdCount = 0;
    const fetchResults = await runConcurrent(rows, options.concurrency, async (row, index) => {
        const result = {
            row,
            html: null,
            finalUrl: row.jobLink,
            jsonLd: null,
            heuristicJob: null,
            fetchError: false,
        };
        try {
            const fetched = await fetchJobPage(row.jobLink);
            if (!fetched) {
                result.fetchError = true;
                failedCount++;
                return result;
            }
            result.html = fetched.html;
            result.finalUrl = fetched.finalUrl;
            result.jsonLd = extractJsonLdJobPosting(fetched.html);
            if (result.jsonLd)
                jsonLdCount++;
            result.heuristicJob = buildJobFromHeuristics(fetched.html, fetched.finalUrl, row.title, result.jsonLd, options.hiringTeamUid);
            fetchedCount++;
        }
        catch (err) {
            result.fetchError = true;
            failedCount++;
        }
        if ((fetchedCount + failedCount) % 50 === 0) {
            logInfo(`Progress: ${fetchedCount + failedCount}/${rows.length} (${fetchedCount} ok, ${failedCount} failed, ${jsonLdCount} with JSON-LD)`);
        }
        return result;
    });
    logInfo("Fetch phase complete", { fetched: fetchedCount, failed: failedCount, jsonLd: jsonLdCount });
    // ── Phase 2: AI enrichment for incomplete jobs ─────────────────
    const allJobs = [];
    const needsAi = [];
    for (let i = 0; i < fetchResults.length; i++) {
        const r = fetchResults[i];
        if (r.fetchError || !r.heuristicJob)
            continue;
        if (!options.skipAi && needsAiEnrichment(r.heuristicJob.description, r.jsonLd, r.heuristicJob.skills ?? undefined, r.heuristicJob.salary)) {
            needsAi.push({ index: allJobs.length, fetchResult: r });
        }
        allJobs.push(r.heuristicJob);
    }
    let aiEnriched = 0;
    let aiSkipped = 0;
    let aiFailed = 0;
    if (needsAi.length > 0 && !options.skipAi) {
        logInfo(`AI enrichment needed for ${needsAi.length} jobs`);
        await runConcurrent(needsAi, options.aiConcurrency, async ({ index, fetchResult }) => {
            try {
                const pageText = getVisibleText(fetchResult.html);
                const aiResult = await enrichWithAi({
                    title: fetchResult.row.title,
                    url: fetchResult.finalUrl,
                    pageText,
                    jsonLdData: fetchResult.jsonLd,
                    hiringTeamUid: options.hiringTeamUid,
                });
                if (aiResult) {
                    allJobs[index] = mergeWithAi(allJobs[index], aiResult);
                    aiEnriched++;
                }
                else {
                    aiSkipped++;
                }
            }
            catch (err) {
                aiFailed++;
                logWarn(`AI enrichment failed for ${fetchResult.row.jobLink}`);
            }
            if ((aiEnriched + aiSkipped + aiFailed) % 20 === 0) {
                logInfo(`AI progress: ${aiEnriched + aiSkipped + aiFailed}/${needsAi.length}`);
            }
        });
        logInfo("AI enrichment complete", { enriched: aiEnriched, skipped: aiSkipped, failed: aiFailed });
    }
    else if (options.skipAi) {
        logInfo("AI enrichment skipped (--skipAi flag)");
    }
    else {
        logInfo("No jobs need AI enrichment");
    }
    // ── Phase 3: Dedupe ──────────────────────────────────────────────
    const dedupedJobs = dedupeJobs(allJobs);
    logInfo(`Deduplication: ${allJobs.length} → ${dedupedJobs.length} jobs`);
    // ── Phase 4: Quality review (heuristic + AI for ambiguous) ─────
    logInfo(`Starting quality review on ${dedupedJobs.length} jobs`);
    const { reviewed: reviewedJobs, stats: reviewStats, instructions: reviewInstructions } = await reviewJobs(dedupedJobs, {
        aiConcurrency: options.aiConcurrency,
        skipAiReview: options.skipAi,
    });
    logInfo("Quality review complete", {
        total: reviewStats.total,
        ok: reviewStats.ok,
        fixed: reviewStats.fixed,
        dropped: reviewStats.dropped,
    });
    // Print pipeline improvement instructions to console
    if (reviewInstructions.instructions.length > 0) {
        console.log("\n" + reviewInstructions.summary + "\n");
    }
    // ── Phase 5: Output ────────────────────────────────────────────
    // Quality stats
    let withDescription = 0;
    let withLocation = 0;
    let withSalary = 0;
    let withCompany = 0;
    let withSkills = 0;
    for (const job of reviewedJobs) {
        if (!isPlaceholderDescription(job.description))
            withDescription++;
        if (job.location)
            withLocation++;
        if (job.salary)
            withSalary++;
        if (job.company?.name)
            withCompany++;
        if (job.skills && job.skills.length > 0)
            withSkills++;
    }
    const report = {
        startedAt,
        completedAt: new Date().toISOString(),
        inputFile: inputPath,
        totalCsvRows: rows.length,
        fetchedPages: fetchedCount,
        fetchFailed: failedCount,
        jsonLdFound: jsonLdCount,
        aiEnriched,
        aiFailed,
        finalJobs: reviewedJobs.length,
        qualityReview: {
            reviewed: reviewStats.total,
            ok: reviewStats.ok,
            fixed: reviewStats.fixed,
            dropped: reviewStats.dropped,
            issues: reviewStats.issues,
            pipelineInstructions: reviewInstructions.instructions,
        },
        quality: {
            withDescription,
            withLocation,
            withSalary,
            withCompany,
            withSkills,
        },
    };
    // Write outputs
    const outputDir = path.resolve(process.cwd(), options.outputDir);
    await mkdir(outputDir, { recursive: true });
    const apiJsonPath = path.join(outputDir, "results_enriched_api.json");
    const apiCsvPath = path.join(outputDir, "results_enriched_api.csv");
    const reportPath = path.join(outputDir, "results_enriched_report.json");
    const instructionsPath = path.join(outputDir, "pipeline_instructions.txt");
    await Promise.all([
        writeFile(apiJsonPath, JSON.stringify(reviewedJobs, null, 2), "utf8"),
        writeFile(apiCsvPath, toCsvRows(reviewedJobs), "utf8"),
        writeFile(reportPath, JSON.stringify(report, null, 2), "utf8"),
        writeFile(instructionsPath, reviewInstructions.summary, "utf8"),
    ]);
    logInfo("Pipeline complete", {
        apiJson: apiJsonPath,
        apiCsv: apiCsvPath,
        report: reportPath,
        pipelineInstructions: instructionsPath,
        ...report,
    });
    // Cleanup
    await closeBrowser();
}
const directRunHref = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === directRunHref) {
    main().catch((error) => {
        console.error(error);
        closeBrowser().finally(() => process.exit(1));
    });
}
