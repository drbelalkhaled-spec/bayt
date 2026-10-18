import { ApiError, api, isOffline, isQueued } from "../lib/api";
import { add, clear, h } from "../lib/dom";
import { compressImage, mediaUrl, pickImage, uploadMedia } from "../lib/media";
import { onOutboxChange, queuedEntries, queuedIds } from "../lib/outbox";
import { takeFocus } from "../lib/router";
import { session } from "../lib/session";
import { undoToast } from "../lib/trash";
import { confirmDialog, flashRow, openSheet, timeAgo, toast } from "../lib/ui";
import { type StoreMode, openStoreMode } from "./store-mode";
import "./views.css";
import "./list.css";
import type { View } from "./types";

interface Item {
  id: string;
  name: string;
  qty: string | null;
  note: string | null;
  category: string;
  photo_key: string | null;
  added_by: string | null;
  added_by_name: string | null;
  added_at: number;
  bought_by: string | null;
  bought_by_name: string | null;
  bought_at: number | null;
  /** When it was flagged "needed today" (null = not urgent). */
  urgent_at: number | null;
}
interface Shopping {
  member_id: string;
  name: string;
  since: number;
}
interface ListResponse {
  items: Item[];
  suggestions: string[];
  usual: string[];
  usual_qty: Record<string, string>;
  categories: string[];
  shopping: Shopping | null;
}

const FALLBACK_CATEGORIES = ["Other"];

let root: HTMLElement | null = null;
let items: Item[] = [];
let suggestions: string[] = [];
let usual: string[] = [];
let usualQty: Record<string, string> = {};
let categories: string[] = FALLBACK_CATEGORIES;
let shopping: Shopping | null = null;
let sig = "";
let pending = 0;
let needRefresh = false;
/** The item a notification opened ("#/list/<id>"); shown once, after the first load. */
let focusId: string | null = null;
let listEl: HTMLElement | null = null;
let bannerEl: HTMLElement | null = null;
let chipsEl: HTMLElement | null = null;
let datalist: HTMLDataListElement | null = null;
let tick: ReturnType<typeof setInterval> | null = null;
let store: StoreMode | null = null;
let viewerClose: (() => void) | null = null;
let addItemFn: ((name: string, qty?: string) => Promise<void>) | null = null;
const moved = new Set<string>();
/** Ids with a change still waiting in the offline outbox. */
let waiting = new Set<string>();
let unsubOutbox: (() => void) | null = null;

const errMsg = (e: unknown): string => (e instanceof ApiError && e.code === "network" ? "You are offline" : "Something went wrong");
const uploadErr = (e: unknown): string => {
  const m = e instanceof Error ? e.message : "";
  if (m === "network") return "You are offline";
  if (m === "too_large") return "That photo is too big";
  return "Could not upload the photo";
};

const defaultCategory = (): string => (categories.includes("Other") ? "Other" : (categories[categories.length - 1] ?? "Other"));
const partition = (list: Item[]): Item[] => [...list.filter((i) => i.bought_at === null), ...list.filter((i) => i.bought_at !== null)];

