// Per-device text style: the chalkboard handwriting (default) or "simple" (system sans-serif, stronger
// secondary text). Kept in localStorage so it applies before anything is drawn; CSS lives in styles.css.
export type TextStyle = "chalk" | "simple";

const KEY = "baytTextStyle";

export function getTextStyle(): TextStyle {
  try {
    return localStorage.getItem(KEY) === "simple" ? "simple" : "chalk";
  } catch {
    return "chalk";
  }
}

// Per-device text size: a multiplier applied through the --text-scale custom property (see styles.css).
export const TEXT_SCALES = [0.9, 1, 1.15, 1.3] as const;

const SCALE_KEY = "baytTextScale";

export function getTextScale(): number {
  try {
    const n = Number(localStorage.getItem(SCALE_KEY));
    return TEXT_SCALES.some((s) => s === n) ? n : 1;
  } catch {
    return 1;
  }
}

export function applyTextStyle(s: TextStyle = getTextStyle(), scale: number = getTextScale()): void {
  if (s === "simple") document.documentElement.dataset.style = "simple";
  else delete document.documentElement.dataset.style;
  if (scale === 1) document.documentElement.style.removeProperty("--text-scale");
  else document.documentElement.style.setProperty("--text-scale", String(scale));
}

export function setTextStyle(s: TextStyle): void {
  try {
    if (s === "simple") localStorage.setItem(KEY, s);
    else localStorage.removeItem(KEY);
  } catch {
    /* storage blocked: still applies for this visit */
  }
  applyTextStyle(s);
}

export function setTextScale(n: number): void {
  if (!TEXT_SCALES.some((s) => s === n)) return;
  try {
    if (n === 1) localStorage.removeItem(SCALE_KEY);
    else localStorage.setItem(SCALE_KEY, String(n));
  } catch {
    /* storage blocked: still applies for this visit */
  }
  applyTextStyle(getTextStyle(), n);
}
