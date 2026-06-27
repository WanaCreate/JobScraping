/**
 * Discovery helper — load a careers URL in a real browser and log every JSON/XHR
 * response that looks job-related, plus a sample of its shape. Used to reverse-
 * engineer SPA portal APIs (Phenom, ADP, SuccessFactors, etc.).
 *
 * Usage: npx tsx experiments/architecture-firms/discover.ts "<url>"
 */
import { chromium } from "playwright";

const url = process.argv[2];
if (!url) {
  console.error("Usage: discover.ts <url>");
  process.exit(1);
}

function looksJobby(s: string): boolean {
  return /job|career|requisition|posting|search|opening|vacanc|widget|opportunit/i.test(s);
}

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
});
const page = await ctx.newPage();
const seen = new Set<string>();

page.on("response", async (res) => {
  try {
    const u = res.url();
    const ct = (res.headers()["content-type"] ?? "").toLowerCase();
    if (!ct.includes("json")) return;
    if (!looksJobby(u)) return;
    if (seen.has(u)) return;
    seen.add(u);
    const body = await res.text();
    if (body.length < 5 || body.length > 3_000_000) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return;
    }
    console.log("\n=== XHR:", res.request().method(), u, "(" + res.status() + ")");
    const snippet = JSON.stringify(parsed).slice(0, 1200);
    console.log("BODY:", snippet);
  } catch {
    /* ignore */
  }
});

console.log("Loading", url, "...");
try {
  await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
} catch {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  } catch {
    /* ignore */
  }
}
await page.waitForTimeout(6000);
console.log("\nFinal URL:", page.url());
await ctx.close();
await browser.close();
