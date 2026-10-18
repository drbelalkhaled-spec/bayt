import { SELF, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseRange } from "../src/routes/media";
import { api, makeHousehold, resetDb, type TestMember } from "./helpers";

const EP = "https://push.example.test/send/chat";
const realFetch = globalThis.fetch;
const MB = 1024 * 1024;

let dad: TestMember, mom: TestMember;
beforeEach(async () => {
  await resetDb();
  ({ dad, mom } = await makeHousehold());
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://push.example.test/")) return new Response(null, { status: 201 });
    return realFetch(input, init);
  });
});
afterEach(() => vi.restoreAllMocks());

const rawUpload = (token: string, type: string, body: Uint8Array<ArrayBuffer>) =>
  SELF.fetch("http://x/api/media", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": type }, body });
const upload = async (token: string, type: string, bytes: number[] | Uint8Array<ArrayBuffer> = [1, 2, 3]): Promise<string> =>
  ((await (await rawUpload(token, type, new Uint8Array(bytes))).json()) as any).key;
const post = (token: string, body: unknown) => api("/api/messages", { token, body });
const waitFor = async (cond: () => boolean | Promise<boolean>, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("timeout");
};
const get = (token: string, key: string, headers: Record<string, string> = {}) =>
  SELF.fetch("http://x/api/media/" + key, { headers: { authorization: `Bearer ${token}`, ...headers } });

describe("video upload", () => {
  it("accepts mp4, webm and quicktime and records the row", async () => {
    for (const type of ["video/mp4", "video/webm", "video/quicktime"]) {
      const r = await rawUpload(dad.token, type, new Uint8Array([1, 2, 3, 4, 5]));
      expect(r.status).toBe(200);
      const j: any = await r.json();
      expect(j).toMatchObject({ content_type: type, size: 5 });
      const row = await env.DB.prepare("SELECT content_type, size, attached, owner_id FROM media WHERE key = ?1").bind(j.key).first<any>();
      expect(row).toMatchObject({ content_type: type, size: 5, attached: 0, owner_id: dad.id });
      const obj = await env.MEDIA.get(j.key);
      expect([...new Uint8Array(await obj!.arrayBuffer())]).toEqual([1, 2, 3, 4, 5]);
    }
  });

  it("keeps the 8 MB limit for images but allows bigger videos up to 60 MB", async () => {
    expect((await rawUpload(dad.token, "image/png", new Uint8Array(8 * MB + 1))).status).toBe(413);
    const ok = await rawUpload(dad.token, "video/mp4", new Uint8Array(9 * MB));
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as any).size).toBe(9 * MB);
  });

  it("refuses videos over 60 MB with too_large and stores nothing", async () => {
    const r = await rawUpload(dad.token, "video/mp4", new Uint8Array(60 * MB + 1));
    expect(r.status).toBe(413);
    expect(((await r.json()) as any).error).toBe("too_large");
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM media").first<any>()).n).toBe(0);
  });

  it("refuses empty videos, other video types and a missing Content-Length", async () => {
    expect((await rawUpload(dad.token, "video/mp4", new Uint8Array(0))).status).toBe(400);
    expect((await rawUpload(dad.token, "video/x-msvideo", new Uint8Array([1]))).status).toBe(400);
    expect((await rawUpload(dad.token, "text/plain", new Uint8Array([1]))).status).toBe(400);
    // A streamed body has no Content-Length, so the server cannot hand R2 a length.
    const stream = new ReadableStream({
      start(ctl) {
        ctl.enqueue(new Uint8Array([1, 2, 3]));
        ctl.close();
      },
    });
    const r = await SELF.fetch("http://x/api/media", {
      method: "POST",
      headers: { authorization: `Bearer ${dad.token}`, "content-type": "video/mp4" },
      body: stream,
      duplex: "half",
    } as RequestInit);
    expect(r.status).toBe(411);
  });

  it("requires auth", async () => {
    expect((await SELF.fetch("http://x/api/media", { method: "POST", headers: { "content-type": "video/mp4" }, body: new Uint8Array([1]) })).status).toBe(401);
  });
});

