export type Route = "list" | "tasks" | "chat";
export const ROUTES: Route[] = ["list", "tasks", "chat"];

let listening = false;
let handler: ((r: Route) => void) | null = null;

export function current(): Route {
  const m = /^#\/(\w+)/.exec(location.hash);
  return m && (ROUTES as string[]).includes(m[1]) ? (m[1] as Route) : "list";
}

export function go(r: Route): void {
  if (location.hash === "#/" + r) handler?.(r);
  else location.hash = "#/" + r;
}

/** Start routing. A pending "#join=" hash is left alone (onboarding owns it). */
export function startRouter(cb: (r: Route) => void): void {
  handler = cb;
  if (!listening) {
    listening = true;
    window.addEventListener("hashchange", () => {
      if (location.hash.startsWith("#join=")) return;
      handler?.(current());
    });
  }
  if (!/^#\/(list|tasks|chat)$/.test(location.hash) && !location.hash.startsWith("#join=")) {
    history.replaceState(null, "", "#/list");
  }
  cb(current());
}

/** Read the invite secret from "#join=<secret>", if any. */
export function joinSecret(): string | null {
  const m = /^#join=([\w-]+)/.exec(location.hash);
  return m ? m[1] : null;
}

export function clearHash(): void {
  history.replaceState(null, "", location.pathname + location.search);
}
