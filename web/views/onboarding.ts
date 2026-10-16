import { ApiError, api, setToken } from "../lib/api";
import { h } from "../lib/dom";
import { clearHash, joinSecret } from "../lib/router";
import type { Member } from "../lib/session";

const ERRORS: Record<string, string> = {
  forbidden: "That setup code is not right.",
  rate_limited: "Too many tries. Please wait a few minutes.",
  bad_name: "Please enter a name (1 to 40 characters).",
  name_taken: "Someone in your home already uses that name. Ask for a new invite.",
  household_full: "This home already has all its members.",
  bad_invite: "This invite link is invalid or expired. Ask for a new one.",
  network: "Cannot reach the server. Check your connection.",
};

function shell(...children: (Node | string)[]): HTMLElement {
  return h(
    "div",
    { class: "onboard" },
    h("div", { class: "card" }, h("img", { class: "logo", src: "/icons/icon.svg", alt: "", width: 64, height: 64 }), ...children),
  );
}

/** A form with named fields + one submit; shows server errors inline. */
function form(
  fields: { name: string; label: string; placeholder?: string; type?: string; autocomplete?: string }[],
  submitLabel: string,
  send: (values: Record<string, string>) => Promise<{ token: string; member: Member }>,
  done: () => void,
): HTMLElement {
  const err = h("p", { class: "error", role: "alert" });
  const inputs = fields.map((f) =>
    h("input", {
      class: "input",
      name: f.name,
      type: f.type || "text",
      placeholder: f.placeholder || "",
      autocomplete: f.autocomplete || "off",
      maxLength: 60,
      required: true,
    }),
  );
  const btn = h("button", { class: "btn primary block", type: "submit" }, submitLabel);
  const el = h(
    "form",
    {
      class: "stack",
      onsubmit: async (e: Event) => {
        e.preventDefault();
        err.textContent = "";
        btn.disabled = true;
        try {
          const values: Record<string, string> = {};
          fields.forEach((f, i) => (values[f.name] = inputs[i].value.trim()));
          const r = await send(values);
          await setToken(r.token);
          clearHash();
          history.replaceState(null, "", "#/list");
          done();
        } catch (ex) {
          const code = ex instanceof ApiError ? ex.code : "network";
          err.textContent = ERRORS[code] || "Something went wrong. Please try again.";
          btn.disabled = false;
        }
      },
    },
    fields.map((f, i) => h("label", { class: "field" }, h("span", null, f.label), inputs[i])),
    err,
    btn,
  );
  return el;
}

/** Pull the invite secret out of a pasted link (or a bare secret). */
function pastedSecret(text: string): string | null {
  const t = text.trim();
  const m = /#join=([\w-]+)/.exec(t);
  if (m) return m[1];
  return /^[\w-]{16,}$/.test(t) ? t : null;
}

/**
 * "Paste invite link" form, for when tapping the link opened another app or
 * browser. A valid paste re-runs onboarding as if the link had been opened here.
 */
function pasteInvite(root: HTMLElement, done: () => void): HTMLElement {
  const err = h("p", { class: "error", role: "alert" });
  const input = h("input", {
    class: "input",
    name: "invite",
    // Plain text, not "url": a shared message may carry words around the link.
    type: "text",
    inputMode: "url",
    placeholder: "https://.../#join=...",
    autocomplete: "off",
    required: true,
  });
  return h(
    "form",
    {
      class: "stack",
      onsubmit: (e: Event) => {
        e.preventDefault();
        const secret = pastedSecret(input.value);
        if (!secret) {
          err.textContent = "That does not look like an invite link. Copy the whole link and try again.";
          return;
        }
        history.replaceState(null, "", "#join=" + secret);
        void showOnboarding(root, done);
      },
    },
    h("label", { class: "field" }, h("span", null, "Got an invite link? Paste it here"), input),
    err,
    h("button", { class: "btn primary block", type: "submit" }, "Open invite"),
  );
}

/**
 * Show the right onboarding screen into `root`. Resolves nothing; calls `done`
 * once a token was stored.
 */
export async function showOnboarding(root: HTMLElement, done: () => void): Promise<void> {
  root.replaceChildren(shell(h("p", null, "Loading...")));
  const secret = joinSecret();

  if (secret) {
    try {
      const p = await api<{ name: string | null; invited_by_name: string }>(`/api/invites/peek?s=${encodeURIComponent(secret)}`);
      // The inviter chose the name; older invites without one still ask for it.
      const fields = p.name ? [] : [{ name: "name", label: "Your name", placeholder: "e.g. Sara", autocomplete: "given-name" }];
      root.replaceChildren(
        shell(
          h("h1", null, p.name ? `Welcome, ${p.name}!` : "Welcome to Bayt"),
          h("p", null, `${p.invited_by_name} invited you to join our home on Bayt.`),
          form(fields, "Join", (v) => api("/api/join", { body: p.name ? { secret } : { secret, name: v.name } }), done),
        ),
      );
    } catch (ex) {
      const code = ex instanceof ApiError ? ex.code : "network";
      root.replaceChildren(shell(h("h1", null, "Invite problem"), h("p", null, ERRORS[code] || ERRORS.bad_invite), pasteInvite(root, done)));
    }
    return;
  }

  let setup = false;
  try {
    setup = (await api<{ setup: boolean }>("/api/status")).setup;
  } catch {
    root.replaceChildren(
      shell(h("h1", null, "Cannot connect"), h("p", null, ERRORS.network), h("button", { class: "btn block", onclick: () => location.reload() }, "Try again")),
    );
    return;
  }

  if (setup) {
    root.replaceChildren(
      shell(
        h("h1", null, "Set up your home"),
        h("p", null, "Enter the setup code and your name to create your household."),
        form(
          [
            { name: "code", label: "Setup code", type: "password", autocomplete: "off" },
            { name: "name", label: "Your name", placeholder: "e.g. Mom", autocomplete: "given-name" },
          ],
          "Create home",
          (v) => api("/api/setup", { body: { code: v.code, name: v.name } }),
          done,
        ),
      ),
    );
  } else {
    root.replaceChildren(
      shell(h("h1", null, "Welcome to Bayt"), h("p", null, "Ask a family member for an invite link."), pasteInvite(root, done)),
    );
  }
}
