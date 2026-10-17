import { add, clear, h } from "../lib/dom";

export interface StoreItem {
  id: string;
  name: string;
  qty: string | null;
  note: string | null;
  category: string;
  bought_at: number | null;
  urgent_at?: number | null;
}

export interface StoreHooks {
  getItems: () => StoreItem[];
  categories: () => string[];
  /** Ids whose change is still waiting to sync (shown with a clock). */
  waiting?: () => Set<string>;
  toggle: (id: string, bought: boolean) => Promise<void>;
  /** Called when the user taps "Done shopping" (after the overlay has closed). */
  onDone: () => void;
}

export interface StoreMode {
  update: () => void;
  close: () => void;
}

/** Full-screen "I'm at the store" overlay. Call update() after list data changes. */
export function openStoreMode(hooks: StoreHooks): StoreMode {
  const startedAt = Date.now();
  let cartOpen = false;
  let closed = false;
  let sentinel: WakeLockSentinel | null = null;
  let lastSig = "";
  let waitSet = new Set<string>();

  const body = h("div", { class: "store-body" });
  const doneBtn = h(
    "button",
    {
      class: "btn primary store-done",
      type: "button",
      onclick: () => {
        close();
        hooks.onDone();
      },
    },
    "Done shopping",
  );
  const overlay = h(
    "div",
    { class: "store-overlay", role: "dialog", "aria-modal": "true", "aria-label": "At the store" },
    h("div", { class: "store-head" }, h("h2", null, "\u{1F6D2} At the store"), doneBtn),
    body,
  );

  function storeRow(it: StoreItem, inCart: boolean): HTMLElement {
    return h(
      "button",
      {
        class: "store-row" + (inCart ? " in-cart" : ""),
        type: "button",
        role: "checkbox",
        "aria-checked": inCart ? "true" : "false",
        "aria-label": (inCart ? "Put back on the list: " : "Got it: ") + it.name,
        onclick: () => void hooks.toggle(it.id, !inCart),
      },
      h("span", { class: "store-box" }, inCart ? "✓" : ""),
      h(
        "span",
        { class: "store-text" },
        h(
          "span",
          { class: "store-name" },
          !inCart && it.urgent_at ? h("span", { class: "store-urgent", "aria-label": "Needed today" }, "\u{1F534} ") : null,
          it.name,
          it.qty ? h("span", { class: "pill qty" }, it.qty) : null,
        ),
        it.note ? h("span", { class: "store-note" }, it.note) : null,
        waitSet.has(it.id) ? h("span", { class: "store-note sync-wait" }, "⏳ waiting to sync") : null,
      ),
    );
  }

  function render(force = false): void {
    if (closed) return;
    const all = hooks.getItems();
    const cats = hooks.categories();
    const open = all.filter((i) => i.bought_at === null);
    const cart = all.filter((i) => i.bought_at !== null && i.bought_at >= startedAt - 1000).sort((a, b) => (b.bought_at ?? 0) - (a.bought_at ?? 0));
    const wait = hooks.waiting?.() ?? new Set<string>();
    waitSet = wait;
    const sig = JSON.stringify([open, cart, cats, cartOpen, [...wait]]);
    if (!force && sig === lastSig) return;
    lastSig = sig;
    const scroll = body.scrollTop;
    clear(body);
    const order = [...cats];
    for (const i of open) if (!order.includes(i.category)) order.push(i.category);
    let any = false;
    for (const c of order) {
      const group = open.filter((i) => i.category === c);
      if (!group.length) continue;
      any = true;
      add(body, h("h3", { class: "store-cat" }, c), h("div", { class: "store-group" }, group.map((i) => storeRow(i, false))));
    }
    if (!any) add(body, h("div", { class: "empty" }, cart.length ? "All done! \u{1F389}" : "Nothing to buy \u{1F389}"));
    if (cart.length) {
      add(
        body,
        h(
          "button",
          {
            class: "store-cart-toggle",
            type: "button",
            "aria-expanded": cartOpen ? "true" : "false",
            onclick: () => {
              cartOpen = !cartOpen;
              render(true);
            },
          },
          `${cartOpen ? "▾" : "▸"} In the cart (${cart.length})`,
        ),
      );
      if (cartOpen) add(body, h("div", { class: "store-group" }, cart.map((i) => storeRow(i, true))));
    }
    body.scrollTop = scroll;
  }

  async function lock(): Promise<void> {
    try {
      if (closed || document.visibilityState !== "visible" || !("wakeLock" in navigator)) return;
      const s = await navigator.wakeLock.request("screen");
      s.addEventListener("release", () => {
        if (sentinel === s) sentinel = null;
      });
      sentinel = s;
      if (closed) await release();
    } catch {
      /* unsupported or denied: ignore */
    }
  }
  async function release(): Promise<void> {
    const s = sentinel;
    sentinel = null;
    try {
      await s?.release();
    } catch {
      /* ignore */
    }
  }
  const onVis = (): void => {
    if (document.visibilityState === "visible" && !sentinel) void lock();
  };

  function close(): void {
    if (closed) return;
    closed = true;
    document.removeEventListener("visibilitychange", onVis);
    void release();
    overlay.remove();
  }

  document.addEventListener("visibilitychange", onVis);
  document.body.appendChild(overlay);
  void lock();
  render(true);
  doneBtn.focus();
  return { update: () => render(), close };
}
