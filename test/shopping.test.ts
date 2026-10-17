import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { cleanupMedia, runCleanup } from "../src/lib/cleanup";
import { api, makeHousehold, resetDb, type TestMember } from "./helpers";

beforeEach(resetDb);

const H = 3_600_000;
const D = 24 * H;

async function insertItem(name: string, addedBy: string, addedAt: number, boughtAt?: number) {
  await env.DB.prepare(
    "INSERT INTO items(id, name, qty, note, added_by, added_at, bought_by, bought_at) VALUES (?1, ?2, NULL, NULL, ?3, ?4, ?5, ?6)",
  )
    .bind(crypto.randomUUID(), name, addedBy, addedAt, boughtAt ? addedBy : null, boughtAt ?? null)
    .run();
}

async function upload(m: TestMember, type = "image/png"): Promise<{ status: number; key: string }> {
  const res = await SELF.fetch("http://x/api/media", {
    method: "POST",
    headers: { authorization: `Bearer ${m.token}`, "content-type": type },
    body: new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]),
  });
  const j = (await res.json()) as { key?: string };
  return { status: res.status, key: j.key ?? "" };
}

describe("usual items", () => {
  it("orders by frequency, uses latest casing, excludes open and old", async () => {
    const { dad } = await makeHousehold();
    const t = Date.now();
    await insertItem("milk", dad.id, t - 20 * D, t - 19 * D);
    await insertItem("Milk", dad.id, t - 10 * D, t - 9 * D);
    await insertItem("MILK", dad.id, t - 5 * D, t - 4 * D);
    await insertItem("Bread", dad.id, t - 8 * D, t - 7 * D);
    await insertItem("bread", dad.id, t - 3 * D, t - 2 * D);
    await insertItem("Eggs", dad.id, t - 2 * D, t - 1 * D);
    await insertItem("Butter", dad.id, t - 6 * D, t - 5 * D);
    await insertItem("Butter", dad.id, t - 1 * D); // open -> excluded
    await insertItem("Tea", dad.id, t - 120 * D, t - 119 * D); // too old
    const l = await api("/api/items", { token: dad.token });
    expect(l.json.usual).toEqual(["MILK", "bread", "Eggs"]);
  });

  it("caps at 10", async () => {
    const { dad } = await makeHousehold();
    const t = Date.now();
    for (let i = 0; i < 14; i++) await insertItem("Thing" + i, dad.id, t - (i + 1) * H, t - i * H);
    expect((await api("/api/items", { token: dad.token })).json.usual).toHaveLength(10);
  });
});

describe("shopping status", () => {
  it("requires auth and starts null", async () => {
    expect((await api("/api/shopping", { method: "POST" })).status).toBe(401);
    expect((await api("/api/shopping", { method: "DELETE" })).status).toBe(401);
    const { dad } = await makeHousehold();
    expect((await api("/api/items", { token: dad.token })).json.shopping).toBeNull();
  });

  it("any member sets and clears it", async () => {
    const { dad, nanny } = await makeHousehold();
    const r = await api("/api/shopping", { method: "POST", token: nanny.token, body: {} });
    expect(r.status).toBe(200);
    const l = await api("/api/items", { token: dad.token });
    expect(l.json.shopping).toMatchObject({ member_id: nanny.id, name: "Nanny" });
    expect(l.json.shopping.since).toBeGreaterThan(0);
    const d = await api("/api/shopping", { method: "DELETE", token: dad.token });
    expect(d.status).toBe(200);
    expect((await api("/api/items", { token: dad.token })).json.shopping).toBeNull();
  });

  it("expires after 3 h", async () => {
    const { dad } = await makeHousehold();
    const put = (since: number) =>
      env.DB.prepare("INSERT INTO config(k, v) VALUES('shopping', ?1) ON CONFLICT(k) DO UPDATE SET v = excluded.v")
        .bind(JSON.stringify({ member_id: dad.id, since }))
        .run();
    await put(Date.now() - 2 * H);
    expect((await api("/api/items", { token: dad.token })).json.shopping).toMatchObject({ member_id: dad.id });
    await put(Date.now() - 3 * H - 1000);
    expect((await api("/api/items", { token: dad.token })).json.shopping).toBeNull();
  });
});

describe("item photos", () => {
  it("attaches an image on create and patch, replaces and removes (deleting R2 objects)", async () => {
    const { dad } = await makeHousehold();
    const a = await upload(dad);
    expect(a.status).toBeLessThan(300);
    const c = await api("/api/items", { token: dad.token, body: { name: "Milk", photo_key: a.key } });
    expect(c.status).toBe(200);
    expect(c.json.item.photo_key).toBe(a.key);
    const row = await env.DB.prepare("SELECT attached FROM media WHERE key = ?1").bind(a.key).first<{ attached: number }>();
    expect(row?.attached).toBe(1);
    expect(await env.MEDIA.get(a.key)).not.toBeNull();

    const b = await upload(dad);
    const id = c.json.item.id;
    const p = await api(`/api/items/${id}`, { method: "PATCH", token: dad.token, body: { photo_key: b.key } });
    expect(p.json.item.photo_key).toBe(b.key);
    expect(await env.MEDIA.get(a.key)).toBeNull();
    expect(await env.MEDIA.get(b.key)).not.toBeNull();

    const r = await api(`/api/items/${id}`, { method: "PATCH", token: dad.token, body: { photo_key: null } });
    expect(r.json.item.photo_key).toBeNull();
    expect(await env.MEDIA.get(b.key)).toBeNull();
  });

  it("rejects other members' media, non-images and unknown keys", async () => {
    const { dad, mom } = await makeHousehold();
    const id = (await api("/api/items", { token: dad.token, body: { name: "Rice" } })).json.item.id;
    const patch = (key: unknown) => api(`/api/items/${id}`, { method: "PATCH", token: dad.token, body: { photo_key: key } });
    const moms = await upload(mom);
    const r1 = await patch(moms.key);
    expect(r1.status).toBe(400);
    expect(r1.json.error).toBe("bad_photo");
    // force a non-image media row owned by dad
    await env.DB.prepare("INSERT INTO media(key, owner_id, content_type, size, created_at, attached) VALUES('txt1', ?1, 'audio/webm', 3, ?2, 0)")
      .bind(dad.id, Date.now())
      .run();
    expect((await patch("txt1")).status).toBe(400);
    expect((await patch("does-not-exist")).status).toBe(400);
    expect((await patch(5)).status).toBe(400);
    expect((await api("/api/items", { token: dad.token, body: { name: "x", photo_key: moms.key } })).status).toBe(400);
    const l = await api("/api/items", { token: dad.token });
    expect(l.json.items.find((i: any) => i.id === id).photo_key).toBeNull();
  });

  it("a deleted item's photo is kept while it can be undone, then purged", async () => {
    const { dad } = await makeHousehold();
    const a = await upload(dad);
    const id = (await api("/api/items", { token: dad.token, body: { name: "Milk", photo_key: a.key } })).json.item.id;
    expect((await api(`/api/items/${id}`, { method: "DELETE", token: dad.token })).status).toBe(200);
    await cleanupMedia(env);
    expect(await env.MEDIA.get(a.key)).not.toBeNull(); // still in the trash
    await env.DB.prepare("UPDATE trash SET deleted_at = ?1").bind(Date.now() - 25 * 3_600_000).run();
    await runCleanup(env);
    await cleanupMedia(env);
    expect(await env.MEDIA.get(a.key)).toBeNull();
    expect(await env.DB.prepare("SELECT key FROM media WHERE key = ?1").bind(a.key).first()).toBeNull();
  });
});
