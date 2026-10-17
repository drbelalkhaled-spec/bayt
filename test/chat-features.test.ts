import { SELF, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupMedia, runCleanup } from "../src/lib/cleanup";
import { api, makeHousehold, resetDb, type TestMember } from "./helpers";

const EP = "https://push.example.test/send/chat";
const realFetch = globalThis.fetch;

let dad: TestMember, mom: TestMember, nanny: TestMember;
beforeEach(async () => {
  await resetDb();
  ({ dad, mom, nanny } = await makeHousehold());
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://push.example.test/")) return new Response(null, { status: 201 });
    return realFetch(input, init);
  });
});
afterEach(() => vi.restoreAllMocks());

const upload = async (token: string, type: string, bytes = [1, 2, 3]): Promise<string> => {
  const r = await SELF.fetch("http://x/api/media", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": type },
    body: new Uint8Array(bytes),
  });
  return ((await r.json()) as any).key;
};
const post = (token: string, body: unknown) => api("/api/messages", { token, body });
const waitFor = async (cond: () => boolean | Promise<boolean>, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("timeout");
};

describe("photo messages", () => {
  it("accepts a photo with caption and meta, and lists it", async () => {
    const key = await upload(dad.token, "image/webp");
    const r = await post(dad.token, { kind: "photo", media_key: key, body: " look ", media_meta: { w: 800, h: 600 } });
    expect(r.status).toBe(200);
    expect(r.json.message).toMatchObject({ kind: "photo", media_key: key, body: "look", media_meta: { w: 800, h: 600 } });
    const l = await api("/api/messages", { token: mom.token });
    expect(l.json.messages[0]).toMatchObject({ kind: "photo", media_key: key, media_meta: { w: 800, h: 600 } });
    const row = await env.DB.prepare("SELECT attached FROM media WHERE key = ?1").bind(key).first<{ attached: number }>();
    expect(row!.attached).toBe(1);
  });

  it("meta is optional for photos but validated strictly", async () => {
    const k1 = await upload(dad.token, "image/png");
    const ok = await post(dad.token, { kind: "photo", media_key: k1 });
    expect(ok.status).toBe(200);
    expect(ok.json.message.media_meta).toBeNull();
    const bads = [{ w: "1" }, { w: 1.5, h: 2 }, { w: 0 }, { w: 1, evil: 2 }, { w: 99999 }, "str", [1]];
    for (const meta of bads) {
      const k = await upload(dad.token, "image/png");
      expect((await post(dad.token, { kind: "photo", media_key: k, media_meta: meta })).status).toBe(400);
    }
  });

  it("rejects wrong content type, missing key, foreign key and reused key", async () => {
    const audio = await upload(dad.token, "audio/webm");
    expect((await post(dad.token, { kind: "photo", media_key: audio })).status).toBe(400);
    expect((await post(dad.token, { kind: "photo" })).status).toBe(400);
    expect((await post(dad.token, { kind: "photo", media_key: crypto.randomUUID() })).status).toBe(400);
    const theirs = await upload(mom.token, "image/png");
    expect((await post(dad.token, { kind: "photo", media_key: theirs })).status).toBe(400);
    const mine = await upload(dad.token, "image/png");
    expect((await post(dad.token, { kind: "photo", media_key: mine })).status).toBe(200);
    expect((await post(dad.token, { kind: "photo", media_key: mine })).status).toBe(400);
    expect((await post(dad.token, { kind: "video", media_key: mine })).status).toBe(400);
  });

  it("caps captions at 2000", async () => {
    const key = await upload(dad.token, "image/png");
    expect((await post(dad.token, { kind: "photo", media_key: key, body: "a".repeat(2001) })).status).toBe(400);
  });
});