/** Re-apply changes that are still waiting in the outbox, so server/cached data never wipes them from view. */
function overlay(list: Item[]): Item[] {
  const q = queuedEntries();
  if (!q.length) return list;
  let out = [...list];
  const me = session.me;
  for (const e of q) {
    if (!e.path.startsWith("/api/items")) continue;
    const b = (e.body && typeof e.body === "object" ? e.body : {}) as Record<string, unknown>;
    if (e.method === "POST" && e.path === "/api/items") {
      const id = String(b.id ?? "");
      if (id && !out.some((i) => i.id === id)) {
        out.unshift({
          id,
          name: String(b.name ?? ""),
          qty: typeof b.qty === "string" ? b.qty : null,
          note: null,
          category: typeof b.category === "string" ? b.category : defaultCategory(),
          photo_key: typeof b.photo_key === "string" ? b.photo_key : null,
          added_by: me?.id ?? null,
          added_by_name: me?.name ?? null,
          added_at: e.at,
          bought_by: null,
          bought_by_name: null,
          bought_at: null,
          urgent_at: b.urgent === true ? e.at : null,
        });
      }
      continue;
    }
    const id = decodeURIComponent(e.path.split("/").pop() ?? "");
    if (e.method === "DELETE") {
      out = out.filter((i) => i.id !== id);
      continue;
    }
    out = out.map((i) => {
      if (i.id !== id) return i;
      const n: Item = { ...i };
      if (typeof b.name === "string") n.name = b.name;
      if ("qty" in b) n.qty = typeof b.qty === "string" ? b.qty : null;
      if ("note" in b) n.note = typeof b.note === "string" ? b.note : null;
      if (typeof b.category === "string") n.category = b.category;
      if (b.urgent === true && n.urgent_at === null) n.urgent_at = e.at;
      else if (b.urgent === false) n.urgent_at = null;
      if (b.bought === true && n.bought_at === null) {
        n.bought_at = e.at;
        n.bought_by = me?.id ?? null;
        n.bought_by_name = me?.name ?? null;
      } else if (b.bought === false) {
        n.bought_at = null;
        n.bought_by = null;
        n.bought_by_name = null;
      }
      return n;
    });
  }
  return partition(out);
}

const isMine = (s: Shopping | null): boolean => !!s && s.member_id === session.me?.id;

/** "Needed today", or since which day when it was flagged earlier. */
function neededLabel(at: number): string {
  const d = new Date(at);
  if (d.toDateString() === new Date().toDateString()) return "Needed today";
  return "Needed since " + d.toLocaleDateString(undefined, { weekday: "short" });
}

function renderBanner(): void {
  if (!bannerEl) return;
  clear(bannerEl);
  bannerEl.hidden = !shopping;
  if (!shopping) return;
  const ago = timeAgo(shopping.since);
  const since = ago === "just now" ? "just started" : "since " + ago.replace(/ ago$/, "");
  if (isMine(shopping)) {
    add(
      bannerEl,
      h("span", { class: "grow" }, `\u{1F6D2} You're shopping · ${since}`),
      h("button", { class: "btn small", type: "button", onclick: () => void stopShopping() }, "I'm done"),
    );
  } else {
    add(bannerEl, h("span", { class: "grow" }, `\u{1F6D2} ${shopping.name} is shopping now · ${since}`));
  }
}

function renderChips(): void {
  if (!chipsEl) return;
  clear(chipsEl);
  chipsEl.hidden = !usual.length;
  if (!usual.length) return;
  add(
    chipsEl,
    h("span", { class: "usual-label" }, "Usual:"),
    usual.map((n) =>
      h("button", { class: "usual-chip", type: "button", onclick: () => void addItemFn?.(n, usualQty[n]) }, n),
    ),
  );
}

function render(force = false): void {
  if (!listEl) return;
  waiting = queuedIds();
  const s = JSON.stringify([items, suggestions, usual, usualQty, categories, shopping, [...waiting]]);
  if (!force && s === sig) {
    return;
  }
  sig = s;
  if (datalist) {
    clear(datalist);
    for (const n of suggestions) add(datalist, h("option", { value: n }));
  }
  renderBanner();
  renderChips();
  const open = items.filter((i) => i.bought_at === null && i.urgent_at === null);
  const urgent = items.filter((i) => i.bought_at === null && i.urgent_at !== null);
  const bought = items.filter((i) => i.bought_at !== null);
  clear(listEl);
  if (urgent.length) {
    add(listEl, h("h2", { class: "section-h aisle-h needed-h" }, "\u{1F534} Needed today"), h("div", { class: "stack" }, urgent.map(row)));
  }
  if (!open.length && !urgent.length) add(listEl, h("div", { class: "empty" }, "Nothing to buy \u{1F389}"));
  else {
    const order = [...categories];
    for (const i of open) if (!order.includes(i.category)) order.push(i.category);
    for (const c of order) {
      const group = open.filter((i) => i.category === c);
      if (!group.length) continue;
      add(listEl, h("h2", { class: "section-h aisle-h" }, c), h("div", { class: "stack" }, group.map(row)));
    }
  }
  if (bought.length) {
    add(listEl, h("h2", { class: "section-h" }, "Bought · disappears after 48 h"), h("div", { class: "stack" }, bought.map(row)));
  }
  moved.clear();
  store?.update();
}

