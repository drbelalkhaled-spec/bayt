import { ApiError, api, getToken } from "../lib/api";
import { add, h } from "../lib/dom";
import { canInstall, promptInstall } from "../lib/install";
import { online } from "../lib/live";
import { isParent, loadSession, session } from "../lib/session";
import type { Member } from "../lib/session";
import { kvGet, kvSet } from "../lib/store";
import { confirmDialog, openSheet, toast } from "../lib/ui";

export function openSettings(signOut: () => void): void {
  const sheet = openSheet("Settings");
  const body = sheet.body;

  const paint = async () => {
    body.replaceChildren();
    const me = session.me;
    if (!me) return;

    // Name (helpers' names are set by the parent who invited them)
    if (me.role !== "parent") {
      add(body, h("h3", null, "Your name"), h("div", { class: "row flat" }, h("div", { class: "title" }, me.name)));
    } else {
      const nameInput = h("input", { class: "input", value: me.name, maxLength: 40, autocomplete: "off", "aria-label": "Your name" });
      add(body,
        h("h3", null, "Your name"),
        h(
          "form",
          {
            class: "row flat",
            onsubmit: async (e: Event) => {
              e.preventDefault();
              const name = nameInput.value.trim();
              if (!name || name === me.name) return;
              try {
                await api("/api/me", { method: "PATCH", body: { name } });
                await loadSession();
                toast("Name updated");
                void paint();
              } catch (ex) {
                toast(ex instanceof ApiError && ex.code === "name_taken" ? "That name is taken" : "Could not save name", true);
              }
            },
          },
          h("div", { class: "grow" }, nameInput),
          h("button", { class: "btn small primary", type: "submit" }, "Save"),
        ),
      );
    }

    // Members
    const on = online();
    add(body, 
      h("h3", null, "Members"),
      ...session.members.map((m) =>
        h(
          "div",
          { class: "row" },
          h("span", { class: "avatar" }, m.name.slice(0, 1).toUpperCase()),
          h("div", { class: "grow" }, h("div", { class: "title" }, m.name + (m.id === me.id ? " (you)" : "")), m.role === "parent" ? h("div", { class: "sub" }, "Parent") : null),
          h("span", { class: "dot" + (on.has(m.id) || m.id === me.id ? " on" : ""), title: on.has(m.id) ? "Online" : "Offline" }),
          isParent() && m.id !== me.id ? h("button", { class: "btn small danger", onclick: () => removeMember(m, paint) }, "Remove") : null,
        ),
      ),
    );

    // Invites
    if (isParent()) {
      const linkBox = h("div", { class: "stack" });
      const nameIn = h("input", { class: "input", maxLength: 40, autocomplete: "off", placeholder: "Their name, e.g. Aisha", "aria-label": "Name of the person to invite" });
      const manage = h("input", { type: "checkbox", "aria-label": "Can manage tasks and invites" });
      add(body,
        h("h3", null, "Invite someone"),
        h(
          "form",
          {
            class: "stack",
            onsubmit: (e: Event) => {
              e.preventDefault();
              const name = nameIn.value.trim();
              if (!name) return toast("Type their name first", true);
              void invite((manage as HTMLInputElement).checked ? "parent" : "nanny", name, linkBox);
            },
          },
          nameIn,
          h("label", { class: "check-row" }, manage, h("span", null, "Can manage tasks and invites (for a parent)")),
          h("button", { class: "btn primary", type: "submit" }, "Create invite link"),
        ),
        linkBox,
      );
    }

    // Notifications + install
    add(body, h("h3", null, "This device"));
    add(body, await notificationsRow());
    if (canInstall()) {
      add(body, 
        h(
          "div",
          { class: "row" },
          h("div", { class: "grow" }, h("div", { class: "title" }, "Install app"), h("div", { class: "sub" }, "Add Bayt to your home screen")),
          h(
            "button",
            {
              class: "btn small primary",
              onclick: async () => {
                await promptInstall();
                void paint();
              },
            },
            "Install",
          ),
        ),
      );
    }

    add(body, 
      h(
        "div",
        { class: "actions" },
        h(
          "button",
          {
            class: "btn danger",
            onclick: async () => {
              if (!(await confirmDialog("Sign out of Bayt on this device?", "Sign out", true))) return;
              sheet.close();
              signOut();
            },
          },
          "Sign out",
        ),
      ),
    );
  };

  void paint();
}