describe("voice messages", () => {
  it("accepts a voice note", async () => {
    const key = await upload(nanny.token, "audio/webm");
    const r = await post(nanny.token, { kind: "voice", media_key: key, media_meta: { durationMs: 4200 } });
    expect(r.status).toBe(200);
    expect(r.json.message).toMatchObject({ kind: "voice", body: "", media_meta: { durationMs: 4200 } });
  });

  it("requires durationMs in range, no body, audio type", async () => {
    const mk = () => upload(dad.token, "audio/mp4");
    expect((await post(dad.token, { kind: "voice", media_key: await mk() })).status).toBe(400);
    expect((await post(dad.token, { kind: "voice", media_key: await mk(), media_meta: {} })).status).toBe(400);
    expect((await post(dad.token, { kind: "voice", media_key: await mk(), media_meta: { durationMs: 0 } })).status).toBe(400);
    expect((await post(dad.token, { kind: "voice", media_key: await mk(), media_meta: { durationMs: 120001 } })).status).toBe(400);
    expect((await post(dad.token, { kind: "voice", media_key: await mk(), media_meta: { durationMs: 5, w: 1 } })).status).toBe(400);
    expect((await post(dad.token, { kind: "voice", media_key: await mk(), media_meta: { durationMs: 1000 }, body: "hi" })).status).toBe(400);
    const img = await upload(dad.token, "image/png");
    expect((await post(dad.token, { kind: "voice", media_key: img, media_meta: { durationMs: 1000 } })).status).toBe(400);
    expect((await post(dad.token, { kind: "voice", media_key: await mk(), media_meta: { durationMs: 120000 } })).status).toBe(200);
  });

  it("text messages still require a body and return kind text", async () => {
    expect((await post(dad.token, { kind: "text" })).status).toBe(400);
    const r = await post(dad.token, { body: "yo" });
    expect(r.json.message).toMatchObject({ kind: "text", media_key: null, media_meta: null });
  });
});

describe("delete removes media", () => {
  it("keeps the photo while the delete can be undone, then removes R2 object and media row", async () => {
    const key = await upload(dad.token, "image/png");
    const m = (await post(dad.token, { kind: "photo", media_key: key })).json.message;
    expect(await env.MEDIA.get(key)).not.toBeNull();
    expect((await api(`/api/messages/${m.id}`, { method: "DELETE", token: dad.token })).status).toBe(200);
    await cleanupMedia(env);
    expect(await env.MEDIA.get(key)).not.toBeNull();
    await env.DB.prepare("UPDATE trash SET deleted_at = ?1").bind(Date.now() - 25 * 3_600_000).run();
    await runCleanup(env);
    await cleanupMedia(env);
    expect(await env.MEDIA.get(key)).toBeNull();
    expect(await env.DB.prepare("SELECT key FROM media WHERE key = ?1").bind(key).first()).toBeNull();
  });
});

describe("push text", () => {
  it("uses photo / voice wording in the stored notice", async () => {
    await api("/api/push/subscribe", { token: mom.token, body: { subscription: { endpoint: EP, keys: { p256dh: "a", auth: "b" } } } });
    const k = await upload(dad.token, "image/png");
    await post(dad.token, { kind: "photo", media_key: k });
    await waitFor(async () => (await api("/api/push/notice", { token: mom.token })).json.notice.text === "Dad sent a photo");
    const v = await upload(dad.token, "audio/webm");
    await post(dad.token, { kind: "voice", media_key: v, media_meta: { durationMs: 900 } });
    await waitFor(async () => (await api("/api/push/notice", { token: mom.token })).json.notice.text === "Dad sent a voice note");
  });
});