function openViewer(key: string, alt: string): void {
  viewerClose?.();
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") close();
  };
  const el = h(
    "div",
    { class: "photo-viewer", role: "dialog", "aria-modal": "true", "aria-label": alt, onclick: () => close() },
    h("img", { src: mediaUrl(key), alt }),
  );
  function close(): void {
    document.removeEventListener("keydown", onKey);
    el.remove();
    if (viewerClose === close) viewerClose = null;
  }
  document.addEventListener("keydown", onKey);
  document.body.appendChild(el);
  viewerClose = close;
}

function row(it: Item): HTMLElement {
  const done = it.bought_at !== null;
  const who = done
    ? `bought by ${it.bought_by_name || "Someone"} · ${timeAgo(it.bought_at as number)}`
    : `added by ${it.added_by_name || "Someone"} · ${timeAgo(it.added_at)}`;
  const check = h(
    "button",
    {
      class: "check" + (done ? " on" : ""),
      type: "button",
      role: "checkbox",
      "aria-checked": done ? "true" : "false",
      "aria-label": (done ? "Mark not bought: " : "Mark bought: ") + it.name,
      onclick: (e: Event) => {
        e.stopPropagation();
        void toggle(it.id, !done);
      },
    },
    done ? "✓" : "",
  );
  return h(
    "div",
    { class: "row item" + (done ? " is-done" : "") + (!done && it.urgent_at !== null ? " is-needed" : "") + (moved.has(it.id) ? " pop" : ""), "data-id": it.id },
    check,
    h(
      "div",
      {
        class: "grow body",
        role: "button",
        tabindex: 0,
        onclick: () => openEdit(it),
        onkeydown: (e: KeyboardEvent) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            openEdit(it);
          }
        },
      },
      h(
        "div",
        { class: "name" },
        it.name,
        it.qty ? h("span", { class: "pill qty" }, it.qty) : null,
        !done && it.urgent_at !== null ? h("span", { class: "pill needed" }, neededLabel(it.urgent_at)) : null,
      ),
      it.note ? h("div", { class: "note" }, it.note) : null,
      h("div", { class: "sub" }, who, waiting.has(it.id) ? h("span", { class: "sync-wait" }, " · ⏳ waiting to sync") : null),
    ),
    it.photo_key
      ? h(
          "button",
          {
            class: "thumb",
            type: "button",
            "aria-label": "View photo of " + it.name,
            onclick: (e: Event) => {
              e.stopPropagation();
              openViewer(it.photo_key as string, it.name);
            },
          },
          h("img", { src: mediaUrl(it.photo_key), alt: "", loading: "lazy" }),
        )
      : null,
  );
}

function applyResponse(r: ListResponse): void {
  items = overlay(r.items);
  suggestions = r.suggestions;
  usual = r.usual ?? [];
  usualQty = r.usual_qty ?? {};
  categories = r.categories?.length ? r.categories : FALLBACK_CATEGORIES;
  shopping = r.shopping ?? null;
}

async function load(): Promise<void> {
  const r = await api<ListResponse>("/api/items");
  if (!root || pending) return;
  applyResponse(r);
  render();
  if (focusId) {
    const id = focusId;
    focusId = null;
    if (!flashRow(listEl, id)) toast("That item is no longer on the list");
  }
}

