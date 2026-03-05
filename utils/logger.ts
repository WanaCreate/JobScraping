export function logInfo(message: string, payload?: Record<string, unknown>): void {
  if (payload) {
    console.log(`[INFO] ${message}`, payload);
    return;
  }
  console.log(`[INFO] ${message}`);
}

export function logWarn(message: string, payload?: Record<string, unknown>): void {
  if (payload) {
    console.warn(`[WARN] ${message}`, payload);
    return;
  }
  console.warn(`[WARN] ${message}`);
}

export function logError(message: string, payload?: Record<string, unknown>): void {
  if (payload) {
    console.error(`[ERROR] ${message}`, payload);
    return;
  }
  console.error(`[ERROR] ${message}`);
}