describe("read receipts", () => {
  it("is monotonic, capped at now, and reads exclude me", async () => {
    const t = Date.now();
    expect((await api("/api/messages/read", { token: mom.token, body: { at: t - 1000 } })).json.changed).toBe(true);
    expect((await api("/api/messages/read", { token: mom.token, body: { at: t - 5000 } })).json.changed).toBe(false);
    expect((await api("/api/messages/read", { token: mom.token, body: { at: t - 1000 } })).json.changed).toBe(false);
    const row = () => env.DB.prepare("SELECT chat_read_at FROM members WHERE id = ?1").bind(mom.id).first<{ chat_read_at: number }>();
    expect((await row())!.chat_read_at).toBe(t - 1000);
    await api("/api/messages/read", { token: mom.token, body: { at: t + 10 * 86_400_000 } });
    expect((await row())!.chat_read_at).toBeLessThanOrEqual(Date.now());
    expect((await row())!.chat_read_at).toBeGreaterThan(t - 1000);

    const l = await api("/api/messages", { token: dad.token });
    expect(l.json.reads.map((r: any) => r.member_id)).toEqual([mom.id]);
    expect(l.json.reads[0]).toMatchObject({ name: "Mom" });
    expect(typeof l.json.reads[0].read_at).toBe("number");
    const own = await api("/api/messages", { token: mom.token });
    expect(own.json.reads.some((r: any) => r.member_id === mom.id)).toBe(false);
    const after = await api("/api/messages?after=0:", { token: dad.token });
    expect(after.status).toBe(400);
    const after2 = await api("/api/messages?after=0", { token: dad.token });
    expect(after2.json.reads).toHaveLength(1);
  });

  it("validates at", async () => {
    for (const at of ["x", -1, 1.5, undefined, null]) {
      expect((await api("/api/messages/read", { token: dad.token, body: { at } })).status).toBe(400);
    }
    expect((await api("/api/messages/read", { body: { at: 1 } })).status).toBe(401);
  });

  it("omits removed members and members who never read", async () => {
    await api("/api/messages/read", { token: nanny.token, body: { at: Date.now() - 10 } });
    expect((await api("/api/messages", { token: dad.token })).json.reads.map((r: any) => r.name)).toEqual(["Nanny"]);
    await api(`/api/members/${nanny.id}`, { method: "DELETE", token: dad.token });
    expect((await api("/api/messages", { token: dad.token })).json.reads).toEqual([]);
  });
});

describe("pins", () => {
  it("pins, lists newest first regardless of pagination, and unpins", async () => {
    const ids: string[] = [];
    for (const b of ["one", "two", "three"]) {
      ids.push((await post(dad.token, { body: b })).json.message.id);
      await new Promise((r) => setTimeout(r, 3));
    }
    expect((await api(`/api/messages/${ids[0]}`, { method: "PATCH", token: nanny.token, body: { pinned: true } })).status).toBe(200);
    await new Promise((r) => setTimeout(r, 3));
    await api(`/api/messages/${ids[1]}`, { method: "PATCH", token: mom.token, body: { pinned: true } });
    const l = await api("/api/messages?limit=1", { token: dad.token });
    expect(l.json.messages).toHaveLength(1);
    expect(l.json.pinned.map((p: any) => [p.body, p.pinned_by_name])).toEqual([
      ["two", "Mom"],
      ["one", "Nanny"],
    ]);
    expect(l.json.pinned[0].pinned_at).toBeGreaterThan(0);
    const all = await api("/api/messages", { token: dad.token });
    expect(all.json.messages.find((m: any) => m.id === ids[0]).pinned_at).toBeGreaterThan(0);
    expect(all.json.messages.find((m: any) => m.id === ids[2]).pinned_at).toBeNull();

    await api(`/api/messages/${ids[1]}`, { method: "PATCH", token: dad.token, body: { pinned: false } });
    expect((await api("/api/messages", { token: dad.token })).json.pinned.map((p: any) => p.body)).toEqual(["one"]);
  });

  it("validates input and caps at 20", async () => {
    const m = (await post(dad.token, { body: "x" })).json.message;
    expect((await api(`/api/messages/${m.id}`, { method: "PATCH", token: dad.token, body: { pinned: "yes" } })).status).toBe(400);
    expect((await api("/api/messages/nope", { method: "PATCH", token: dad.token, body: { pinned: true } })).status).toBe(404);
    expect((await api(`/api/messages/${m.id}`, { method: "PATCH", body: { pinned: true } })).status).toBe(401);
    const t = Date.now() - 100_000;
    for (let i = 0; i < 22; i++) {
      await env.DB.prepare("INSERT INTO messages(id, author_id, body, created_at, pinned_at, pinned_by) VALUES (?1,?2,?3,?4,?5,?2)")
        .bind("p" + i, dad.id, "p" + i, t + i, t + i)
        .run();
    }
    const l = await api("/api/messages", { token: dad.token });
    expect(l.json.pinned).toHaveLength(20);
    expect(l.json.pinned[0].body).toBe("p21");
  });
});