async function stopShopping(): Promise<void> {
  const prev = shopping;
  if (!isMine(prev)) return;
  shopping = null;
  render();
  try {
    await api("/api/shopping", { method: "DELETE" });
  } catch (e) {
    shopping = prev;
    render();
    toast(errMsg(e), true);
  }
}

async function enterStore(): Promise<void> {
  if (store) return;
  if (!isMine(shopping)) {
    const tell = await confirmDialog("Let everyone know you're going shopping?", "Yes, tell them");
    if (tell) {
      try {
        const r = await api<{ shopping: Shopping }>("/api/shopping", { method: "POST", body: {} });
        shopping = r.shopping;
        render();
      } catch (e) {
        toast(errMsg(e), true);
      }
    }
  }
  if (!root || store) return;
  store = openStoreMode({
    getItems: () => items,
    categories: () => categories,
    toggle: (id, bought) => toggle(id, bought),
    waiting: () => waiting,
    onDone: () => {
      store = null;
      void stopShopping();
    },
  });
}

async function toggle(id: string, bought: boolean): Promise<void> {
  const prev = items.find((i) => i.id === id);
  if (!prev) return;
  const snapshot = items;
  const me = session.me;
  const upd: Item = {
    ...prev,
    bought_at: bought ? Date.now() : null,
    bought_by: bought ? (me?.id ?? null) : null,
    bought_by_name: bought ? (me?.name ?? null) : null,
  };
  const rest = items.filter((i) => i.id !== id);
  if (bought) items = [...rest.filter((i) => i.bought_at === null), upd, ...rest.filter((i) => i.bought_at !== null)];
  else items = [upd, ...rest];
  moved.add(id);
  render();
  pending++;
  try {
    const r = await api<{ item: Item }>("/api/items/" + id, { method: "PATCH", body: { bought } });
    items = items.map((i) => (i.id === id ? r.item : i));
    render();
    if (bought) {
      toast("Bought " + prev.name, { action: { label: "Undo", run: () => void toggle(id, false) }, ms: 5000 });
    }
  } catch (e) {
    if (isQueued(e)) {
      // Offline: the change stays applied and is sent when the connection is back.
      render();
      if (bought) toast("Bought " + prev.name, { action: { label: "Undo", run: () => void toggle(id, false) }, ms: 5000 });
    } else {
      items = snapshot;
      render();
      toast(errMsg(e), true);
    }
  } finally {
    pending--;
    if (!pending && needRefresh) {
      needRefresh = false;
      void refresh().catch(() => undefined);
    }
  }
}

