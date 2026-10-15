import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { cleanupMedia } from "../src/lib/cleanup";
import { attachMedia, deleteMedia } from "../src/lib/media";
import { api, makeHousehold, resetDb, type TestMember } from "./helpers";

const up = (token: string | undefined, type: string, body: BodyInit) =>
  SELF.fetch("http://x/api/media", {
    method: "POST",
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": type },
    body,
  });

let dad: TestMember, nanny: TestMember;
beforeEach(async () => {
  await resetDb();
  ({ dad, nanny } = await makeHousehold());
});

describe("media", () => {
  it("round-trips an upload", async () => {
    const r = await up(dad.token, "image/png", new Uint8Array([1, 2, 3, 4]));
    expect(r.status).toBe(200);
    const j: any = await r.json();
    expect(j.content_type).toBe("image/png");
    expect(j.size).toBe(4);
    const g = await SELF.fetch("http://x/api/media/" + j.key, { headers: { authorization: `Bearer ${nanny.token}` } });
    expect(g.status).toBe(200);
    expect(g.headers.get("content-type")).toBe("image/png");
    expect(g.headers.get("x-content-type-options")).toBe("nosniff");
    expect(g.headers.get("cache-control")).toContain("immutable");
    expect([...new Uint8Array(await g.arrayBuffer())]).toEqual([1, 2, 3, 4]);
  });

  it("rejects bad type, empty and oversize", async () => {
    expect((await up(dad.token, "text/html", "x")).status).toBe(400);
    expect((await up(dad.token, "image/png", new Uint8Array(0))).status).toBe(400);
    expect((await up(dad.token, "image/png", new Uint8Array(8 * 1024 * 1024 + 1))).status).toBe(413);
  });

  it("requires auth; ?t= only works on GET", async () => {
    expect((await up(undefined, "image/png", new Uint8Array([1]))).status).toBe(401);
    const j: any = await (await up(dad.token, "image/png", new Uint8Array([9]))).json();
    expect((await SELF.fetch("http://x/api/media/" + j.key)).status).toBe(401);
    expect((await SELF.fetch(`http://x/api/media/${j.key}?t=${dad.token}`)).status).toBe(200);
    expect((await SELF.fetch(`http://x/api/media/${j.key}?t=bad`)).status).toBe(401);
    const post = await SELF.fetch(`http://x/api/media?t=${dad.token}`, {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: new Uint8Array([1]),
    });
    expect(post.status).toBe(401);
    expect((await api(`/api/me?t=${dad.token}`)).status).toBe(401);
    const auth = { headers: { authorization: `Bearer ${dad.token}` } };
    expect((await SELF.fetch("http://x/api/media/not-a-uuid", auth)).status).toBe(404);
    expect((await SELF.fetch(`http://x/api/media/${crypto.randomUUID()}`, auth)).status).toBe(404);
  });

  it("attachMedia checks ownership; deleteMedia removes object and row", async () => {
    const j: any = await (await up(dad.token, "image/webp", new Uint8Array([1]))).json();
    expect(await attachMedia(env, j.key, nanny.id)).toBe(false);
    expect(await attachMedia(env, crypto.randomUUID(), dad.id)).toBe(false);
    expect(await attachMedia(env, j.key, dad.id)).toBe(true);
    expect((await env.DB.prepare("SELECT attached FROM media WHERE key = ?1").bind(j.key).first<any>()).attached).toBe(1);
    await deleteMedia(env, j.key);
    expect(await env.MEDIA.get(j.key)).toBeNull();
    expect(await env.DB.prepare("SELECT 1 FROM media WHERE key = ?1").bind(j.key).first()).toBeNull();
  });

  it("cleanupMedia drops old unattached and orphaned media, keeps referenced", async () => {
    const mk = async () => ((await (await up(dad.token, "image/png", new Uint8Array([1]))).json()) as any).key as string;
    const fresh = await mk();
    const old = await mk();
    const kept = await mk();
    const orphan = await mk();
    const t = Date.now();
    await env.DB.prepare("UPDATE media SET created_at = ?1 WHERE key = ?2").bind(t - 25 * 3_600_000, old).run();
    await attachMedia(env, kept, dad.id);
    await attachMedia(env, orphan, dad.id);
    await env.DB.prepare("INSERT INTO items(id, name, added_by, added_at, photo_key) VALUES('i1','milk',?1,?2,?3)")
      .bind(dad.id, t, kept)
      .run();
    await cleanupMedia(env, t);
    const has = async (k: string) => !!(await env.DB.prepare("SELECT 1 FROM media WHERE key = ?1").bind(k).first());
    expect(await has(fresh)).toBe(true);
    expect(await has(old)).toBe(false);
    expect(await env.MEDIA.get(old)).toBeNull();
    expect(await has(kept)).toBe(true);
    expect(await has(orphan)).toBe(false);
    expect(await env.MEDIA.get(orphan)).toBeNull();
  });
});

describe("household tz", () => {
  it("defaults to UTC; parent sets, nanny cannot, bad tz rejected", async () => {
    expect((await api("/api/household", { token: nanny.token })).json.tz).toBe("UTC");
    expect((await api("/api/household", { method: "PUT", token: dad.token, body: { tz: "Asia/Riyadh" } })).status).toBe(200);
    expect((await api("/api/household", { token: nanny.token })).json.tz).toBe("Asia/Riyadh");
    expect((await api("/api/household", { method: "PUT", token: nanny.token, body: { tz: "UTC" } })).status).toBe(403);
    expect((await api("/api/household", { method: "PUT", token: dad.token, body: { tz: "Nope/Zone" } })).status).toBe(400);
  });
});
