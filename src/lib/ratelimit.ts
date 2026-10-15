import type { Env } from "../env";

interface Rate {
  fails: number;
  until: number;
}

async function read(env: Env, key: string): Promise<Rate> {
  const row = await env.DB.prepare("SELECT v FROM config WHERE k = ?1").bind(key).first<{ v: string }>();
  return row ? (JSON.parse(row.v) as Rate) : { fails: 0, until: 0 };
}

export async function rateLimited(env: Env, key: string): Promise<boolean> {
  const r = await read(env, key);
  return !!r.until && Date.now() < r.until;
}

export async function rateFail(env: Env, key: string): Promise<void> {
  const r = await read(env, key);
  const fails = r.fails + 1;
  const until = fails >= 5 ? Date.now() + Math.min(3_600_000, 1000 * 2 ** (fails - 4)) : 0;
  await env.DB.prepare("INSERT INTO config(k, v) VALUES(?1, ?2) ON CONFLICT(k) DO UPDATE SET v = ?2")
    .bind(key, JSON.stringify({ fails, until }))
    .run();
}

export async function rateClear(env: Env, key: string): Promise<void> {
  await env.DB.prepare("DELETE FROM config WHERE k = ?1").bind(key).run();
}
