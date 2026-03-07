import axios from "axios";
export const http = axios.create({
    timeout: 30000,
    maxRedirects: 8,
    headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        Accept: "text/html,application/json;q=0.9,*/*;q=0.8"
    }
});
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function isRetryableAxiosError(error) {
    if (!error || typeof error !== "object")
        return false;
    const axiosError = error;
    const code = axiosError.code ?? "";
    const status = axiosError.response?.status ?? 0;
    if (status === 429)
        return true;
    if (status >= 500 && status <= 599)
        return true;
    if (code === "ECONNABORTED" || code === "ETIMEDOUT" || code === "ECONNRESET")
        return true;
    if (code === "EAI_AGAIN" || code === "ENOTFOUND" || code === "EHOSTUNREACH")
        return true;
    return false;
}
export function safeAbsoluteUrl(candidate, base) {
    if (!candidate)
        return null;
    try {
        if (/^https?:\/\//i.test(candidate))
            return candidate;
        if (!base)
            return null;
        return new URL(candidate, base).toString();
    }
    catch {
        return null;
    }
}
export async function fetchPage(url) {
    const response = await http.get(url, { responseType: "text" });
    const finalUrl = response.request?.res?.responseUrl ?? response.config.url ?? url;
    return {
        html: typeof response.data === "string" ? response.data : String(response.data),
        finalUrl
    };
}
export async function fetchPageWithRetry(url, options) {
    const maxAttempts = options?.maxAttempts ?? 3;
    const baseDelayMs = options?.baseDelayMs ?? 700;
    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
            return await fetchPage(url);
        }
        catch (error) {
            lastError = error;
            if (!isRetryableAxiosError(error) || attempt === maxAttempts) {
                throw error;
            }
            const jitter = Math.floor(Math.random() * 200);
            const delay = baseDelayMs * Math.pow(2, attempt - 1) + jitter;
            await sleep(delay);
        }
    }
    throw lastError instanceof Error ? lastError : new Error("Unknown fetch error");
}
export function withQuery(url, query) {
    const u = new URL(url);
    for (const [key, value] of Object.entries(query)) {
        u.searchParams.set(key, String(value));
    }
    return u.toString();
}
