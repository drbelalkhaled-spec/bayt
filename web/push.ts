// Web Push client helpers (no framework). The server sends content-free pushes;
// the service worker then calls GET /api/push/notices with the token read from IndexedDB.
// A member can have several devices; each one is identified by its push endpoint.

import { kvGet } from "./lib/store";

export type PushResult = "granted" | "denied" | "unsupported";

const b64uToU8 = (s: string): Uint8Array => {
  const p = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  return Uint8Array.from(atob(p), (c) => c.charCodeAt(0));
};

export function pushSupported(): boolean {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

async function getKey(): Promise<Uint8Array> {
  const r = await fetch("/api/push/key");
  if (!r.ok) throw new Error("key");
  return b64uToU8(((await r.json()) as { key: string }).key);
}

async function ensureSub(): Promise<PushSubscription> {
  const reg = await navigator.serviceWorker.ready;
  return (
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: (await getKey()) as BufferSource,
    }))
  );
}

async function postSub(token: string, sub: PushSubscription): Promise<void> {
  const r = await fetch("/api/push/subscribe", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + token },
    body: JSON.stringify({ subscription: sub.toJSON() }),
  });
  if (!r.ok) throw new Error("subscribe");
}

export async function enablePush(token: string): Promise<PushResult> {
  if (!pushSupported()) return "unsupported";
  try {
    const perm = await Notification.requestPermission();
    if (perm !== "granted") return "denied";
    await postSub(token, await ensureSub());
    return "granted";
  } catch {
    return "unsupported";
  }
}

/** This device's current browser subscription, or null. Never waits for a service worker that is not registered. */
async function deviceSub(): Promise<PushSubscription | null> {
  try {
    if (!pushSupported()) return null;
    return (await (await navigator.serviceWorker.getRegistration())?.pushManager.getSubscription()) ?? null;
  } catch {
    return null;
  }
}

/** Silent re-registration on app launch (the browser may have rotated/expired the subscription). Best-effort. */
export async function resubscribePush(token: string): Promise<void> {
  try {
    if (!pushSupported() || Notification.permission !== "granted") return;
    if ((await kvGet<boolean>("pushOn").catch(() => undefined)) === false) return; // turned off in Settings
    await postSub(token, await ensureSub());
  } catch {
    /* best-effort */
  }
}

/** Does the server know this device? null when that cannot be told (offline, unsupported). */
export async function deviceSubscribed(token: string): Promise<boolean | null> {
  try {
    if (Notification.permission !== "granted") return false;
    const endpoint = (await deviceSub())?.endpoint;
    if (!endpoint) return false;
    const r = await fetch("/api/push/status?endpoint=" + encodeURIComponent(endpoint), { headers: { authorization: "Bearer " + token } });
    return r.ok ? ((await r.json()) as { subscribed?: boolean }).subscribed === true : null;
  } catch {
    return null;
  }
}

/** Stops notifications on this device only (other devices of the same person keep theirs). */
export async function disablePush(token: string): Promise<void> {
  let endpoint: string | undefined;
  try {
    const sub = await deviceSub();
    endpoint = sub?.endpoint;
    await sub?.unsubscribe();
  } catch {
    /* ignore */
  }
  if (!endpoint) return;
  try {
    await fetch("/api/push/subscribe", {
      method: "DELETE",
      headers: { "content-type": "application/json", authorization: "Bearer " + token },
      body: JSON.stringify({ endpoint }),
    });
  } catch {
    /* ignore */
  }
}
