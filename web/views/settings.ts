import { ApiError, api, getToken } from "../lib/api";
import { add, h } from "../lib/dom";
import { canInstall, promptInstall } from "../lib/install";
import { online } from "../lib/live";
import { isParent, loadSession, session } from "../lib/session";
import type { Member } from "../lib/session";
import { kvGet, kvSet } from "../lib/store";
import { getTextScale, getTextStyle, setTextScale, setTextStyle, type TextStyle } from "../lib/textstyle";
import { openTrash } from "../lib/trash";
import { confirmDialog, openSheet, timeAgo, toast } from "../lib/ui";

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

    add(
      body,
      h(
        "div",
        { class: "row" },
        h("div", { class: "grow" }, h("div", { class: "title" }, "Recently deleted"), h("div", { class: "sub" }, "Restore list items, tasks or your messages for 24 hours")),
        h("button", { class: "btn small", type: "button", onclick: () => openTrash() }, "Open"),
      ),
    );

    if (me.role === "parent") add(body, ...(await problemsSection()));

    // Notifications + install
    add(body, h("h3", null, "This device"));
    add(body, textStyleRow());
    add(body, textSizeRow());
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
    add(body, ...(await notifyPrefsGroup()));

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
  let onServer: boolean | null = null; // does the server know this very device? (null: could not ask)
  try {
    const push = await import("../push");
    supported = push.pushSupported();
    const tk = getToken();
    if (supported && tk) onServer = await push.deviceSubscribed(tk);
  } catch {
    supported = false;
  }
  if (!supported) {
    return h("div", { class: "row" }, h("div", { class: "grow" }, h("div", { class: "title" }, "Notifications"), h("div", { class: "sub" }, "Not supported on this device. Install the app to the home screen first.")));
  }
  const enabled = "Notification" in window && Notification.permission === "granted" && (onServer ?? (await kvGet<boolean>("pushOn")) === true);
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

interface NotifyPrefs {
  chat: boolean;
  tasks: boolean;
  list: boolean;
  quiet: { from: string; to: string } | null;
}

/** "What to notify me about": my choices follow me to every device and save the moment they change (reverted if saving fails). */
async function notifyPrefsGroup(): Promise<HTMLElement[]> {
  let prefs: NotifyPrefs;
  try {
    if (!(await import("../push")).pushSupported()) return [];
    prefs = (await api<{ prefs: NotifyPrefs }>("/api/push/prefs")).prefs;
  } catch {
    return [];
  }
  let saved = prefs; // what the server has
  let sending = false;
  let again = false;
  let lastQuiet = prefs.quiet ?? { from: "22:00", to: "07:00" };

  const flush = async (): Promise<void> => {
    if (sending) {
      again = true; // a newer change is waiting: send it right after this one
      return;
    }
    sending = true;
    do {
      again = false;
      try {
        saved = (await api<{ prefs: NotifyPrefs }>("/api/push/prefs", { method: "PUT", body: { prefs } })).prefs;
      } catch {
        prefs = saved;
        again = false;
        sync();
        toast("Could not save your notification choices", true);
      }
    } while (again);
    sending = false;
  };
  const update = (next: NotifyPrefs): void => {
    prefs = next;
    sync();
    void flush();
  };

  const toggle = (key: "chat" | "tasks" | "list", title: string, sub: string) => {
    const box = h("input", { type: "checkbox", role: "switch", "aria-label": title, onchange: () => update({ ...prefs, [key]: box.checked }) });
    const row = h("label", { class: "row check-row" }, h("div", { class: "grow" }, h("div", { class: "title" }, title), h("div", { class: "sub" }, sub)), box);
    return { box, row };
  };
  const chat = toggle("chat", "Chat messages", "New messages from the family");
  const tasks = toggle("tasks", "Tasks", "New tasks, replies and updates");
  const list = toggle("list", "Shopping list", "New items and shopping trips");

  const quietBox = h("input", {
    type: "checkbox",
    role: "switch",
    "aria-label": "Quiet hours",
    onchange: () => update({ ...prefs, quiet: quietBox.checked ? lastQuiet : null }),
  });
  const quietRow = h("label", { class: "row check-row" }, h("div", { class: "grow" }, h("div", { class: "title" }, "Quiet hours"), h("div", { class: "sub" }, "Pause alerts at night. Updates still show in the app")), quietBox);
  const timeField = (key: "from" | "to", label: string) => {
    const input = h("input", {
      class: "input dt",
      type: "time",
      onchange: () => {
        const q = prefs.quiet;
        if (!q) return;
        if (!input.value || input.value === q[key]) {
          input.value = q[key];
          return;
        }
        const next = { ...q, [key]: input.value };
        if (next.from === next.to) {
          input.value = q[key];
          toast("Pick two different times", true);
          return;
        }
        lastQuiet = next;
        update({ ...prefs, quiet: next });
      },
    });
    return { input, el: h("label", { class: "field" }, h("span", null, label), input) };
  };
  const from = timeField("from", "From");
  const to = timeField("to", "Until");
  const times = h("div", { class: "stack" }, h("div", { class: "quiet-times" }, from.el, to.el), h("p", { class: "muted" }, "Times are in the household's time zone."));

  function sync(): void {
    chat.box.checked = prefs.chat;
    tasks.box.checked = prefs.tasks;
    list.box.checked = prefs.list;
    quietBox.checked = !!prefs.quiet;
    times.hidden = !prefs.quiet;
    if (prefs.quiet) {
      lastQuiet = prefs.quiet;
      if (from.input.value !== prefs.quiet.from) from.input.value = prefs.quiet.from;
      if (to.input.value !== prefs.quiet.to) to.input.value = prefs.quiet.to;
    }
  }
  sync();

  return [
    h("h3", null, "What to notify me about"),
    h("p", { class: "muted" }, "These choices apply to all your devices."),
    chat.row,
    tasks.row,
    list.row,
    quietRow,
    times,
    h("p", { class: "muted" }, "Urgent tasks, 'needed today' items and reminders always come through."),
  ];
}

