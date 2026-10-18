// Captures the browser's install prompt so Settings (and the one-time banner) can offer "Install app".
interface InstallEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: string }>;
}
let deferred: InstallEvent | null = null;
const listeners = new Set<() => void>();
const notify = (): void => listeners.forEach((cb) => cb());

export const isStandalone = (): boolean =>
  matchMedia("(display-mode: standalone)").matches || (navigator as unknown as { standalone?: boolean }).standalone === true;

/** iPhone/iPad: no install prompt event, installing is Share → Add to Home Screen. */
export const isIOS = (): boolean => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

export function initInstall(): void {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e as InstallEvent;
    notify();
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    notify();
  });
}

export const canInstall = (): boolean => !!deferred && !isStandalone();

/** Install state changed (prompt became available, or the app got installed). */
export function onInstallChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export async function promptInstall(): Promise<void> {
  const e = deferred;
  if (!e) return;
  deferred = null;
  await e.prompt();
  await e.userChoice.catch(() => undefined);
  notify();
}

const BANNER_KEY = "bayt.installBanner.dismissed";

export function bannerDismissed(): boolean {
  try {
    return localStorage.getItem(BANNER_KEY) === "1";
  } catch {
    return false;
  }
}

export function dismissBanner(): void {
  try {
    localStorage.setItem(BANNER_KEY, "1");
  } catch {
    /* storage blocked: hides for this visit only */
  }
}
