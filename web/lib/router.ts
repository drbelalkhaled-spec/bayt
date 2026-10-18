export type Route = "list" | "tasks" | "chat";
export const ROUTES: Route[] = ["list", "tasks", "chat"];

let listening = false;
let handler: ((r: Route) => void) | null = null;
/** "#/tasks/<id>": a notification tap asking the view to show that one thing. Taken once by the view. */
let focus: { route: Route; id: string } | null = null;

const ROUTE_HASH = /^#\/(list|tasks|chat)(?:\/([\w-]+))?$/;

export function current(): Route {
  const m = /^#\/(\w+)/.exec(location.hash);
  return m && (ROUTES as string[]).includes(m[1]) ? (m[1] as Route) : "list";
}

export function go(r: Route): void {
  if (location.hash === "#/" + r) handler?.(r);
  else location.hash = "#/" + r;
}

function capture(): void {
  const m = ROUTE_HASH.exec(location.hash);
  focus = m?.[2] ? { route: m[1] as Route, id: m[2] } : null;
}

/** The id a notification asked this view to show (once), and the address goes back to plain "#/route". */
export function takeFocus(route: Route): string | null {
  const f = focus;
  if (!f || f.route !== route) return null;
  focus = null;
  if (location.hash.startsWith("#/" + route + "/")) history.replaceState(null, "", "#/" + route);
  return f.id;
}

/** Start routing. A pending "#join=" hash is left alone (onboarding owns it). */
export function startRouter(cb: (r: Route) => void): void {
  handler = cb;
  if (!listening) {
    listening = true;
    window.addEventListener("hashchange", () => {
      if (location.hash.startsWith("#join=")) return;
      capture();
      handler?.(current());
    });
  }
  if (!ROUTE_HASH.test(location.hash) && !location.hash.startsWith("#join=")) {
    history.replaceState(null, "", "#/list");
  }
  capture();
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
