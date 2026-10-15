// Captures the browser's install prompt so Settings can offer an "Install app" button.
interface InstallEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: string }>;
}
let deferred: InstallEvent | null = null;

export const isStandalone = (): boolean =>
  matchMedia("(display-mode: standalone)").matches || (navigator as unknown as { standalone?: boolean }).standalone === true;

export function initInstall(): void {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e as InstallEvent;
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
  });
}

export const canInstall = (): boolean => !!deferred && !isStandalone();

export async function promptInstall(): Promise<void> {
  const e = deferred;
  if (!e) return;
  deferred = null;
  await e.prompt();
  await e.userChoice.catch(() => undefined);
}
