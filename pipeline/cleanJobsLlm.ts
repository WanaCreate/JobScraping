import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ApiCreateJobRequest } from "../types.js";
import { canonicalizeUrl } from "../utils/jobCleaner.js";

type LlmAction = "keep" | "remove" | "rewrite";

interface LlmDecision {
  action: LlmAction;
  cleaned_title: string | null;
  cleaned_description: string | null;
  reason: string;
  confidence: number;
}

interface FlaggedRecord {
  index: number;
  reasons: string[];
  job: ApiCreateJobRequest;
}

interface CliOptions {
  input: string;
  outputJson: string;
  outputCsv: string;
  outputReport: string;
  model: string;
  maxLlmRecords: number;
  minConfidence: number;
  dryRun: boolean;
  concurrency: number;
  syncLatest: boolean;
}

interface LlmReport {
  startedAt: string;
  inputFile: string;
  totalJobs: number;
  flaggedRecords: number;
  sentToLlm: number;
  llmKeep: number;
  llmRewrite: number;
  llmRemove: number;
  fallbackKeepOnError: number;
  finalJobs: number;
  removedJobs: number;
  rewrittenJobs: number;
  syncedLatest: boolean;
  flagReasonCounts: Record<string, number>;
  sampleFlags: Array<{ title: string; jobLink: string; reasons: string[] }>;
  sampleRemoved: Array<{ title: string; jobLink: string; reason: string; confidence: number }>;
  sampleRewritten: Array<{ title: string; jobLink: string; reason: string; confidence: number }>;
}

const DEFAULT_INPUT =
  "C:\\Users\\vyash\\Desktop\\Business\\Wana\\_Code\\JobScraping\\outputs\\api-ready\\latest\\results_jobs_api.json";
const DEFAULT_OUTPUT_JSON =
  "C:\\Users\\vyash\\Desktop\\Business\\Wana\\_Code\\JobScraping\\outputs\\api-ready\\latest\\results_jobs_api.llm.json";
const DEFAULT_OUTPUT_CSV =
  "C:\\Users\\vyash\\Desktop\\Business\\Wana\\_Code\\JobScraping\\outputs\\api-ready\\latest\\results_jobs_api.llm.csv";
const DEFAULT_OUTPUT_REPORT =
  "C:\\Users\\vyash\\Desktop\\Business\\Wana\\_Code\\JobScraping\\outputs\\api-ready\\latest\\results_jobs_quality_report.llm.json";

const PLACEHOLDER_DESC = "For job details, click apply.";

function parseArgs(argv: string[]): CliOptions {
  const positional = argv.filter((x, i) => {
    if (x.startsWith("--")) return false;
    if (i > 0 && argv[i - 1].startsWith("--")) return false;
    return true;
  });
  const get = (flag: string): string | undefined => {
    const idx = argv.indexOf(flag);
    if (idx < 0 || idx + 1 >= argv.length) return undefined;
    return argv[idx + 1];
  };
  const has = (flag: string): boolean => argv.includes(flag);

  return {
    input: get("--input") ?? positional[0] ?? DEFAULT_INPUT,
    outputJson: get("--outputJson") ?? DEFAULT_OUTPUT_JSON,
    outputCsv: get("--outputCsv") ?? DEFAULT_OUTPUT_CSV,
    outputReport: get("--outputReport") ?? DEFAULT_OUTPUT_REPORT,
    model: get("--model") ?? process.env.LLM_CLEANER_MODEL ?? "gpt-4o-mini",
    maxLlmRecords: Number(get("--maxLlmRecords") ?? positional[1] ?? "220"),
    minConfidence: Number(get("--minConfidence") ?? "0.75"),
    dryRun: has("--dryRun"),
    concurrency: Math.max(1, Number(get("--concurrency") ?? positional[2] ?? "4")),
    syncLatest: has("--syncLatest"),
  };
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\u00A0/g, " ").replace(/\s+/g, " ").trim();
}

function stripHtml(value: string): string {
  return value
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");
}

function cleanupTitle(title: string): string {
  let t = normalizeWhitespace(title);
  t = t.replace(/^\s*(back to jobs?|back to search results?)\s*/i, "");
  t = t.replace(/^\s*(open positions?\s*-\s*)/i, "");
  t = t.replace(/\s*[-|:]\s*$/, "").trim();
  return normalizeWhitespace(t);
}

