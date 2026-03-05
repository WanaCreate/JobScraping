import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { load } from "cheerio";
import { isCreativeTitleStrict } from "../utils/creativeClassifier.js";
import { enrichJobFromUrl } from "../utils/jobDetailExtractor.js";
import { logInfo, logWarn } from "../utils/logger.js";
const DESCRIPTION_PLACEHOLDER = "For job details, click apply.";
function getArg(flag) {
    const idx = process.argv.indexOf(flag);
    if (idx < 0)
        return null;
    const value = process.argv[idx + 1];
    return value && !value.startsWith("--") ? value : null;
}
function hasFlag(flag) {
    return process.argv.includes(flag);
}
function parseNumber(value, fallback) {
    if (!value)
        return fallback;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
function getPositionalArgs() {
    return process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
}
function toRunTag(date) {
    const yyyy = date.getUTCFullYear();
    const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(date.getUTCDate()).padStart(2, "0");
    const hh = String(date.getUTCHours()).padStart(2, "0");
    const min = String(date.getUTCMinutes()).padStart(2, "0");
    const ss = String(date.getUTCSeconds()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}_${hh}${min}${ss}Z`;
}
function getIsoWeekLabel(date) {
    const utc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    const day = utc.getUTCDay() || 7;
    utc.setUTCDate(utc.getUTCDate() + 4 - day);
    const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
    const week = Math.ceil(((utc.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
    return `${utc.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}
function parseCliOptions() {
    const hasFlags = process.argv.slice(2).some((arg) => arg.startsWith("--"));
    const positional = hasFlags ? [] : getPositionalArgs();
    const now = new Date();
    const defaultLatestDir = "outputs/api-ready/latest";
    const defaultHistoryDir = "outputs/api-ready/history";
    const input = getArg("--input") ?? positional[0] ?? "results_150_optimized.json";
    // Safety: only accept maxJobs through explicit flag to avoid accidental truncation.
    const maxJobsRaw = getArg("--maxJobs");
    const concurrency = parseNumber(getArg("--concurrency"), 10);
    const hiringTeamPositional = null;
    const latestDir = getArg("--latestDir") ?? defaultLatestDir;
    const historyDir = getArg("--historyDir") ?? defaultHistoryDir;
    const runTag = getArg("--runTag") ?? toRunTag(now);
    const output = getArg("--output") ?? `${latestDir}/results_jobs_enriched.json`;
    const apiOutput = getArg("--apiOutput") ?? `${latestDir}/results_jobs_api.json`;
    const csvOutput = getArg("--csvOutput") ?? `${latestDir}/results_jobs_api.csv`;
    const reportOutput = getArg("--reportOutput") ?? `${latestDir}/results_jobs_quality_report.json`;
    const writeHistory = !hasFlag("--noHistory");
    const minCreativeScore = parseNumber(getArg("--minCreativeScore"), 2);
    const maxJobs = maxJobsRaw ? parseNumber(maxJobsRaw, 0) : null;
    const hiringTeamUid = getArg("--hiringTeamUid") ??
        hiringTeamPositional ??
        process.env.HIRING_TEAM_UID ??
        "system-scraper";
    return {
        input,
        output,
        apiOutput,
        csvOutput,
        reportOutput,
        latestDir,
        historyDir,
        runTag,
        writeHistory,
        concurrency,
        hiringTeamUid,
        minCreativeScore,
        maxJobs: maxJobs && maxJobs > 0 ? maxJobs : null
    };
}
function canonicalizeJobUrl(rawUrl) {
    try {
        const parsed = new URL(rawUrl);
        parsed.hash = "";
        const keepParams = new URLSearchParams();
        for (const [key, value] of parsed.searchParams.entries()) {
            if (/^utm_/i.test(key))
                continue;
            if (/^(ref|source|src|trk|tracking)$/i.test(key))
                continue;
            keepParams.append(key, value);
        }
        parsed.search = keepParams.toString();
        return parsed.toString().replace(/\/$/, "");
    }
    catch {
        return rawUrl.trim();
    }
}
function normalizeWhitespace(value) {
    return value
        .replace(/\u00A0/g, " ")
        .replace(/[\t\r\n]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}
function isLikelyAtsHost(url) {
    return /(greenhouse\.io|lever\.co|smartrecruiters\.com|myworkdayjobs\.com|icims\.com|ashbyhq\.com|phenompeople\.com|workdayjobs\.com|amazon\.jobs|jobs\.google\.com|jobs\.ikea\.com)/i.test(url);
}
function hasJobPath(url) {
    return /\/(job|jobs|career|careers|position|positions|opening|openings)\b/i.test(url);
}
function hasNonJobPath(url) {
    return /\/(services?|portfolio|case-studies?|blog|news|insights|articles?|about|contact)\b/i.test(url);
}
function isLikelyJobUrl(url) {
    if (!url)
        return false;
    return isLikelyAtsHost(url) || hasJobPath(url);
}
function isLikelyMojibake(text) {
    const sample = text.slice(0, 5000);
    if (!sample)
        return false;
    if (/\uFFFD/.test(sample))
        return true;
    if (/[\u0080-\u009F]/.test(sample))
        return true;
    if (/\u00E2\u20AC[\u2018\u2019\u201C\u201D\u2013\u2014\u2026\u2122]/u.test(sample))
        return true;
    if (/\u00C3[\u0080-\u00BF]/.test(sample))
        return true;
    if (/(\u00CE[\u0080-\u00BF]|\u00CF[\u0080-\u00BF]){3,}/.test(sample))
        return true;
    return false;
}
function hasHtmlLikeContent(text) {
    return /<[^>]+>/.test(text);
}
function extractPlainTextFromRichText(input) {
    if (!input)
        return "";
    if (!hasHtmlLikeContent(input))
        return normalizeWhitespace(input);
    const $ = load(input);
    $("script,style,noscript,svg,canvas,iframe").remove();
    return normalizeWhitespace($.text());
}
function sanitizeHtmlForDisplay(input) {
    const allowedTags = new Set([
        "b",
        "strong",
        "i",
        "em",
        "u",
        "s",
        "strike",
        "br",
        "p",
        "div",
        "span",
        "ul",
        "ol",
        "li",
        "a",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "blockquote",
        "code",
        "pre",
        "hr"
    ]);
    const $ = load(input);
    $("script,style,noscript,svg,canvas,iframe").remove();
    $("*").each((_, node) => {
        if (!node || node.type !== "tag")
            return;
        const tag = String(node.tagName || "").toLowerCase();
        if (!allowedTags.has(tag)) {
            $(node).replaceWith($(node).contents());
            return;
        }
        if (tag === "a") {
            const href = String($(node).attr("href") || "").trim();
            if (!/^https?:\/\//i.test(href)) {
                $(node).replaceWith($(node).contents());
                return;
            }
            $(node).attr("href", href);
            $(node).attr("target", "_blank");
            $(node).attr("rel", "noopener noreferrer");
            Object.keys(node.attribs ?? {}).forEach((key) => {
                const safe = key === "href" || key === "target" || key === "rel";
                if (!safe)
                    $(node).removeAttr(key);
            });
            return;
        }
        Object.keys(node.attribs ?? {}).forEach((key) => $(node).removeAttr(key));
    });
    const html = String($("body").html() ?? "").trim();
    const plain = extractPlainTextFromRichText(html);
    return plain.length > 0 ? html : "";
}
function normalizeApiDescription(description, jobLink) {
    const raw = normalizeWhitespace(description ?? "");
    const canonicalLink = canonicalizeJobUrl(jobLink ?? "");
    const jobLike = isLikelyJobUrl(canonicalLink) && !hasNonJobPath(canonicalLink);
    if (!raw)
        return DESCRIPTION_PLACEHOLDER;
    if (isLikelyMojibake(raw) && jobLike) {
        return DESCRIPTION_PLACEHOLDER;
    }
    if (hasHtmlLikeContent(raw)) {
        const safeHtml = sanitizeHtmlForDisplay(raw);
        const safePlain = extractPlainTextFromRichText(safeHtml);
        if (safePlain.length >= 40) {
            return safeHtml;
        }
        const plain = extractPlainTextFromRichText(raw);
        if (plain.length >= 40) {
            return plain;
        }
        return jobLike ? DESCRIPTION_PLACEHOLDER : plain || DESCRIPTION_PLACEHOLDER;
    }
    return raw;
}
function asNormalizedJob(item) {
    if (!item || typeof item !== "object")
        return null;
    const record = item;
    const title = typeof record.title === "string" ? record.title.trim() : "";
    const url = typeof record.url === "string" ? record.url.trim() : "";
    if (!title || !url || !/^https?:\/\//i.test(url))
        return null;
    return {
        title,
        url,
        location: typeof record.location === "string" ? record.location : "Not specified",
        ats: typeof record.ats === "string" ? record.ats : "generic",
        company: typeof record.company === "string" ? record.company : "unknown",
        source: typeof record.source === "string" ? record.source : url
    };
}
function flattenInputToJobs(payload) {
    if (!Array.isArray(payload))
        return [];
    const jobs = [];
    for (const entry of payload) {
        if (!entry || typeof entry !== "object")
            continue;
        const record = entry;
        if (Array.isArray(record.creative_jobs)) {
            const creativeJobs = record.creative_jobs;
            for (const job of creativeJobs) {
                const normalized = asNormalizedJob(job);
                if (normalized)
                    jobs.push(normalized);
            }
            continue;
        }
        const normalized = asNormalizedJob(record);
        if (normalized)
            jobs.push(normalized);
    }
    return jobs;
}
function dedupeJobs(jobs) {
    const dedupe = new Map();
    for (const job of jobs) {
        const key = `${canonicalizeJobUrl(job.url).toLowerCase()}|${job.title.toLowerCase()}`;
        if (!dedupe.has(key)) {
            dedupe.set(key, {
                ...job,
                url: canonicalizeJobUrl(job.url)
            });
        }
    }
    return Array.from(dedupe.values());
}
async function runWithConcurrency(items, concurrency, worker) {
    if (items.length === 0)
        return [];
    const results = new Array(items.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (true) {
            const index = cursor;
            cursor += 1;
            if (index >= items.length)
                break;
            results[index] = await worker(items[index]);
        }
    });
    await Promise.all(workers);
    return results;
}
function validateRequiredFields(apiJob) {
    const missing = [];
    if (!apiJob.title?.trim())
        missing.push("title");
    if (!apiJob.description?.trim())
        missing.push("description");
    if (!apiJob.jobType)
        missing.push("jobType");
    if (!Array.isArray(apiJob.hiringTeam) || apiJob.hiringTeam.length === 0)
        missing.push("hiringTeam");
    return missing;
}
function buildQualityReport(params) {
    const missingFieldCounts = {
        location: 0,
        salary: 0,
        company: 0,
        workType: 0,
        deadline: 0,
        skills: 0,
        keywords: 0,
        workEmail: 0,
        jobLink: 0
    };
    let requiredFieldFailures = 0;
    for (const record of params.enrichedJobs) {
        const apiJob = record.apiJob;
        if (!apiJob.location)
            missingFieldCounts.location += 1;
        if (!apiJob.salary)
            missingFieldCounts.salary += 1;
        if (!apiJob.company)
            missingFieldCounts.company += 1;
        if (!apiJob.workType)
            missingFieldCounts.workType += 1;
        if (!apiJob.deadline)
            missingFieldCounts.deadline += 1;
        if (!apiJob.skills || apiJob.skills.length === 0)
            missingFieldCounts.skills += 1;
        if (!apiJob.keywords || apiJob.keywords.length === 0)
            missingFieldCounts.keywords += 1;
        if (!apiJob.workEmail)
            missingFieldCounts.workEmail += 1;
        if (!apiJob.jobLink)
            missingFieldCounts.jobLink += 1;
        if (validateRequiredFields(apiJob).length > 0) {
            requiredFieldFailures += 1;
        }
    }
    return {
        startedAt: params.startedAt,
        inputFile: params.inputFile,
        discoveredJobs: params.discoveredJobs,
        prefilteredCreativeJobs: params.prefilteredCreativeJobs,
        dedupedJobs: params.dedupedJobs,
        attemptedEnrichment: params.dedupedJobs,
        enrichedJobs: params.enrichedJobs.length,
        apiReadyJobs: params.apiJobsCount,
        finalDedupedJobs: params.apiJobsCount,
        missingFieldCounts,
        requiredFieldFailures
    };
}
function csvEscape(value) {
    if (value.includes(",") || value.includes("\n") || value.includes("\"")) {
        return `"${value.replace(/\"/g, '""')}"`;
    }
    return value;
}
function toCsvRows(records) {
    const headers = [
        "title",
        "description",
        "jobType",
        "deadline",
        "keywords",
        "skills",
        "jobLink",
        "hiringTeam",
        "workType",
        "workEmail",
        "numberOfPositions",
        "company",
        "companyWebsite",
        "companyLogo",
        "companyEmail",
        "locationName",
        "formattedAddress",
        "city",
        "state",
        "country",
        "latitude",
        "longitude",
        "salaryMin",
        "salaryMax",
        "salaryCurrency",
        "salaryPeriod"
    ];
    const rows = [headers.join(",")];
    for (const job of records) {
        const row = [
            job.title,
            job.description,
            job.jobType,
            job.deadline ?? "",
            (job.keywords ?? []).join("|"),
            (job.skills ?? []).join("|"),
            job.jobLink ?? "",
            (job.hiringTeam ?? []).join("|"),
            job.workType ?? "",
            job.workEmail ?? "",
            job.numberOfPositions ? String(job.numberOfPositions) : "",
            job.company?.name ?? "",
            job.company?.website ?? "",
            job.company?.logo ?? "",
            job.company?.email ?? "",
            job.location?.name ?? "",
            job.location?.formattedAddress ?? "",
            job.location?.city ?? "",
            job.location?.state ?? "",
            job.location?.country ?? "",
            job.location ? String(job.location.latitude ?? 0) : "",
            job.location ? String(job.location.longitude ?? 0) : "",
            job.salary?.min !== null && job.salary?.min !== undefined ? String(job.salary.min) : "",
            job.salary?.max !== null && job.salary?.max !== undefined ? String(job.salary.max) : "",
            job.salary?.currency ?? "",
            job.salary?.period ?? ""
        ].map((value) => csvEscape(String(value)));
        rows.push(row.join(","));
    }
    return rows.join("\n");
}
async function ensureParentDir(filePath) {
    const directory = path.dirname(filePath);
    await mkdir(directory, { recursive: true });
}
async function writeManifest(params) {
    const manifest = {
        generatedAt: new Date().toISOString(),
        runTag: params.runTag,
        inputFile: params.inputPath,
        apiJson: path.basename(params.apiPath),
        apiCsv: path.basename(params.csvPath),
        enrichedJson: path.basename(params.enrichedPath),
        qualityReport: path.basename(params.reportPath),
        apiRecordCount: params.report.apiReadyJobs,
        summary: {
            discoveredJobs: params.report.discoveredJobs,
            prefilteredCreativeJobs: params.report.prefilteredCreativeJobs,
            attemptedEnrichment: params.report.attemptedEnrichment,
            enrichedJobs: params.report.enrichedJobs,
            apiReadyJobs: params.report.apiReadyJobs
        }
    };
    await ensureParentDir(params.manifestPath);
    await writeFile(params.manifestPath, JSON.stringify(manifest, null, 2), "utf8");
}
async function main() {
    const startedAt = new Date().toISOString();
    const options = parseCliOptions();
    const inputPath = path.resolve(process.cwd(), options.input);
    logInfo("Loading scraper output", { inputPath });
    const rawInput = await readFile(inputPath, "utf8");
    const parsed = JSON.parse(rawInput);
    const discoveredJobs = flattenInputToJobs(parsed);
    const prefilteredCreativeJobs = discoveredJobs.filter((job) => isCreativeTitleStrict(job.title) && /^https?:\/\//i.test(job.url));
    const dedupedJobs = dedupeJobs(prefilteredCreativeJobs);
    const scopedJobs = options.maxJobs ? dedupedJobs.slice(0, options.maxJobs) : dedupedJobs;
    logInfo("Starting job detail enrichment", {
        discoveredJobs: discoveredJobs.length,
        prefilteredCreativeJobs: prefilteredCreativeJobs.length,
        dedupedJobs: dedupedJobs.length,
        selectedJobs: scopedJobs.length,
        concurrency: options.concurrency,
        minCreativeScore: options.minCreativeScore
    });
    const enrichedRaw = await runWithConcurrency(scopedJobs, options.concurrency, async (job) => enrichJobFromUrl({
        seed: job,
        hiringTeamUid: options.hiringTeamUid,
        minCreativeScore: options.minCreativeScore
    }));
    const enriched = enrichedRaw
        .filter((record) => record !== null)
        .map((record) => ({
        ...record,
        apiJob: {
            ...record.apiJob,
            description: normalizeApiDescription(record.apiJob.description, record.apiJob.jobLink)
        }
    }));
    const dedupedApi = new Map();
    for (const record of enriched) {
        const key = `${(record.apiJob.title ?? "").toLowerCase()}|${canonicalizeJobUrl(record.apiJob.jobLink ?? "").toLowerCase()}`;
        if (!dedupedApi.has(key))
            dedupedApi.set(key, record.apiJob);
    }
    const apiJobs = Array.from(dedupedApi.values());
    const report = buildQualityReport({
        startedAt,
        inputFile: inputPath,
        discoveredJobs: discoveredJobs.length,
        prefilteredCreativeJobs: prefilteredCreativeJobs.length,
        dedupedJobs: scopedJobs.length,
        enrichedJobs: enriched,
        apiJobsCount: apiJobs.length
    });
    const enrichedPath = path.resolve(process.cwd(), options.output);
    const apiPath = path.resolve(process.cwd(), options.apiOutput);
    const csvPath = path.resolve(process.cwd(), options.csvOutput);
    const reportPath = path.resolve(process.cwd(), options.reportOutput);
    await Promise.all([
        ensureParentDir(enrichedPath),
        ensureParentDir(apiPath),
        ensureParentDir(csvPath),
        ensureParentDir(reportPath)
    ]);
    await writeFile(enrichedPath, JSON.stringify(enriched, null, 2), "utf8");
    await writeFile(apiPath, JSON.stringify(apiJobs, null, 2), "utf8");
    await writeFile(csvPath, toCsvRows(apiJobs), "utf8");
    await writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
    const latestManifestPath = path.join(path.dirname(apiPath), "manifest.json");
    await writeManifest({
        manifestPath: latestManifestPath,
        inputPath,
        runTag: options.runTag,
        apiPath,
        csvPath,
        enrichedPath,
        reportPath,
        report
    });
    let historyBasePath = null;
    if (options.writeHistory) {
        const weekLabel = getIsoWeekLabel(new Date());
        historyBasePath = path.resolve(process.cwd(), options.historyDir, weekLabel, options.runTag);
        const historyEnrichedPath = path.join(historyBasePath, path.basename(enrichedPath));
        const historyApiPath = path.join(historyBasePath, path.basename(apiPath));
        const historyCsvPath = path.join(historyBasePath, path.basename(csvPath));
        const historyReportPath = path.join(historyBasePath, path.basename(reportPath));
        await Promise.all([
            ensureParentDir(historyEnrichedPath),
            ensureParentDir(historyApiPath),
            ensureParentDir(historyCsvPath),
            ensureParentDir(historyReportPath)
        ]);
        await writeFile(historyEnrichedPath, JSON.stringify(enriched, null, 2), "utf8");
        await writeFile(historyApiPath, JSON.stringify(apiJobs, null, 2), "utf8");
        await writeFile(historyCsvPath, toCsvRows(apiJobs), "utf8");
        await writeFile(historyReportPath, JSON.stringify(report, null, 2), "utf8");
        await writeManifest({
            manifestPath: path.join(historyBasePath, "manifest.json"),
            inputPath,
            runTag: options.runTag,
            apiPath: historyApiPath,
            csvPath: historyCsvPath,
            enrichedPath: historyEnrichedPath,
            reportPath: historyReportPath,
            report
        });
    }
    if (report.requiredFieldFailures > 0) {
        logWarn("Some records still fail required API fields", {
            requiredFieldFailures: report.requiredFieldFailures,
            apiReadyJobs: report.apiReadyJobs
        });
    }
    logInfo("Job detail collection completed", {
        enrichedOutput: enrichedPath,
        apiOutput: apiPath,
        csvOutput: csvPath,
        reportOutput: reportPath,
        latestManifest: latestManifestPath,
        historySnapshot: historyBasePath,
        ...report
    });
}
const directRunHref = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === directRunHref) {
    main().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}
