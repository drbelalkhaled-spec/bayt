/** Pure date helpers for repeating tasks. Dates are 'YYYY-MM-DD' calendar days; times are 'HH:MM'. */

export type Recur = { freq: "daily" } | { freq: "every"; days: number } | { freq: "weekly"; weekdays: number[] };

export const SLOTS = ["morning", "afternoon", "evening"] as const;
export type Slot = (typeof SLOTS)[number];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function validDateStr(v: unknown): v is string {
  if (typeof v !== "string" || !DATE_RE.test(v)) return false;
  const d = new Date(v + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

export const validTimeStr = (v: unknown): v is string => typeof v === "string" && TIME_RE.test(v);

/** Strictly validates and canonicalizes a recur value. Returns null for null, false when invalid. */
export function parseRecur(v: unknown): Recur | null | false {
  if (v === null) return null;
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).sort().join(",");
  if (o.freq === "daily") return keys === "freq" ? { freq: "daily" } : false;
  if (o.freq === "every") {
    if (keys !== "days,freq") return false;
    const n = o.days;
    return typeof n === "number" && Number.isInteger(n) && n >= 2 && n <= 30 ? { freq: "every", days: n } : false;
  }
  if (o.freq === "weekly") {
    if (keys !== "freq,weekdays" || !Array.isArray(o.weekdays) || !o.weekdays.length || o.weekdays.length > 7) return false;
    if (!o.weekdays.every((d) => typeof d === "number" && Number.isInteger(d) && d >= 0 && d <= 6)) return false;
    return { freq: "weekly", weekdays: [...new Set(o.weekdays as number[])].sort((a, b) => a - b) };
  }
  return false;
}

/** Parses a stored recur JSON string; null if absent or corrupt. */
export function readRecur(s: string | null | undefined): Recur | null {
  if (!s) return null;
  try {
    return parseRecur(JSON.parse(s)) || null;
  } catch {
    return null;
  }
}

const toUtc = (date: string): number => {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
};
const fromUtc = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export const addDays = (date: string, n: number): string => fromUtc(toUtc(date) + n * 86_400_000);
/** 0 = Sunday. */
export const weekdayOf = (date: string): number => new Date(toUtc(date)).getUTCDay();

/** The next due date strictly after `from`. */
export function nextDue(recur: Recur, from: string): string {
  switch (recur.freq) {
    case "daily":
      return addDays(from, 1);
    case "every":
      return addDays(from, recur.days);
    case "weekly": {
      for (let i = 1; i <= 7; i++) {
        const d = addDays(from, i);
        if (recur.weekdays.includes(weekdayOf(d))) return d;
      }
      return addDays(from, 7);
    }
  }
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

function wallParts(at: number, tz: string): { y: number; mo: number; d: number; h: number; mi: number; s: number } {
  const p: Record<string, number> = {};
  for (const x of fmt(tz).formatToParts(new Date(at))) if (x.type !== "literal") p[x.type] = Number(x.value);
  return { y: p.year!, mo: p.month!, d: p.day!, h: p.hour === 24 ? 0 : p.hour!, mi: p.minute!, s: p.second! };
}

/** Offset (ms) of tz from UTC at instant `at` (wall time = at + offset). */
function offsetAt(at: number, tz: string): number {
  const w = wallParts(at, tz);
  const wall = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
  return wall - Math.floor(at / 1000) * 1000;
}

/** Calendar day 'YYYY-MM-DD' in tz at instant `at` (default now). */
export function todayIn(tz: string, at = Date.now()): string {
  const w = wallParts(at, tz);
  return `${w.y}-${String(w.mo).padStart(2, "0")}-${String(w.d).padStart(2, "0")}`;
}

/** Epoch ms of wall-clock `date time` in tz. DST-safe: iterates the offset until it is stable. */
export function zonedToEpoch(date: string, time: string, tz: string): number {
  const [hh, mm] = time.split(":").map(Number) as [number, number];
  const wall = toUtc(date) + (hh * 60 + mm) * 60_000;
  let t = wall - offsetAt(wall, tz);
  for (let i = 0; i < 3; i++) {
    const next = wall - offsetAt(t, tz);
    if (next === t) break;
    t = next;
  }
  return t;
}
