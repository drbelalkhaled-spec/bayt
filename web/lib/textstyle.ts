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

export function applyTextStyle(s: TextStyle = getTextStyle()): void {
  if (s === "simple") document.documentElement.dataset.style = "simple";
  else delete document.documentElement.dataset.style;
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
