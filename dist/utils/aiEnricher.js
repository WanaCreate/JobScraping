const JOB_TYPE_VALUES = new Set(["GIG", "FULLTIME", "PARTTIME", "FREELANCE"]);
const WORK_TYPE_VALUES = new Set(["ONSITE", "HYBRID", "REMOTE"]);
const SALARY_PERIOD_VALUES = new Set(["HOURLY", "DAILY", "WEEKLY", "MONTHLY", "ANNUAL", "ONE_TIME"]);
function getAnthropicApiKey() {
    return process.env.ANTHROPIC_API_KEY ?? null;
}
function truncatePageText(text, maxChars = 12000) {
    if (text.length <= maxChars)
        return text;
    return text.slice(0, maxChars) + "\n... [truncated]";
}
function buildPrompt(input) {
    const jsonLdHint = input.jsonLdData
        ? `\n\nStructured data already found on the page (JSON-LD):\n${JSON.stringify(input.jsonLdData, null, 2).slice(0, 3000)}`
        : "";
    return `Extract structured job details from this job posting page. Return ONLY valid JSON matching the schema below.

Job URL: ${input.url}
Seed Title: ${input.title}
${jsonLdHint}

Page text:
${truncatePageText(input.pageText)}

Return JSON with these exact fields:
{
  "title": "string - job title",
  "description": "string - full job description in HTML if available, otherwise plain text. Include responsibilities, qualifications, etc. Do NOT include navigation, footer, cookie notices, or application form text",
  "jobType": "GIG | FULLTIME | PARTTIME | FREELANCE (map internship/contract/temporary to GIG)",
  "workType": "ONSITE | HYBRID | REMOTE | null",
  "location": { "city": "string", "state": "string", "country": "string", "formattedAddress": "string" } or null,
  "salary": { "min": number|null, "max": number|null, "currency": "string", "period": "HOURLY|DAILY|WEEKLY|MONTHLY|ANNUAL|ONE_TIME" } or null,
  "company": { "name": "string", "website": "string|null" } or null,
  "keywords": ["array of relevant domain keywords"],
  "skills": ["array of specific tools/skills mentioned"],
  "deadline": "ISO 8601 string or null",
  "numberOfPositions": number or null
}

Rules:
- Use the actual page content, don't invent information
- For description, capture the real job description text - responsibilities, qualifications, about sections. Preserve HTML formatting if present
- If a field is not found on the page, use null or empty array
- For jobType, default to FULLTIME if unclear
- For salary, only include if explicit numbers are mentioned
- For location, expand country codes (US -> United States, UK -> United Kingdom)
- For US locations with 2-letter state codes, set country to "United States"
- Return ONLY the JSON object, no markdown fences or explanation`;
}
function parseAiResponse(raw) {
    let text = raw.trim();
    // Strip markdown code fences if present
    const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch)
        text = fenceMatch[1].trim();
    try {
        const parsed = JSON.parse(text);
        const title = typeof parsed.title === "string" ? parsed.title.trim() : "";
        const description = typeof parsed.description === "string" ? parsed.description.trim() : "";
        const rawJobType = String(parsed.jobType ?? "FULLTIME").toUpperCase();
        const jobType = (JOB_TYPE_VALUES.has(rawJobType) ? rawJobType : "FULLTIME");
        const rawWorkType = parsed.workType ? String(parsed.workType).toUpperCase() : null;
        const workType = rawWorkType && WORK_TYPE_VALUES.has(rawWorkType) ? rawWorkType : null;
        let location = null;
        if (parsed.location && typeof parsed.location === "object") {
            const loc = parsed.location;
            const city = String(loc.city ?? "").trim();
            const state = String(loc.state ?? "").trim();
            const country = String(loc.country ?? "").trim();
            const formattedAddress = String(loc.formattedAddress ?? "").trim();
            if (city || state || country) {
                location = {
                    placeId: "",
                    name: [city, state || country].filter(Boolean).join(", "),
                    formattedAddress: formattedAddress || [city, state, country].filter(Boolean).join(", "),
                    latitude: 0,
                    longitude: 0,
                    city,
                    state,
                    country,
                };
            }
        }
        let salary = null;
        if (parsed.salary && typeof parsed.salary === "object") {
            const sal = parsed.salary;
            const min = typeof sal.min === "number" && Number.isFinite(sal.min) ? sal.min : null;
            const max = typeof sal.max === "number" && Number.isFinite(sal.max) ? sal.max : null;
            const currency = String(sal.currency ?? "USD").trim() || "USD";
            const rawPeriod = String(sal.period ?? "").toUpperCase();
            const period = SALARY_PERIOD_VALUES.has(rawPeriod) ? rawPeriod : null;
            if (min !== null || max !== null) {
                salary = { min, max, currency, period };
            }
        }
        let company = null;
        if (parsed.company && typeof parsed.company === "object") {
            const comp = parsed.company;
            const name = String(comp.name ?? "").trim() || null;
            const website = String(comp.website ?? "").trim() || null;
            if (name) {
                company = { name, website, logo: null, email: null };
            }
        }
        const keywords = Array.isArray(parsed.keywords)
            ? parsed.keywords.filter((k) => typeof k === "string" && k.trim().length > 0).map(k => k.trim().toLowerCase())
            : [];
        const skills = Array.isArray(parsed.skills)
            ? parsed.skills.filter((s) => typeof s === "string" && s.trim().length > 0).map(s => s.trim().toLowerCase().replace(/\s+/g, "_"))
            : [];
        const deadline = typeof parsed.deadline === "string" && parsed.deadline.trim()
            ? parsed.deadline.trim()
            : null;
        const numberOfPositions = typeof parsed.numberOfPositions === "number" && Number.isFinite(parsed.numberOfPositions) && parsed.numberOfPositions > 0
            ? parsed.numberOfPositions
            : null;
        return {
            title: title || "Untitled",
            description: description || "For job details, click apply.",
            jobType,
            workType,
            location,
            salary,
            company,
            keywords,
            skills,
            deadline,
            numberOfPositions,
        };
    }
    catch {
        return null;
    }
}
async function callAnthropicWithRetry(apiKey, body, maxAttempts = 3) {
    let lastError = new Error("Unknown error");
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const response = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
                "x-api-key": apiKey,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            body: JSON.stringify(body),
        });
        // Rate limited — wait and retry
        if (response.status === 429) {
            const retryAfter = Number(response.headers.get("retry-after") ?? "30");
            const waitMs = (retryAfter > 0 ? retryAfter : 30) * 1000;
            console.warn(`[AI] Rate limited, waiting ${waitMs / 1000}s before retry ${attempt}/${maxAttempts}`);
            await new Promise(resolve => setTimeout(resolve, waitMs));
            lastError = new Error(`Rate limited (429)`);
            continue;
        }
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Anthropic API ${response.status}: ${errorText.slice(0, 300)}`);
        }
        return response;
    }
    throw lastError;
}
export async function enrichWithAi(input) {
    const apiKey = getAnthropicApiKey();
    if (!apiKey) {
        console.warn("[AI] ANTHROPIC_API_KEY not set, skipping AI enrichment");
        return null;
    }
    const prompt = buildPrompt(input);
    const response = await callAnthropicWithRetry(apiKey, {
        model: "claude-haiku-4-5-20251001",
        max_tokens: 4096,
        messages: [{ role: "user", content: prompt }],
    });
    const data = await response.json();
    const textBlock = data.content?.find(b => b.type === "text");
    if (!textBlock?.text)
        return null;
    const parsed = parseAiResponse(textBlock.text);
    if (!parsed)
        return null;
    return {
        title: parsed.title,
        description: parsed.description,
        jobType: parsed.jobType,
        workType: parsed.workType,
        location: parsed.location,
        salary: parsed.salary,
        company: parsed.company,
        keywords: parsed.keywords,
        skills: parsed.skills,
        deadline: parsed.deadline,
        numberOfPositions: parsed.numberOfPositions,
        jobLink: input.url,
        hiringTeam: [input.hiringTeamUid],
        screeningQuestions: [],
        screeningRequired: false,
        allowEmailApplications: false,
    };
}
export function needsAiEnrichment(description, jsonLdJob, heuristicSkills, heuristicSalary) {
    const plainDesc = description.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    // Placeholder
    if (/^for job details/i.test(plainDesc))
        return true;
    // Description is too short regardless of JSON-LD source
    if (plainDesc.length < 300)
        return true;
    // If JSON-LD has a rich description but heuristics missed skills/salary, still call AI
    // to extract those fields (cheaper than missing data)
    const missingSkills = !heuristicSkills || heuristicSkills.length === 0;
    const missingSalary = !heuristicSalary;
    if (missingSkills || missingSalary)
        return true;
    // If JSON-LD has a rich description and skills/salary are already extracted, skip AI
    if (jsonLdJob) {
        const jsonDesc = String(jsonLdJob.description ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
        if (jsonDesc.length >= 300)
            return false;
    }
    return false;
}