describe("video messages", () => {
  const mk = () => upload(dad.token, "video/mp4");

  it("accepts a video with caption and meta, and lists it", async () => {
    const key = await mk();
    const r = await post(dad.token, { kind: "video", media_key: key, body: " look ", media_meta: { durationMs: 12_500, w: 1080, h: 1920 } });
    expect(r.status).toBe(200);
    expect(r.json.message).toMatchObject({ kind: "video", media_key: key, body: "look", media_meta: { durationMs: 12_500, w: 1080, h: 1920 } });
    const l = await api("/api/messages", { token: mom.token });
    expect(l.json.messages[0]).toMatchObject({ kind: "video", media_key: key });
    expect((await env.DB.prepare("SELECT attached FROM media WHERE key = ?1").bind(key).first<any>()).attached).toBe(1);
  });

  it("requires durationMs between 1 and 30000, optional w/h in range, nothing else", async () => {
    const bad = [undefined, {}, { w: 10, h: 10 }, { durationMs: 0 }, { durationMs: 30_001 }, { durationMs: 1.5 }, { durationMs: "5" }, { durationMs: 5, w: 0 },
      { durationMs: 5, h: 20_001 }, { durationMs: 5, w: 1.5 }, { durationMs: 5, evil: 1 }, "str", [1]];
    for (const media_meta of bad) {
      expect((await post(dad.token, { kind: "video", media_key: await mk(), media_meta })).status).toBe(400);
    }
    expect((await post(dad.token, { kind: "video", media_key: await mk(), media_meta: { durationMs: 1 } })).status).toBe(200);
    const edge = await post(dad.token, { kind: "video", media_key: await mk(), media_meta: { durationMs: 30_000, w: 20_000, h: 1 } });
    expect(edge.status).toBe(200);
  });

  it("needs a video upload of your own that is not yet attached", async () => {
    const meta = { durationMs: 5000 };
    expect((await post(dad.token, { kind: "video", media_meta: meta })).status).toBe(400);
    expect((await post(dad.token, { kind: "video", media_key: crypto.randomUUID(), media_meta: meta })).status).toBe(400);
    const img = await upload(dad.token, "image/png");
    expect((await post(dad.token, { kind: "video", media_key: img, media_meta: meta })).status).toBe(400);
    const audio = await upload(dad.token, "audio/webm");
    expect((await post(dad.token, { kind: "video", media_key: audio, media_meta: meta })).status).toBe(400);
    const theirs = await upload(mom.token, "video/mp4");
    expect((await post(dad.token, { kind: "video", media_key: theirs, media_meta: meta })).status).toBe(400);
    const mine = await mk();
    expect((await post(dad.token, { kind: "video", media_key: mine, media_meta: meta })).status).toBe(200);
    expect((await post(dad.token, { kind: "video", media_key: mine, media_meta: meta })).status).toBe(400);
    // A video cannot be sent as a photo or voice note either.
    const other = await mk();
    expect((await post(dad.token, { kind: "photo", media_key: other })).status).toBe(400);
    expect((await post(dad.token, { kind: "voice", media_key: other, media_meta: meta })).status).toBe(400);
  });

  it("caps captions at 2000", async () => {
    expect((await post(dad.token, { kind: "video", media_key: await mk(), media_meta: { durationMs: 5 }, body: "a".repeat(2001) })).status).toBe(400);
  });

  it("goes to the trash with a video label", async () => {
    const m = (await post(dad.token, { kind: "video", media_key: await mk(), media_meta: { durationMs: 5 } })).json.message;
    const d = await api(`/api/messages/${m.id}`, { method: "DELETE", token: dad.token });
    expect(d.status).toBe(200);
    expect((await env.DB.prepare("SELECT label FROM trash WHERE id = ?1").bind(d.json.trash_id).first<any>()).label).toBe("🎥 Video");
  });
});

