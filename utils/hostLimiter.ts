/**
 * utils/hostLimiter.ts
 *
 * Per-host concurrency cap + minimum request spacing. Bulk scraping thousands of
 * ATS URLs concentrated on a handful of hosts (boards.greenhouse.io,
 * jobs.ashbyhq.com, apply.workable.com) trips 429/403 rate limits when fired at
 * global concurrency with no per-host throttle. This bounds in-flight work and
 * spacing PER HOST while letting different hosts run in parallel.
 *
 * Tunable via env:
 *   PER_HOST_CONCURRENCY  max concurrent operations per host   (default 4)
 *   PER_HOST_SPACING_MS   min ms between operation starts/host (default 120)
 */

const PER_HOST_CONCURRENCY = Math.max(1, Number(process.env.PER_HOST_CONCURRENCY ?? "4") || 4);
const PER_HOST_SPACING_MS = Math.max(0, Number(process.env.PER_HOST_SPACING_MS ?? "120") || 120);

interface HostState {
  active: number;
  lastStartAt: number;
  queue: Array<() => void>;
}

const hosts = new Map<string, HostState>();

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "unknown";
  }
}

function stateFor(host: string): HostState {
  let st = hosts.get(host);
  if (!st) {
    st = { active: 0, lastStartAt: 0, queue: [] };
    hosts.set(host, st);
  }
  return st;
}

function acquire(st: HostState): Promise<void> {
  return new Promise<void>((resolve) => {
    if (st.active < PER_HOST_CONCURRENCY) {
      st.active += 1;
      resolve();
    } else {
      st.queue.push(resolve);
    }
  });
}

function release(st: HostState): void {
  st.active -= 1;
  if (st.queue.length > 0 && st.active < PER_HOST_CONCURRENCY) {
    const next = st.queue.shift();
    if (next) {
      st.active += 1;
      next();
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run `fn` under the per-host concurrency cap and spacing for `url`'s host.
 * Different hosts proceed independently; the same host is bounded.
 */
export async function withHostLimit<T>(url: string, fn: () => Promise<T>): Promise<T> {
  const st = stateFor(hostOf(url));
  await acquire(st);

  // Enforce minimum spacing between starts on this host.
  if (PER_HOST_SPACING_MS > 0) {
    const wait = st.lastStartAt + PER_HOST_SPACING_MS - Date.now();
    if (wait > 0) await sleep(wait);
  }
  st.lastStartAt = Date.now();

  try {
    return await fn();
  } finally {
    release(st);
  }
}
