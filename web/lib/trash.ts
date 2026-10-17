// Undo for deletes and the "Recently deleted" sheet. The server keeps a deleted item, task or message
// for 24 hours; restoring puts it back exactly and the live update refreshes every screen.
import { add, clear, h } from "./dom";
import { api } from "./api";
import { openSheet, timeAgo, toast } from "./ui";

const UNDO_MS = 7000;

async function restore(ids: string[]): Promise<boolean> {
  try {
    for (const id of ids) await api(`/api/trash/${id}/restore`, { method: "POST", body: {} });
    return true;
  } catch {
    toast("Could not undo", true);
    return false;
  }
}

/** "Deleted X · Undo" toast. `after` runs once it is back (e.g. to reload the view). */
export function undoToast(label: string, trashIds: string[] | undefined, after?: () => void): void {
  const ids = (trashIds ?? []).filter(Boolean);
  if (!ids.length) return void toast(`Deleted ${label}`);
  toast(`Deleted ${label}`, {
    ms: UNDO_MS,
    action: {
      label: "Undo",
      run: () =>
        void restore(ids).then((ok) => {
          if (!ok) return;
          toast("Restored");
          after?.();
        }),
    },
  });
}

interface TrashEntry {
  id: string;
  kind: "item" | "task" | "message";
  label: string;
  deleted_by: string;
  deleted_by_name: string | null;
  deleted_at: number;
}

const ICON = { item: "🛒", task: "✅", message: "💬" } as const;

/** Everything this person may restore: list items (everyone), tasks (parents), their own messages. */
export function openTrash(): void {
  const sheet = openSheet("Recently deleted");
  const list = h("div", { class: "stack trash-list" });
  const fill = async (): Promise<void> => {
    clear(list);
    let entries: TrashEntry[];
    try {
      entries = (await api<{ trash: TrashEntry[] }>("/api/trash")).trash;
    } catch {
      return void add(list, h("p", { class: "error" }, "Could not load"));
    }
    if (!entries.length) return void add(list, h("p", { class: "muted" }, "Nothing deleted in the last 24 hours."));
    for (const e of entries) {
      add(
        list,
        h(
          "div",
          { class: "row trash-row" },
          h("span", { class: "trash-ico", "aria-hidden": "true" }, ICON[e.kind]),
          h(
            "div",
            { class: "grow" },
            h("div", { class: "title trash-label" }, e.label || "(empty)"),
            h("div", { class: "sub" }, `deleted by ${e.deleted_by_name || "someone"} · ${timeAgo(e.deleted_at)}`),
          ),
          h(
            "button",
            {
              class: "btn small primary",
              type: "button",
              onclick: async () => {
                if (await restore([e.id])) {
                  toast("Restored");
                  void fill();
                }
              },
            },
            "Restore",
          ),
          h(
            "button",
            {
              class: "btn small ghost",
              type: "button",
              "aria-label": "Delete forever: " + e.label,
              onclick: async () => {
                try {
                  await api(`/api/trash/${e.id}`, { method: "DELETE" });
                  void fill();
                } catch {
                  toast("Could not delete", true);
                }
              },
            },
            "✕",
          ),
        ),
      );
    }
  };
  add(sheet.body, h("p", { class: "muted" }, "Deleted things stay here for 24 hours. ✕ removes one for good now."), list);
  void fill();
}