async function removeMember(m: Member, repaint: () => Promise<void>): Promise<void> {
  if (!(await confirmDialog(`Remove ${m.name} from your home? They will be signed out.`, "Remove", true))) return;
  try {
    await api(`/api/members/${encodeURIComponent(m.id)}`, { method: "DELETE" });
    await loadSession();
    toast(`${m.name} removed`);
    void repaint();
  } catch {
    toast("Could not remove member", true);
  }
}

async function invite(role: "parent" | "nanny", name: string, out: HTMLElement): Promise<void> {
  try {
    const r = await api<{ secret: string; name: string }>("/api/invites", { body: { role, name } });
    const link = `${location.origin}/#join=${r.secret}`;
    out.replaceChildren(
      h("div", { class: "muted" }, `Invite link for ${r.name} (works once, expires in 24 hours):`),
      h("div", { class: "link-box" }, link),
      h(
        "div",
        { class: "actions" },
        h(
          "button",
          {
            class: "btn",
            onclick: async () => {
              try {
                await navigator.clipboard.writeText(link);
                toast("Link copied");
              } catch {
                toast("Select the link and copy it", true);
              }
            },
          },
          "Copy",
        ),
        typeof navigator.share === "function"
          ? h(
              "button",
              {
                class: "btn primary",
                onclick: () => {
                  navigator.share({ title: "Join our home on Bayt", text: `${r.name}, join our home on Bayt`, url: link }).catch(() => undefined);
                },
              },
              "Share",
            )
          : null,
      ),
    );
  } catch (ex) {
    toast(ex instanceof ApiError && ex.code === "household_full" ? "Your home is full" : ex instanceof ApiError && ex.code === "too_many_invites" ? "Too many open invites" : ex instanceof ApiError && ex.code === "name_taken" ? "Someone already has that name" : ex instanceof ApiError && ex.code === "bad_name" ? "Please type a name (up to 40 letters)" : "Could not create invite", true);
  }
}

async function notificationsRow(): Promise<HTMLElement> {
  let supported = false;
  try {
    const push = await import("../push");
    supported = push.pushSupported();
  } catch {
    supported = false;
  }
  if (!supported) {
    return h("div", { class: "row" }, h("div", { class: "grow" }, h("div", { class: "title" }, "Notifications"), h("div", { class: "sub" }, "Not supported on this device. Install the app to the home screen first.")));
  }
  const enabled = (await kvGet<boolean>("pushOn")) === true && "Notification" in window && Notification.permission === "granted";
  const btn = h("button", { class: "btn small" + (enabled ? "" : " primary") }, enabled ? "Turn off" : "Turn on");
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    const token = getToken();
    try {
      const push = await import("../push");
      if (!token) return;
      if (enabled) {
        await push.disablePush(token);
        await kvSet("pushOn", false);
        toast("Notifications off");
      } else {
        const r = await push.enablePush(token);
        await kvSet("pushOn", r === "granted");
        toast(r === "granted" ? "Notifications on" : r === "denied" ? "Notifications are blocked in browser settings" : "Notifications are not supported here", r !== "granted");
      }
    } catch {
      toast("Could not change notifications", true);
    }
    const row = btn.closest(".row");
    if (row) row.replaceWith(await notificationsRow());
  });
  return h("div", { class: "row" }, h("div", { class: "grow" }, h("div", { class: "title" }, "Notifications"), h("div", { class: "sub" }, enabled ? "On for this device" : "Get alerts for new messages and tasks")), btn);
}
