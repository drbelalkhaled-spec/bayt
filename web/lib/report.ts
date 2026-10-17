// Sends unexpected errors from this screen to the server's problem log (parents can see them in Settings).
// Network trouble is normal (offline), so ApiError is never reported; each distinct message goes once per visit.
import { ApiError, apiRaw, getToken } from "./api";

const MAX_PER_VISIT = 5;
const seen = new Set<string>();

function report(message: string, stack?: string): void {
  if (!getToken() || seen.size >= MAX_PER_VISIT || seen.has(message)) return;
  seen.add(message);
  void apiRaw("/api/errors", "POST", {
    message: message.slice(0, 300),
    stack: stack ? stack.slice(0, 2000) : null,
    where: location.hash.slice(0, 60) || "/",
  }).catch(() => undefined);
}

export function initErrorReporting(): void {
  window.addEventListener("error", (e) => {
    // Only our own code: browser extensions and other origins are not Bayt's problem.
    if (!e.filename || !e.filename.startsWith(location.origin)) return;
    report(e.message || "Script error", (e.error as Error | undefined)?.stack);
  });
  window.addEventListener("unhandledrejection", (e) => {
    const r: unknown = e.reason;
    if (r instanceof ApiError || !(r instanceof Error)) return;
    report(r.message || r.name, r.stack);
  });
}