function openEdit(it: Item): void {
  const name = h("input", { class: "input", value: it.name, maxLength: 80, required: true, "aria-label": "Name" });
  const qty = h("input", { class: "input", value: it.qty ?? "", maxLength: 20, "aria-label": "Quantity" });
  const note = h("input", { class: "input", value: it.note ?? "", maxLength: 200, "aria-label": "Note" });
  const cats = categories.includes(it.category) ? categories : [...categories, it.category];
  const cat = h(
    "select",
    { class: "input", "aria-label": "Category" },
    cats.map((c) => h("option", { value: c, selected: c === it.category }, c)),
  );
  cat.value = it.category;
  const err = h("p", { class: "error", role: "alert" });
  const sheet = openSheet("Edit item");
  const save = h("button", { class: "btn primary", type: "submit" }, "Save");

  // photo
  let photoKey = it.photo_key;
  const photoBox = h("div", { class: "photo-box" });
  const setPhoto = async (key: string | null): Promise<void> => {
    const r = await api<{ item: Item }>("/api/items/" + it.id, { method: "PATCH", body: { photo_key: key } });
    items = items.map((i) => (i.id === it.id ? r.item : i));
    photoKey = r.item.photo_key;
    render();
    drawPhoto();
  };
  const busy = (b: boolean): void => {
    for (const btn of photoBox.querySelectorAll("button")) btn.disabled = b;
  };
  function drawPhoto(): void {
    clear(photoBox);
    if (photoKey) {
      const key = photoKey;
      add(
        photoBox,
        h("button", { class: "thumb big", type: "button", "aria-label": "View photo", onclick: () => openViewer(key, it.name) }, h("img", { src: mediaUrl(key), alt: "" })),
      );
    }
    add(
      photoBox,
      h("button", { class: "btn small", type: "button", onclick: () => void pick() }, photoKey ? "Replace photo" : "Add photo"),
      photoKey
        ? h(
            "button",
            {
              class: "btn small danger",
              type: "button",
              onclick: async () => {
                busy(true);
                try {
                  await setPhoto(null);
                } catch (ex) {
                  toast(errMsg(ex), true);
                  busy(false);
                }
              },
            },
            "Remove",
          )
        : null,
    );
  }
  async function pick(): Promise<void> {
    const f = await pickImage();
    if (!f) return;
    busy(true);
    try {
      const blob = await compressImage(f);
      const up = await uploadMedia(blob);
      await setPhoto(up.key);
    } catch (ex) {
      toast(ex instanceof ApiError ? errMsg(ex) : uploadErr(ex), true);
      busy(false);
    }
  }
  drawPhoto();

  // "Needed today": saved straight away, like the photo.
  let urgentAt = it.urgent_at;
  const neededBtn = h("button", { class: "btn small needed-btn", type: "button" });
  const drawNeeded = (): void => {
    neededBtn.textContent = urgentAt !== null ? "\u{1F534} Needed today · tap to unmark" : "\u{1F534} Mark as needed today";
    neededBtn.classList.toggle("on", urgentAt !== null);
    neededBtn.setAttribute("aria-pressed", String(urgentAt !== null));
  };
  neededBtn.addEventListener("click", async () => {
    const want = urgentAt === null;
    neededBtn.disabled = true;
    try {
      const r = await api<{ item: Item }>("/api/items/" + it.id, { method: "PATCH", body: { urgent: want } });
      items = items.map((i) => (i.id === it.id ? r.item : i));
      urgentAt = r.item.urgent_at;
      if (want) toast(shopping && !isMine(shopping) ? `Told ${shopping.name}` : "Told everyone");
    } catch (ex) {
      if (!isQueued(ex)) {
        toast(errMsg(ex), true);
        neededBtn.disabled = false;
        return;
      }
      urgentAt = want ? Date.now() : null;
      items = items.map((i) => (i.id === it.id ? { ...i, urgent_at: urgentAt } : i));
    }
    render();
    drawNeeded();
    neededBtn.disabled = false;
  });
  drawNeeded();

  const form = h(
    "form",
    {
      class: "stack",
      onsubmit: async (e: Event) => {
        e.preventDefault();
        const n = name.value.trim();
        if (!n) {
          err.textContent = "Name is required";
          return;
        }
        save.disabled = true;
        try {
          const r = await api<{ item: Item }>("/api/items/" + it.id, {
            method: "PATCH",
            body: { name: n, qty: qty.value.trim() || null, note: note.value.trim() || null, category: cat.value },
          });
          items = items.map((i) => (i.id === it.id ? r.item : i));
          render();
          sheet.close();
        } catch (ex) {
          if (isQueued(ex)) {
            items = items.map((i) => (i.id === it.id ? { ...i, name: n, qty: qty.value.trim() || null, note: note.value.trim() || null, category: cat.value } : i));
            render();
            sheet.close();
            return;
          }
          err.textContent = errMsg(ex);
          save.disabled = false;
        }
      },
    },
    h("label", { class: "field" }, h("span", null, "Name"), name),
    h("label", { class: "field" }, h("span", null, "Quantity (optional)"), qty),
    h("label", { class: "field" }, h("span", null, "Note (optional)"), note),
    h("label", { class: "field" }, h("span", null, "Aisle"), cat),
    h("div", { class: "field" }, h("span", null, "Urgent"), neededBtn),
    h("div", { class: "field" }, h("span", null, "Photo"), photoBox),
    err,
    h(
      "div",
      { class: "actions" },
      h(
        "button",
        {
          class: "btn danger",
          type: "button",
          onclick: async () => {
            if (!(await confirmDialog(`Delete "${it.name}"?`, "Delete", true))) return;
            try {
              const r = await api<{ trash_id?: string }>("/api/items/" + it.id, { method: "DELETE" });
              items = items.filter((i) => i.id !== it.id);
              render();
              sheet.close();
              undoToast(it.name, r.trash_id ? [r.trash_id] : undefined, () => void load().catch(() => undefined));
            } catch (ex) {
              if (isQueued(ex)) {
                items = items.filter((i) => i.id !== it.id);
                render();
                sheet.close();
                return;
              }
              toast(errMsg(ex), true);
            }
          },
        },
        "Delete",
      ),
      save,
    ),
  );
  add(sheet.body, form);
  name.focus();
}