interface Problem {
  id: string;
  at: number;
  source: string;
  message: string;
  detail: string | null;
}

/** Parents: opt in to problem alerts and look at recent app problems. */
async function problemsSection(): Promise<HTMLElement[]> {
  let data: { errors: Problem[]; alerts: boolean };
  try {
    data = await api<{ errors: Problem[]; alerts: boolean }>("/api/errors");
  } catch {
    return [];
  }
  const alertBtn = h("button", { class: "btn small" + (data.alerts ? "" : " primary") }, data.alerts ? "Turn off" : "Turn on");
  alertBtn.addEventListener("click", async () => {
    alertBtn.disabled = true;
    try {
      const r = await api<{ alerts: boolean }>("/api/errors/alerts", { method: "PUT", body: { on: !data.alerts } });
      data.alerts = r.alerts;
      toast(r.alerts ? "You'll be alerted about app problems" : "Problem alerts off");
      alertBtn.textContent = r.alerts ? "Turn off" : "Turn on";
      alertBtn.classList.toggle("primary", !r.alerts);
      sub.textContent = r.alerts ? "On: at most one notification an hour" : "Get a notification when something breaks";
    } catch {
      toast("Could not change problem alerts", true);
    } finally {
      alertBtn.disabled = false;
    }
  });
  const sub = h("div", { class: "sub" }, data.alerts ? "On: at most one notification an hour" : "Get a notification when something breaks");
  const n = data.errors.length;
  const viewBtn = h("button", { class: "btn small", disabled: !n, onclick: () => openProblems(data.errors) }, "View");
  return [
    h("h3", null, "App problems"),
    h("div", { class: "row" }, h("div", { class: "grow" }, h("div", { class: "title" }, "Problem alerts"), sub), alertBtn),
    h(
      "div",
      { class: "row" },
      h("div", { class: "grow" }, h("div", { class: "title" }, n ? `${n === 50 ? "50+" : n} recent problem${n === 1 ? "" : "s"}` : "No problems recorded"), n ? h("div", { class: "sub" }, `Latest ${timeAgo(data.errors[0]!.at)}: ${data.errors[0]!.message.slice(0, 60)}`) : null),
      viewBtn,
    ),
  ];
}

function openProblems(list: Problem[]): void {
  const sheet = openSheet("App problems");
  const rows = list.map((p) =>
    h(
      "details",
      { class: "problem" },
      h("summary", null, h("span", { class: "problem-when" }, `${timeAgo(p.at)} · ${p.source}`), h("span", { class: "problem-msg" }, p.message)),
      p.detail ? h("pre", { class: "problem-detail" }, p.detail) : null,
    ),
  );
  add(
    sheet.body,
    h("p", { class: "muted" }, "Kept for 30 days. Tap one for details you can send to whoever fixes the app."),
    ...rows,
    h(
      "div",
      { class: "actions" },
      h("button", { class: "btn", type: "button", onclick: () => sheet.close() }, "Close"),
      h(
        "button",
        {
          class: "btn danger",
          type: "button",
          onclick: async () => {
            if (!(await confirmDialog("Clear the problem list?", "Clear", true))) return;
            try {
              await api("/api/errors", { method: "DELETE" });
              sheet.close();
              toast("Problem list cleared");
            } catch {
              toast("Could not clear", true);
            }
          },
        },
        "Clear all",
      ),
    ),
  );
}

/** Chalkboard handwriting (default) or a plain sans-serif with stronger grey text, for this phone only. */
function textStyleRow(): HTMLElement {
  const opts: [TextStyle, string][] = [
    ["chalk", "Chalkboard"],
    ["simple", "Simple"],
  ];
  const seg = h("div", { class: "seg", role: "group", "aria-label": "Text style" });
  const paint = (): void => {
    const cur = getTextStyle();
    for (const b of Array.from(seg.children)) {
      const on = (b as HTMLElement).dataset.v === cur;
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", String(on));
    }
  };
  for (const [v, label] of opts) {
    add(seg, h("button", { type: "button", "data-v": v, onclick: () => (setTextStyle(v), paint()) }, label));
  }
  paint();
  return h(
    "div",
    { class: "row" },
    h("div", { class: "grow" }, h("div", { class: "title" }, "Text style"), h("div", { class: "sub" }, "Simple is easier to read in long lists")),
    seg,
  );
}

/** Makes lists, tasks and chat bigger or smaller (the header and tab bar stay put), for this phone only. */
function textSizeRow(): HTMLElement {
  const opts: [number, string, string][] = [
    [0.9, "A−", "Small"],
    [1, "A", "Normal"],
    [1.15, "A+", "Large"],
    [1.3, "A++", "Larger"],
  ];
  const seg = h("div", { class: "seg", role: "group", "aria-label": "Text size" });
  const paint = (): void => {
    const cur = getTextScale();
    for (const b of Array.from(seg.children)) {
      const on = Number((b as HTMLElement).dataset.v) === cur;
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", String(on));
    }
  };
  for (const [v, label, name] of opts) {
    add(seg, h("button", { type: "button", "data-v": String(v), "aria-label": name, onclick: () => (setTextScale(v), paint()) }, label));
  }
  paint();
  return h(
    "div",
    { class: "row" },
    h("div", { class: "grow" }, h("div", { class: "title" }, "Text size"), h("div", { class: "sub" }, "Makes lists, tasks and chat bigger or smaller on this phone")),
    seg,
  );
}