function cleanupDescription(description: string): string {
  let d = normalizeWhitespace(stripHtml(description));
  d = d.replace(
    /^\s*(?:now\s*)?(?:back\s*to\s*jobs?|back\s*to\s*search\s*results?|search\s*results?)\s*[:|>\-–—]*\s*/i,
    ""
  );
  d = d.replace(
    /(?:take\s*20%\s*off any new website plan|use code at checkout|offer termsclose|discount applies to the first payment|payments through in-app pay)[\s\S]{0,500}/i,
    " "
  );
  d = d.replace(
    /(CXT\.CLIENT_SIDE_METRICS|CXT\.ANALYTICS|#\$\(['"][^'"]+['"]\)\.click|share this job)[\s\S]{0,900}/gi,
    " "
  );
  d = d.replace(/\s+/g, " ").trim();
  return d || PLACEHOLDER_DESC;
}

function hasJobIdSignal(url: string): boolean {
  try {
    const u = new URL(url);
    if (/\/\d{5,}(\/|$)/.test(u.pathname)) return true;
    for (const [key, value] of u.searchParams.entries()) {
      const k = key.toLowerCase();
      if (/^(gh_jid|jobid|job_id|requisition|req(id)?|opening(id)?|posting(id)?|position(id)?|vacancy(id)?|id)$/.test(k)) {
        if (String(value).trim()) return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

function isLikelyListingPage(url: string): boolean {
  try {
    const u = new URL(url);
    const p = u.pathname.toLowerCase().replace(/\/+$/, "");
    return (
      p === "/careers" ||
      p === "/career" ||
      p === "/jobs" ||
      p === "/job" ||
      p === "/about/careers" ||
      p === "/en/work-with-us/jobs" ||
      p === "/careers/open-positions"
    );
  } catch {
    return false;
  }
}

function flagJob(job: ApiCreateJobRequest, index: number): FlaggedRecord | null {
  const title = normalizeWhitespace(job.title ?? "");
  const url = normalizeWhitespace(job.jobLink ?? "");
  const desc = normalizeWhitespace(job.description ?? "");
  const reasons: string[] = [];

  if (!url) reasons.push("missing_url");
  if (desc === PLACEHOLDER_DESC) reasons.push("placeholder_description");
  if (/back\s*to\s*jobs?|back\s*to\s*search\s*results?|search\s*results?/i.test(desc)) reasons.push("breadcrumb_prefix");
  if (/take\s*20%\s*off any new website plan|use code at checkout|offer termsclose/i.test(desc))
    reasons.push("promo_marketing_noise");
  if (isLikelyListingPage(url) && !hasJobIdSignal(url)) reasons.push("listing_page_url");
  if (/^open positions?\s*-\s*/i.test(title)) reasons.push("listing_prefix_title");
  if (desc.length < 80 && (reasons.includes("listing_page_url") || reasons.includes("listing_prefix_title"))) {
    reasons.push("short_description");
  }

  if (reasons.length === 0) return null;
  return { index, reasons, job };
}

function compactJob(job: ApiCreateJobRequest): Record<string, unknown> {
  const desc = normalizeWhitespace(job.description ?? "");
  return {
    title: normalizeWhitespace(job.title ?? ""),
    jobLink: normalizeWhitespace(job.jobLink ?? ""),
    company: normalizeWhitespace(job.company?.name ?? ""),
    description_preview: desc.slice(0, 3000),
    description_length: desc.length,
    jobType: job.jobType ?? null,
    workType: job.workType ?? null,
  };
}

function parseDecision(raw: string): LlmDecision | null {
  const text = raw.trim();
  try {
    const parsed = JSON.parse(text) as Partial<LlmDecision>;
    if (!parsed || typeof parsed !== "object") return null;
    const action = parsed.action;
    if (action !== "keep" && action !== "remove" && action !== "rewrite") return null;
    const confidence =
      typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
        ? Math.max(0, Math.min(1, parsed.confidence))
        : 0.5;
    return {
      action,
      cleaned_title: typeof parsed.cleaned_title === "string" ? parsed.cleaned_title : null,
      cleaned_description:
        typeof parsed.cleaned_description === "string" ? parsed.cleaned_description : null,
      reason: typeof parsed.reason === "string" ? parsed.reason : "no_reason",
      confidence,
    };
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return parseDecision(match[0]);
    } catch {
      return null;
    }
  }
}

function getApiKey(): string | null {
  return process.env.LLM_CLEANER_API_KEY ?? process.env.OPENAI_API_KEY ?? null;
}

function getBaseUrl(): string {
  const base = process.env.LLM_CLEANER_BASE_URL ?? "https://api.openai.com/v1";
  return base.replace(/\/+$/, "");
}

async function callLlmDecision(
  flagged: FlaggedRecord,
  options: CliOptions
): Promise<LlmDecision> {
  if (options.dryRun) {
    return {
      action: "keep",
      cleaned_title: null,
      cleaned_description: null,
      reason: "dry_run_keep",
      confidence: 0.99,
    };
  }

  const apiKey = getApiKey();
  if (!apiKey) {
    return {
      action: "keep",
      cleaned_title: null,
      cleaned_description: null,
      reason: "missing_api_key_keep",
      confidence: 0.99,
    };
  }

  const systemPrompt =
    "You are a strict job-data cleaner. Return JSON only. Never invent job facts. Keep jobLink/company unchanged. If unsure, keep.";
  const userPrompt = JSON.stringify(
    {
      task: "Classify and optionally rewrite a single job record.",
      output_schema: {
        action: "keep|remove|rewrite",
        cleaned_title: "string|null",
        cleaned_description: "string|null",
        reason: "string",
        confidence: "0..1",
      },
      rules: [
        "remove only if clearly non-job/listing page/noise",
        "rewrite only title/description to remove breadcrumbs, promo, scripts, nav noise",
        "if description remains weak but URL seems valid job, set description to 'For job details, click apply.'",
      ],
      flagged_reasons: flagged.reasons,
      record: compactJob(flagged.job),
    },
    null,
    2
  );

  const response = await fetch(`${getBaseUrl()}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: options.model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`LLM HTTP ${response.status}: ${text.slice(0, 300)}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content ?? "";
  const decision = parseDecision(content);
  if (!decision) {
    throw new Error("Failed to parse LLM JSON decision");
  }
  return decision;
}

async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];
  const out = new Array<R>(items.length);
  let cursor = 0;
  const threads = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = cursor;
      cursor += 1;
      if (i >= items.length) return;
      out[i] = await worker(items[i]);
    }
  });
  await Promise.all(threads);
  return out;
}