describe("Range requests", () => {
  const bytes = Uint8Array.from({ length: 100 }, (_, i) => i);
  let key: string;
  beforeEach(async () => {
    key = await upload(dad.token, "video/mp4", bytes);
  });
  const body = async (r: Response) => [...new Uint8Array(await r.arrayBuffer())];

  it("serves 200 with Accept-Ranges when there is no Range header", async () => {
    const r = await get(mom.token, key);
    expect(r.status).toBe(200);
    expect(r.headers.get("accept-ranges")).toBe("bytes");
    expect(r.headers.get("content-length")).toBe("100");
    expect(r.headers.get("content-type")).toBe("video/mp4");
    expect(await body(r)).toEqual([...bytes]);
  });

  it("answers bytes=start-end with 206 and Content-Range", async () => {
    const r = await get(mom.token, key, { range: "bytes=10-19" });
    expect(r.status).toBe(206);
    expect(r.headers.get("content-range")).toBe("bytes 10-19/100");
    expect(r.headers.get("content-length")).toBe("10");
    expect(r.headers.get("accept-ranges")).toBe("bytes");
    expect(r.headers.get("content-type")).toBe("video/mp4");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await body(r)).toEqual([...bytes.slice(10, 20)]);
  });

  it("handles open-ended, suffix, clamped and ?t= requests", async () => {
    const open = await get(mom.token, key, { range: "bytes=90-" });
    expect(open.status).toBe(206);
    expect(open.headers.get("content-range")).toBe("bytes 90-99/100");
    expect(await body(open)).toEqual([...bytes.slice(90)]);

    const suffix = await get(mom.token, key, { range: "bytes=-5" });
    expect(suffix.status).toBe(206);
    expect(suffix.headers.get("content-range")).toBe("bytes 95-99/100");
    expect(await body(suffix)).toEqual([...bytes.slice(95)]);

    const big = await get(mom.token, key, { range: "bytes=-500" });
    expect(big.headers.get("content-range")).toBe("bytes 0-99/100");

    const clamped = await get(mom.token, key, { range: "bytes=0-9999" });
    expect(clamped.status).toBe(206);
    expect(clamped.headers.get("content-range")).toBe("bytes 0-99/100");

    const viaQuery = await SELF.fetch(`http://x/api/media/${key}?t=${mom.token}`, { headers: { range: "bytes=0-0" } });
    expect(viaQuery.status).toBe(206);
    expect(await body(viaQuery)).toEqual([0]);
  });

  it("answers 416 with the total size for unsatisfiable or malformed ranges", async () => {
    for (const range of ["bytes=100-", "bytes=200-300", "bytes=20-10", "bytes=-0", "bytes=-", "bytes=a-b", "items=0-5", "bytes=0-5,10-20"]) {
      const r = await get(mom.token, key, { range });
      expect(r.status, range).toBe(416);
      expect(r.headers.get("content-range")).toBe("bytes */100");
    }
  });

  it("still needs auth and keeps the trash privacy check", async () => {
    expect((await SELF.fetch("http://x/api/media/" + key, { headers: { range: "bytes=0-1" } })).status).toBe(401);
    expect((await get(mom.token, crypto.randomUUID(), { range: "bytes=0-1" })).status).toBe(404);
    const m = (await post(dad.token, { kind: "video", media_key: key, media_meta: { durationMs: 5000 } })).json.message;
    await api(`/api/messages/${m.id}`, { method: "DELETE", token: dad.token });
    expect((await get(mom.token, key, { range: "bytes=0-1" })).status).toBe(404);
    expect((await get(mom.token, key)).status).toBe(404);
    expect((await get(dad.token, key, { range: "bytes=0-1" })).status).toBe(206);
  });

  it("parseRange edge cases", () => {
    expect(parseRange("bytes=0-0", 1)).toEqual({ start: 0, end: 0 });
    expect(parseRange("bytes=5-", 6)).toEqual({ start: 5, end: 5 });
    expect(parseRange("bytes=6-", 6)).toBeNull();
    expect(parseRange("bytes=-3", 10)).toEqual({ start: 7, end: 9 });
    expect(parseRange(" bytes=1-2 ", 10)).toEqual({ start: 1, end: 2 });
  });
});