export function mount(el: HTMLElement): () => void {
  root = el;
  items = [];
  suggestions = [];
  usual = [];
  usualQty = {};
  categories = FALLBACK_CATEGORIES;
  shopping = null;
  sig = "";
  pending = 0;
  needRefresh = false;
  focusId = takeFocus("list");
  let pendingPhoto: string | null = null;
  let uploading = false;

  const nameIn = h("input", {
    class: "input",
    placeholder: "Add an item…",
    maxLength: 80,
    autocomplete: "off",
    enterKeyHint: "done",
    "aria-label": "Item name",
    list: "list-suggest",
  });
  const qtyIn = h("input", { class: "input qty-in", placeholder: "Qty", maxLength: 20, autocomplete: "off", "aria-label": "Quantity" });
  datalist = h("datalist", { id: "list-suggest" });
  const addBtn = h("button", { class: "btn primary", type: "submit" }, "Add");
  const camBtn = h("button", { class: "btn cam", type: "button", "aria-label": "Add a photo" }, "\u{1F4F7}");
  // Tap before adding to send the next item as "needed today".
  let addUrgent = false;
  const urgentBtn = h("button", { class: "btn cam urgent-toggle", type: "button", "aria-pressed": "false", "aria-label": "Needed today" }, "\u{1F534}");
  const syncUrgent = (): void => {
    urgentBtn.classList.toggle("on", addUrgent);
    urgentBtn.setAttribute("aria-pressed", String(addUrgent));
    urgentBtn.title = addUrgent ? "Next item: needed today" : "Mark the next item as needed today";
    nameIn.placeholder = addUrgent ? "Needed today: add an item…" : "Add an item…";
  };
  urgentBtn.addEventListener("click", () => {
    addUrgent = !addUrgent;
    syncUrgent();
    nameIn.focus();
  });
  const syncCam = (): void => {
    camBtn.classList.toggle("on", !!pendingPhoto);
    camBtn.textContent = pendingPhoto ? "\u{1F4F7}✓" : "\u{1F4F7}";
    camBtn.setAttribute("aria-label", pendingPhoto ? "Photo attached (tap to change)" : "Add a photo");
  };
  camBtn.addEventListener("click", async () => {
    if (uploading) return;
    const f = await pickImage();
    if (!f) return;
    uploading = true;
    camBtn.disabled = true;
    addBtn.disabled = true;
    try {
      const up = await uploadMedia(await compressImage(f));
      pendingPhoto = up.key;
      syncCam();
      nameIn.focus();
    } catch (ex) {
      toast(uploadErr(ex), true);
    } finally {
      uploading = false;
      camBtn.disabled = false;
      addBtn.disabled = false;
    }
  });

  addItemFn = async (name, qty) => {
    const photo = pendingPhoto;
    if (isOffline() && items.some((i) => i.bought_at === null && i.name.toLowerCase() === name.toLowerCase())) {
      toast("Already on the list");
      return;
    }
    const id = crypto.randomUUID(); // client id: the optimistic row and the server row are the same row
    const body: Record<string, unknown> = { id, name };
    if (qty) body.qty = qty;
    if (photo) body.photo_key = photo;
    const urgentNow = addUrgent;
    if (urgentNow) body.urgent = true;
    try {
      const r = await api<{ item: Item; duplicate?: boolean }>("/api/items", { method: "POST", body });
      if (r.duplicate) toast("Already on the list");
      else {
        if (!items.some((i) => i.id === r.item.id)) {
          items = [r.item, ...items.filter((i) => i.bought_at === null), ...items.filter((i) => i.bought_at !== null)];
        }
        usual = usual.filter((u) => u.toLowerCase() !== name.toLowerCase());
        toast((urgentNow ? "Needed today: " : "Added ") + r.item.name);
      }
      if (photo) {
        pendingPhoto = null;
        syncCam();
      }
      if (urgentNow) {
        addUrgent = false;
        syncUrgent();
      }
      render();
    } catch (ex) {
      if (isQueued(ex)) {
        const me = session.me;
        const it: Item = {
          id,
          name,
          qty: qty ?? null,
          note: null,
          category: defaultCategory(),
          photo_key: photo,
          added_by: me?.id ?? null,
          added_by_name: me?.name ?? null,
          added_at: Date.now(),
          bought_by: null,
          bought_by_name: null,
          bought_at: null,
          urgent_at: urgentNow ? Date.now() : null,
        };
        items = [it, ...partition(items)];
        if (urgentNow) {
          addUrgent = false;
          syncUrgent();
        }
        usual = usual.filter((u) => u.toLowerCase() !== name.toLowerCase());
        if (photo) {
          pendingPhoto = null;
          syncCam();
        }
        render();
        toast("Added " + name + " · will sync when you are online");
        return;
      }
      toast(errMsg(ex), true);
      throw ex;
    }
  };

  const form = h(
    "form",
    {
      class: "add-form",
      onsubmit: async (e: Event) => {
        e.preventDefault();
        const name = nameIn.value.trim();
        if (!name) return;
        const qty = qtyIn.value.trim();
        addBtn.disabled = true;
        try {
          await addItemFn?.(name, qty || undefined);
          nameIn.value = "";
          qtyIn.value = "";
          nameIn.focus();
        } catch {
          /* toast already shown */
        } finally {
          addBtn.disabled = false;
        }
      },
    },
    nameIn,
    qtyIn,
    urgentBtn,
    camBtn,
    addBtn,
    datalist,
  );
  chipsEl = h("div", { class: "usual-row", hidden: true });
  bannerEl = h("div", { class: "shop-banner", role: "status", hidden: true });
  const storeBtn = h("button", { class: "btn small store-btn", type: "button", onclick: () => void enterStore() }, "\u{1F6D2} At the store");
  listEl = h("div", { class: "list-body" });
  el.replaceChildren(
    h(
      "div",
      { class: "view" },
      h("div", { class: "sticky-form" }, form, chipsEl),
      h("div", { class: "list-top" }, bannerEl, storeBtn),
      listEl,
    ),
  );
  void load().catch((e) => toast(errMsg(e), true));
  tick = setInterval(() => render(true), 60000);
  unsubOutbox = onOutboxChange(() => render());
  return () => {
    unsubOutbox?.();
    unsubOutbox = null;
    if (tick) clearInterval(tick);
    tick = null;
    store?.close();
    store = null;
    viewerClose?.();
    root = null;
    listEl = null;
    bannerEl = null;
    chipsEl = null;
    datalist = null;
    addItemFn = null;
    el.replaceChildren();
  };
}

export async function refresh(): Promise<void> {
  if (!root) return;
  if (pending) {
    needRefresh = true;
    return;
  }
  await load();
}

export const view: View = { mount, refresh };