function escapeCsv(value: unknown): string {
  const s = String(value ?? "");
  if (s.includes('"') || s.includes(",") || s.includes("\n")) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(jobs: ApiCreateJobRequest[]): string {
  const header =
    "title,description,jobType,deadline,keywords,skills,jobLink,hiringTeam,workType,workEmail,numberOfPositions,company,companyWebsite,companyLogo,companyEmail,locationName,formattedAddress,city,state,country,latitude,longitude,salaryMin,salaryMax,salaryCurrency,salaryPeriod";
  const rows = jobs.map((job) => {
    const loc = job.location ?? ({} as ApiCreateJobRequest["location"]);
    const sal = job.salary ?? ({} as ApiCreateJobRequest["salary"]);
    const company = job.company ?? ({} as ApiCreateJobRequest["company"]);
    return [
      escapeCsv(job.title ?? ""),
      escapeCsv(job.description ?? ""),
      escapeCsv(job.jobType ?? "FULLTIME"),
      escapeCsv(job.deadline ?? ""),
      escapeCsv((job.keywords ?? []).join("|")),
      escapeCsv((job.skills ?? []).join("|")),
      escapeCsv(job.jobLink ?? ""),
      escapeCsv((job.hiringTeam ?? []).join("|")),
      escapeCsv(job.workType ?? ""),
      escapeCsv(job.workEmail ?? ""),
      escapeCsv(job.numberOfPositions ?? ""),
      escapeCsv(company?.name ?? ""),
      escapeCsv(company?.website ?? ""),
      escapeCsv(company?.logo ?? ""),
      escapeCsv(company?.email ?? ""),
      escapeCsv(loc?.name ?? ""),
      escapeCsv(loc?.formattedAddress ?? ""),
      escapeCsv(loc?.city ?? ""),
      escapeCsv(loc?.state ?? ""),
      escapeCsv(loc?.country ?? ""),
      escapeCsv(loc?.latitude ?? ""),
      escapeCsv(loc?.longitude ?? ""),
      escapeCsv(sal?.min ?? ""),
      escapeCsv(sal?.max ?? ""),
      escapeCsv(sal?.currency ?? ""),
      escapeCsv(sal?.period ?? ""),
    ].join(",");
  });
  return [header, ...rows].join("\n");
}

function applyPostCleanup(job: ApiCreateJobRequest): ApiCreateJobRequest {
  const title = cleanupTitle(job.title ?? "");
  const description = cleanupDescription(job.description ?? "");
  const jobLink = canonicalizeUrl(job.jobLink ?? "");
  return {
    ...job,
    title: title || (job.title ?? ""),
    description: description || PLACEHOLDER_DESC,
    jobLink: jobLink || (job.jobLink ?? ""),
  };
}

function dedupeByCanonicalLink(jobs: ApiCreateJobRequest[]): ApiCreateJobRequest[] {
  const seen = new Set<string>();
  const out: ApiCreateJobRequest[] = [];
  for (const job of jobs) {
    const key = canonicalizeUrl(job.jobLink ?? "").toLowerCase().trim();
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    out.push(job);
  }
  return out;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const startedAt = new Date().toISOString();

  const raw = await readFile(options.input, "utf8");
  const jobs = JSON.parse(raw) as ApiCreateJobRequest[];
  const flagged = jobs
    .map((job, index) => flagJob(job, index))
    .filter((x): x is FlaggedRecord => x !== null);
  const flagReasonCounts: Record<string, number> = {};
  for (const f of flagged) {
    for (const reason of f.reasons) {
      flagReasonCounts[reason] = (flagReasonCounts[reason] ?? 0) + 1;
    }
  }

  const toLlm = flagged.slice(0, Math.max(0, options.maxLlmRecords));

  let llmKeep = 0;
  let llmRewrite = 0;
  let llmRemove = 0;
  let fallbackKeepOnError = 0;
  let rewrittenJobs = 0;
  let removedJobs = 0;

  const decisions = await runWithConcurrency(toLlm, options.concurrency, async (item) => {
    try {
      return await callLlmDecision(item, options);
    } catch {
      fallbackKeepOnError += 1;
      return {
        action: "keep",
        cleaned_title: null,
        cleaned_description: null,
        reason: "llm_error_keep",
        confidence: 0,
      } as LlmDecision;
    }
  });

  const decisionsByIndex = new Map<number, LlmDecision>();
  toLlm.forEach((item, i) => decisionsByIndex.set(item.index, decisions[i]));

  const sampleRemoved: LlmReport["sampleRemoved"] = [];
  const sampleRewritten: LlmReport["sampleRewritten"] = [];
  const out: ApiCreateJobRequest[] = [];

  for (let i = 0; i < jobs.length; i += 1) {
    const source = jobs[i];
    const decision = decisionsByIndex.get(i);
    let current = applyPostCleanup(source);

    if (decision) {
      if (decision.action === "keep") llmKeep += 1;
      if (decision.action === "rewrite") llmRewrite += 1;
      if (decision.action === "remove") llmRemove += 1;

      if (decision.action === "remove" && decision.confidence >= options.minConfidence) {
        removedJobs += 1;
        if (sampleRemoved.length < 20) {
          sampleRemoved.push({
            title: current.title ?? "",
            jobLink: current.jobLink ?? "",
            reason: decision.reason,
            confidence: decision.confidence,
          });
        }
        continue;
      }

      if (decision.action === "rewrite") {
        const newTitle = cleanupTitle(decision.cleaned_title ?? current.title ?? "");
        const newDesc = cleanupDescription(decision.cleaned_description ?? current.description ?? "");
        if (newTitle && newTitle !== current.title) {
          current.title = newTitle;
        }
        if (newDesc && newDesc !== current.description) {
          current.description = newDesc;
        }
        rewrittenJobs += 1;
        if (sampleRewritten.length < 20) {
          sampleRewritten.push({
            title: current.title ?? "",
            jobLink: current.jobLink ?? "",
            reason: decision.reason,
            confidence: decision.confidence,
          });
        }
      }
    }

    out.push(current);
  }

  const deduped = dedupeByCanonicalLink(out);

  const report: LlmReport = {
    startedAt,
    inputFile: options.input,
    totalJobs: jobs.length,
    flaggedRecords: flagged.length,
    sentToLlm: toLlm.length,
    llmKeep,
    llmRewrite,
    llmRemove,
    fallbackKeepOnError,
    finalJobs: deduped.length,
    removedJobs,
    rewrittenJobs,
    syncedLatest: false,
    flagReasonCounts,
    sampleFlags: flagged.slice(0, 30).map((f) => ({
      title: f.job.title ?? "",
      jobLink: f.job.jobLink ?? "",
      reasons: f.reasons,
    })),
    sampleRemoved,
    sampleRewritten,
  };

  await writeFile(options.outputJson, JSON.stringify(deduped, null, 2), "utf8");
  await writeFile(options.outputCsv, toCsv(deduped), "utf8");
  await writeFile(options.outputReport, JSON.stringify(report, null, 2), "utf8");

  if (options.syncLatest) {
    const latestDir = path.dirname(options.input);
    await writeFile(path.join(latestDir, "results_jobs_api.json"), JSON.stringify(deduped, null, 2), "utf8");
    await writeFile(path.join(latestDir, "results_jobs_api.csv"), toCsv(deduped), "utf8");
    await writeFile(path.join(latestDir, "results_jobs_quality_report.json"), JSON.stringify(report, null, 2), "utf8");
    report.syncedLatest = true;
    await writeFile(options.outputReport, JSON.stringify(report, null, 2), "utf8");
  }

  console.log(`LLM clean pass: ${jobs.length} -> ${deduped.length}`);
  console.log(`Flagged: ${flagged.length}, Sent to LLM: ${toLlm.length}, Removed: ${removedJobs}, Rewritten: ${rewrittenJobs}`);
  console.log(`Outputs: ${options.outputJson}, ${options.outputCsv}, ${options.outputReport}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
