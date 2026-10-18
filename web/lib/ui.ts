import { add, h } from "./dom";

let toastHost: HTMLElement | null = null;

export interface ToastOpts {
  error?: boolean;
  action?: { label: string; run: () => void };
  ms?: number;
}

/** `toast(msg)`, `toast(msg, true)` (error), or `toast(msg, { error, action, ms })`. With an action it stays 5 s. */
export function toast(msg: string, opts: boolean | ToastOpts = false): void {
  const o: ToastOpts = typeof opts === "boolean" ? { error: opts } : opts;
  if (!toastHost || !toastHost.isConnected) {
    toastHost = h("div", { class: "toast-host", role: "status", "aria-live": "polite" });
    document.body.appendChild(toastHost);
  }
  const t = h("div", { class: "toast" + (o.error ? " err" : "") }, msg);
  const dismiss = (): void => {
    t.classList.remove("show");
    setTimeout(() => t.remove(), 250);
  };
  if (o.action) {
    const act = o.action;
    t.appendChild(
      h(
        "button",
        {
          class: "toast-action",
          type: "button",
          onclick: () => {
            dismiss();
            act.run();
          },
        },
        act.label,
      ),
    );
  }
  toastHost.appendChild(t);
  requestAnimationFrame(() => t.classList.add("show"));
  setTimeout(dismiss, o.ms ?? (o.action ? 5000 : 2600));
}

export interface Sheet {
  el: HTMLElement;
  body: HTMLElement;
  close: () => void;
}
const openSheets = new Set<Sheet>();

/** Open a bottom sheet with a title; fill `body` with content. */
export function openSheet(title: string, onClose?: () => void): Sheet {
  const body = h("div", { class: "stack" });
  const sheetEl = h("div", { class: "sheet", role: "dialog", "aria-modal": "true", "aria-label": title }, h("div", { class: "grab" }), h("h2", null, title), body);
  const backdrop = h("div", { class: "backdrop" }, sheetEl);
  let closed = false;
  const sheet: Sheet = {
    el: sheetEl,
    body,
    close() {
      if (closed) return;
      closed = true;
      openSheets.delete(sheet);
      document.removeEventListener("keydown", onKey);
      backdrop.classList.remove("show");
      setTimeout(() => backdrop.remove(), 200);
      onClose?.();
    },
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && [...openSheets].pop() === sheet) sheet.close();
  };
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) sheet.close();
  });
  document.addEventListener("keydown", onKey);
  document.body.appendChild(backdrop);
  openSheets.add(sheet);
  requestAnimationFrame(() => backdrop.classList.add("show"));
  return sheet;
}

export function closeAllSheets(): void {
  for (const s of [...openSheets]) s.close();
}

/** Yes/no dialog as a small sheet. Resolves true when confirmed. */
export function confirmDialog(message: string, okLabel = "Confirm", danger = false): Promise<boolean> {
  return new Promise((resolve) => {
    let result = false;
    const sheet = openSheet("Are you sure?", () => resolve(result));
    add(sheet.body, 
      h("p", { class: "muted" }, message),
      h(
        "div",
        { class: "actions" },
        h("button", { class: "btn", onclick: () => sheet.close() }, "Cancel"),
        h(
          "button",
          {
            class: "btn " + (danger ? "danger" : "primary"),
            onclick: () => {
              result = true;
              sheet.close();
            },
          },
          okLabel,
        ),
      ),
    );
  });
}

/** "just now", "5 min ago", "3 h ago", "2 d ago", else a date. Accepts ms epoch or ISO string. */
export function timeAgo(t: number | string | Date): string {
  const ms = typeof t === "number" ? t : new Date(t).getTime();
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 7 * 86400) return `${Math.round(s / 86400)} d ago`;
  return new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/** Scrolls the card or row marked data-id into view and flashes it (see .flash-row). False when it is not on screen. */
export function flashRow(root: HTMLElement | null, id: string): boolean {
  const el = root?.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`);
  if (!el) return false;
  el.scrollIntoView({ block: "center" });
  el.classList.add("flash-row");
  setTimeout(() => el.classList.remove("flash-row"), 2000);
  return true;
}