describe("location messages", () => {
  it("accepts a position, rounds to 6 decimals and lists it", async () => {
    const r = await post(dad.token, { kind: "location", media_meta: { lat: 24.7135517123, lng: 46.6752957987, acc: 20 } });
    expect(r.status).toBe(200);
    expect(r.json.message).toMatchObject({ kind: "location", body: "", media_key: null, media_meta: { lat: 24.713552, lng: 46.675296, acc: 20 } });
    const l = await api("/api/messages", { token: mom.token });
    expect(l.json.messages[0]).toMatchObject({ kind: "location", media_meta: { lat: 24.713552, lng: 46.675296, acc: 20 } });
  });

  it("makes accuracy optional and allows the extremes", async () => {
    for (const media_meta of [{ lat: 0, lng: 0 }, { lat: -90, lng: -180, acc: 0 }, { lat: 90, lng: 180, acc: 100_000 }, { lat: -0.0000001, lng: 1, acc: null }]) {
      expect((await post(dad.token, { kind: "location", media_meta })).status).toBe(200);
    }
    const r = await post(dad.token, { kind: "location", media_meta: { lat: -0.0000001, lng: 1 } });
    expect(r.json.message.media_meta).toEqual({ lat: 0, lng: 1 });
  });

  it("rejects out-of-range, non-numeric, extra and missing values", async () => {
    const bad = [undefined, null, {}, "x", [1, 2], { lat: 1 }, { lng: 1 }, { lat: 90.1, lng: 0 }, { lat: -90.1, lng: 0 }, { lat: 0, lng: 180.1 }, { lat: 0, lng: -180.1 },
      { lat: "1", lng: 2 }, { lat: null, lng: 2 }, { lat: 1, lng: 2, acc: -1 }, { lat: 1, lng: 2, acc: 100_001 }, { lat: 1, lng: 2, acc: 1.5 }, { lat: 1, lng: 2, acc: "5" },
      { lat: 1, lng: 2, evil: 3 }, { lat: 1e999, lng: 2 }];
    for (const media_meta of bad) {
      expect((await post(dad.token, { kind: "location", media_meta })).status, JSON.stringify(media_meta)).toBe(400);
    }
    expect((await api("/api/messages", { token: dad.token })).json.messages).toHaveLength(0);
  });

  it("allows no body and no media", async () => {
    const media_meta = { lat: 1, lng: 2 };
    expect((await post(dad.token, { kind: "location", media_meta, body: "here" })).status).toBe(400);
    const key = await upload(dad.token, "image/png");
    expect((await post(dad.token, { kind: "location", media_meta, media_key: key })).status).toBe(400);
    expect((await post(dad.token, { kind: "location", media_meta, body: "  " })).status).toBe(200);
    expect((await env.DB.prepare("SELECT attached FROM media WHERE key = ?1").bind(key).first<any>()).attached).toBe(0);
  });

  it("is idempotent for a repeated client id and goes to the trash with a location label", async () => {
    const id = crypto.randomUUID();
    const a = await post(dad.token, { id, kind: "location", media_meta: { lat: 1, lng: 2 } });
    const b = await post(dad.token, { id, kind: "location", media_meta: { lat: 1, lng: 2 } });
    expect(b.json.message.id).toBe(a.json.message.id);
    const d = await api(`/api/messages/${id}`, { method: "DELETE", token: dad.token });
    expect((await env.DB.prepare("SELECT label FROM trash WHERE id = ?1").bind(d.json.trash_id).first<any>()).label).toBe("📍 Location");
  });
});

describe("push text", () => {
  it("uses video / location wording in the stored notice", async () => {
    await api("/api/push/subscribe", { token: mom.token, body: { subscription: { endpoint: EP, keys: { p256dh: "a", auth: "b" } } } });
    const k = await upload(dad.token, "video/mp4");
    expect((await post(dad.token, { kind: "video", media_key: k, media_meta: { durationMs: 8000 } })).status).toBe(200);
    await waitFor(async () => (await api("/api/push/notice", { token: mom.token })).json.notice.text === "Dad sent a video");
    expect((await post(dad.token, { kind: "location", media_meta: { lat: 24.7, lng: 46.7 } })).status).toBe(200);
    await waitFor(async () => (await api("/api/push/notice", { token: mom.token })).json.notice.text === "Dad shared a location");
  });

  it("names the video / location in a reaction notice", async () => {
    await api("/api/push/subscribe", { token: dad.token, body: { subscription: { endpoint: EP, keys: { p256dh: "a", auth: "b" } } } });
    const v = (await post(dad.token, { kind: "video", media_key: await upload(dad.token, "video/webm"), media_meta: { durationMs: 8000 } })).json.message;
    await api(`/api/messages/${v.id}/reaction`, { method: "PUT", token: mom.token, body: { emoji: "👍" } });
    await waitFor(async () => (await api("/api/push/notice", { token: dad.token })).json.notice.text === "Mom reacted 👍 to your video");
    const l = (await post(dad.token, { kind: "location", media_meta: { lat: 1, lng: 2 } })).json.message;
    await api(`/api/messages/${l.id}/reaction`, { method: "PUT", token: mom.token, body: { emoji: "❤️" } });
    await waitFor(async () => (await api("/api/push/notice", { token: dad.token })).json.notice.text === "Mom reacted ❤️ to your location");
  });
});
