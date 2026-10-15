// Web Push client helpers (no framework). The server sends content-free pushes;
// the service worker then calls GET /api/push/notice with the token read from IndexedDB.

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

/** Silent re-registration on app launch (the browser may have rotated/expired the subscription). Best-effort. */
export async function resubscribePush(token: string): Promise<void> {
  try {
    if (!pushSupported() || Notification.permission !== "granted") return;
    await postSub(token, await ensureSub());
  } catch {
    /* best-effort */
  }
}

export async function disablePush(token: string): Promise<void> {
  try {
    if (pushSupported()) {
      const reg = await navigator.serviceWorker.ready;
      await (await reg.pushManager.getSubscription())?.unsubscribe();
    }
  } catch {
    /* ignore */
  }
  try {
    await fetch("/api/push/subscribe", { method: "DELETE", headers: { authorization: "Bearer " + token } });
  } catch {
    /* ignore */
  }
}
