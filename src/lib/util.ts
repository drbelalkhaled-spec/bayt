import type { Context } from "hono";
import type { Env } from "../env";

const te = new TextEncoder();

export function randHex(bytes: number): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export async function sha256hex(s: string): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", te.encode(s)));
  return [...h].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export const newId = (): string => crypto.randomUUID();

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Optional client-generated id (idempotency key): undefined = absent, string = valid UUID v4 (lowercased), false = invalid. */
export function clientId(v: unknown): string | undefined | false {
  if (v === undefined || v === null) return undefined;
  return typeof v === "string" && UUID_V4.test(v) ? v.toLowerCase() : false;
}
export const now = (): number => Date.now();

/** Constant-time string compare (length leak only). */
export function safeEqual(a: string, b: string): boolean {
  const x = te.encode(a);
  const y = te.encode(b);
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return d === 0;
}

export const MAX_NAME = 40;
const NAME_BAD = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff\u3164\u115f\u1160\uffa0\u2800\p{Cf}]/u;

/** True when the name is NOT acceptable. */
export const badName = (name: unknown): boolean =>
  typeof name !== "string" ||
  !name.trim() ||
  name.trim().length > MAX_NAME ||
  NAME_BAD.test(name);

export const nameKey = (name: string): string =>
  name.normalize("NFKD").replace(/\s+/g, " ").trim().toLowerCase();

export const cleanName = (name: string): string => name.trim().replace(/\s+/g, " ");

export const ok = (c: Context, data: unknown = { ok: true }, status: 200 | 201 = 200) =>
  c.json(data as object, status);

export const fail = (c: Context, error: string, status: 400 | 401 | 403 | 404 | 409 | 429 = 400) =>
  c.json({ error }, status);

export async function readJson(c: Context): Promise<Record<string, unknown>> {
  try {
    const b = await c.req.json();
    return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Household IANA timezone (config key `tz`), default 'UTC'. */
export async function householdTz(env: Env): Promise<string> {
  const row = await env.DB.prepare("SELECT v FROM config WHERE k = 'tz'").first<{ v: string }>();
  return row?.v || "UTC";
}

export function validTz(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const setTz = (env: Env, tz: string) =>
  env.DB.prepare("INSERT INTO config(k, v) VALUES('tz', ?1) ON CONFLICT(k) DO UPDATE SET v = excluded.v")
    .bind(tz)
    .run();
