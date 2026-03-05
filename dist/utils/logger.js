export function logInfo(message, payload) {
    if (payload) {
        console.log(`[INFO] ${message}`, payload);
        return;
    }
    console.log(`[INFO] ${message}`);
}
export function logWarn(message, payload) {
    if (payload) {
        console.warn(`[WARN] ${message}`, payload);
        return;
    }
    console.warn(`[WARN] ${message}`);
}
export function logError(message, payload) {
    if (payload) {
        console.error(`[ERROR] ${message}`, payload);
        return;
    }
    console.error(`[ERROR] ${message}`);
}
