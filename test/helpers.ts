import { SELF, env } from "cloudflare:test";

export interface TestMember {
  id: string;
  token: string;
  role: "parent" | "nanny";
  name: string;
}

export async function api(
  path: string,
  opts: { method?: string; token?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const res = await SELF.fetch("http://x" + path, {
    method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

export async function setupFirst(name = "Dad"): Promise<TestMember> {
  const r = await api("/api/setup", { body: { code: "test-setup", name } });
  if (r.status !== 200) throw new Error("setup failed " + JSON.stringify(r));
  return { ...r.json.member, token: r.json.token };
}

export async function inviteAndJoin(inviter: TestMember, role: "parent" | "nanny", name: string): Promise<TestMember> {
  const inv = await api("/api/invites", { token: inviter.token, body: { role, name } });
  if (inv.status !== 200) throw new Error("invite failed " + JSON.stringify(inv));
  const j = await api("/api/join", { body: { secret: inv.json.secret } });
  if (j.status !== 200) throw new Error("join failed " + JSON.stringify(j));
  return { ...j.json.member, token: j.json.token };
}

/** Bootstraps a full household: Dad (setup), Mom (parent invite), Nanny (nanny invite). */
export async function makeHousehold(): Promise<{ dad: TestMember; mom: TestMember; nanny: TestMember }> {
  const dad = await setupFirst("Dad");
  const mom = await inviteAndJoin(dad, "parent", "Mom");
  const nanny = await inviteAndJoin(dad, "nanny", "Nanny");
  return { dad, mom, nanny };
}

/**
 * Deletes every row from every app table. Storage is NOT rolled back between tests in
 * pool-workers 0.23 (D1 state persists across tests), so call this in beforeEach.
 * Tables are discovered dynamically so later migrations are covered automatically.
 */
export async function resetDb(): Promise<void> {
  const { results } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name != 'd1_migrations'",
  ).all<{ name: string }>();
  await env.DB.batch(results.map((t) => env.DB.prepare(`DELETE FROM "${t.name}"`)));
}
