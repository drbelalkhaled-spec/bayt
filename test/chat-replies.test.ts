import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCleanup } from "../src/lib/cleanup";
import { api, makeHousehold, resetDb, type TestMember } from "./helpers";

const EP = "https://push.example.test/send/replies";
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

const waitFor = async (cond: () => boolean | Promise<boolean>, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("timeout");
};
const post = (m: TestMember, body: Record<string, unknown>) => api("/api/messages", { token: m.token, body });
const react = (m: TestMember, id: string, emoji: unknown) =>
  api(`/api/messages/${id}/reaction`, { method: "PUT", token: m.token, body: { emoji } });
const search = (m: TestMember, q: string) => api("/api/messages/search?q=" + encodeURIComponent(q), { token: m.token });

describe("replies", () => {
  it("quotes the original in the reply and in the list", async () => {
    const a = (await post(nanny, { body: "Shall I take Omar to the park?" })).json.message;
    expect(a.reply).toBeNull();
    const r = await post(dad, { body: "Yes, until 5", reply_to: a.id });
    expect(r.status).toBe(200);
    expect(r.json.message.reply).toEqual({ id: a.id, author_id: nanny.id, author_name: "Nanny", body: "Shall I take Omar to the park?", kind: "text" });
    const page = await api("/api/messages", { token: mom.token });
    expect(page.json.messages.find((m: any) => m.id === r.json.message.id).reply.author_name).toBe("Nanny");
  });

  it("shows a deleted original as deleted and rejects bad ids", async () => {
    const a = (await post(nanny, { body: "oops" })).json.message;
    const r = (await post(dad, { body: "?", reply_to: a.id })).json.message;
    await api(`/api/messages/${a.id}`, { method: "DELETE", token: nanny.token });
    const page = await api("/api/messages", { token: dad.token });
    expect(page.json.messages.find((m: any) => m.id === r.id).reply).toEqual({ id: a.id, deleted: true });
    expect((await post(dad, { body: "x", reply_to: 5 })).status).toBe(400);
  });
});

describe("reactions", () => {
  it("one per person, replaceable, removable, listed with the page, and the author is told", async () => {
    await api("/api/push/subscribe", { token: nanny.token, body: { subscription: { endpoint: EP, keys: { p256dh: "a", auth: "b" } } } });
    const a = (await post(nanny, { body: "Lunch is ready" })).json.message;
    expect((await react(dad, a.id, "👍")).status).toBe(200);
    await waitFor(async () => (await api("/api/push/notice", { token: nanny.token })).json.notice?.text === 'Dad reacted 👍 to "Lunch is ready"');
    await react(dad, a.id, "❤️");
    await react(mom, a.id, "😂");
    let page = await api("/api/messages", { token: nanny.token });
    expect(page.json.reactions).toEqual([
      { message_id: a.id, member_id: dad.id, emoji: "❤️" },
      { message_id: a.id, member_id: mom.id, emoji: "😂" },
    ]);
    await react(dad, a.id, null);
    page = await api("/api/messages", { token: nanny.token });
    expect(page.json.reactions.map((r: any) => r.member_id)).toEqual([mom.id]);
  });

  it("rejects unknown emoji and missing messages; cleared with the message", async () => {
    const a = (await post(nanny, { body: "hi" })).json.message;
    expect((await react(dad, a.id, "🐸")).status).toBe(400);
    expect((await react(dad, a.id, 1)).status).toBe(400);
    expect((await react(dad, "nope", "👍")).status).toBe(404);
    await react(dad, a.id, "👍");
    await api(`/api/messages/${a.id}`, { method: "DELETE", token: nanny.token });
    const b = (await post(nanny, { body: "old" })).json.message;
    await react(mom, b.id, "🙏");
    await env.DB.prepare("UPDATE messages SET created_at = ?1 WHERE id = ?2").bind(Date.now() - 100 * 86_400_000, b.id).run();
    await runCleanup(env);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM message_reactions").first<{ n: number }>();
    expect(n!.n).toBe(0);
  });
});

describe("search", () => {
  it("finds text case-insensitively, newest first, treating % and _ literally", async () => {
    await post(nanny, { body: "The door code is 4512" });
    await post(dad, { body: "New DOOR code: 7788" });
    await post(mom, { body: "100% done_now" });
    await post(mom, { body: "unrelated" });
    const r = await search(nanny, "door code");
    expect(r.status).toBe(200);
    expect(r.json.messages.map((m: any) => m.body)).toEqual(["New DOOR code: 7788", "The door code is 4512"]);
    expect((await search(nanny, "0% d")).json.messages.map((m: any) => m.body)).toEqual(["100% done_now"]);
    expect((await search(nanny, "e_n")).json.messages).toHaveLength(1);
    expect((await search(nanny, "%")).status).toBe(400);
    expect((await search(nanny, "a".repeat(101))).status).toBe(400);
    expect((await api("/api/messages/search?q=door")).status).toBe(401);
  });
});
