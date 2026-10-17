import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCleanup } from "../src/lib/cleanup";
import { api, makeHousehold, resetDb, type TestMember } from "./helpers";

const EP = "https://push.example.test/send/trio";
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
const subscribe = (m: TestMember) =>
  api("/api/push/subscribe", { token: m.token, body: { subscription: { endpoint: EP, keys: { p256dh: "a", auth: "b" } } } });
const notice = async (m: TestMember) => (await api("/api/push/notice", { token: m.token })).json.notice;
const addItem = (m: TestMember, body: Record<string, unknown>) => api("/api/items", { token: m.token, body });
const patchItem = (m: TestMember, id: string, body: unknown) => api(`/api/items/${id}`, { method: "PATCH", token: m.token, body });
const post = (m: TestMember, body: Record<string, unknown>) => api("/api/messages", { token: m.token, body });
const editMsg = (m: TestMember, id: string, body: unknown) => api(`/api/messages/${id}`, { method: "PATCH", token: m.token, body: { body } });
const trashList = async (m: TestMember) => (await api("/api/trash", { token: m.token })).json.trash;
const restore = (m: TestMember, id: string) => api(`/api/trash/${id}/restore`, { token: m.token, body: {} });

describe("needed today", () => {
  it("flags on add, tells everyone else when nobody is shopping, and clears when bought", async () => {
    await subscribe(dad);
    const r = await addItem(nanny, { name: "Diapers", urgent: true });
    expect(r.json.item.urgent_at).toBeGreaterThan(0);
    await waitFor(async () => (await notice(dad))?.text === "Nanny: Diapers is needed today");
    expect((await notice(dad)).kind).toBe("item_urgent");
    const b = await patchItem(dad, r.json.item.id, { bought: true });
    expect(b.json.item.urgent_at).toBeNull();
    expect((await addItem(nanny, { name: "x", urgent: "yes" })).status).toBe(400);
  });

  it("goes only to whoever is out shopping, and can be turned on and off later", async () => {
    await subscribe(dad);
    await subscribe(mom);
    await api("/api/shopping", { token: mom.token, body: {} });
    const it = (await addItem(nanny, { name: "Bread" })).json.item;
    expect(it.urgent_at).toBeNull();
    const on = await patchItem(nanny, it.id, { urgent: true });
    expect(on.json.item.urgent_at).toBeGreaterThan(0);
    await waitFor(async () => (await notice(mom))?.text === "Nanny: Bread is needed today");
    expect((await notice(dad))?.kind).not.toBe("item_urgent");
    expect((await patchItem(nanny, it.id, { urgent: false })).json.item.urgent_at).toBeNull();
  });
});

describe("editing messages", () => {
  it("author edits their own text within 15 minutes; others see it in edits", async () => {
    const m = (await post(nanny, { body: "Pick up at 4" })).json.message;
    const e = await editMsg(nanny, m.id, "  Pick up at 5  ");
    expect(e.status).toBe(200);
    expect(e.json.message).toMatchObject({ body: "Pick up at 5" });
    expect(e.json.message.edited_at).toBeGreaterThan(0);
    const page = await api("/api/messages", { token: dad.token });
    expect(page.json.messages.find((x: any) => x.id === m.id).body).toBe("Pick up at 5");
    expect(page.json.edits).toEqual([{ id: m.id, body: "Pick up at 5", edited_at: e.json.message.edited_at }]);
    const hits = await api("/api/messages/search?q=" + encodeURIComponent("at 5"), { token: dad.token });
    expect(hits.json.messages.map((x: any) => x.id)).toEqual([m.id]);
  });

  it("refuses others' messages, empty text, photos and late edits", async () => {
    const m = (await post(nanny, { body: "hello" })).json.message;
    expect((await editMsg(dad, m.id, "hacked")).status).toBe(403);
    expect((await editMsg(nanny, m.id, "   ")).status).toBe(400);
    expect((await editMsg(nanny, "nope", "x")).status).toBe(404);
    await env.DB.prepare("UPDATE messages SET created_at = ?1 WHERE id = ?2").bind(Date.now() - 16 * 60_000, m.id).run();
    const late = await editMsg(nanny, m.id, "too late");
    expect(late.status).toBe(403);
    expect(late.json.error).toBe("too_late");
    // Pinning still works through the same endpoint.
    expect((await api(`/api/messages/${m.id}`, { method: "PATCH", token: dad.token, body: { pinned: true } })).status).toBe(200);
  });
});

describe("trash", () => {
  it("item: delete, see it in everyone's trash, undo restores it exactly", async () => {
    const it = (await addItem(nanny, { name: "Olive oil", qty: "1 L", note: "the green one", urgent: true })).json.item;
    const d = await api(`/api/items/${it.id}`, { method: "DELETE", token: nanny.token });
    expect(d.json.trash_id).toBeTruthy();
    expect((await api("/api/items", { token: dad.token })).json.items.some((x: any) => x.id === it.id)).toBe(false);
    const t = await trashList(dad);
    expect(t.map((x: any) => [x.kind, x.label, x.deleted_by_name])).toEqual([["item", "Olive oil", "Nanny"]]);
    const r = await restore(dad, d.json.trash_id);
    expect(r.json).toMatchObject({ ok: true, kind: "item", id: it.id });
    const back = (await api("/api/items", { token: dad.token })).json.items.find((x: any) => x.id === it.id);
    expect(back).toMatchObject({ name: "Olive oil", qty: "1 L", note: "the green one", added_by: nanny.id, urgent_at: it.urgent_at });
    expect(await trashList(dad)).toEqual([]);
    expect((await restore(dad, d.json.trash_id)).status).toBe(404);
  });

  it("item re-added meanwhile: restore keeps the new one", async () => {
    const it = (await addItem(dad, { name: "Rice" })).json.item;
    const d = await api(`/api/items/${it.id}`, { method: "DELETE", token: dad.token });
    const again = (await addItem(mom, { name: "rice" })).json.item;
    const r = await restore(dad, d.json.trash_id);
    expect(r.json).toMatchObject({ duplicate: true, id: again.id });
    expect((await api("/api/items", { token: dad.token })).json.items.filter((x: any) => x.name.toLowerCase() === "rice")).toHaveLength(1);
  });

  it("task: only parents see and restore it, with its questions", async () => {
    const t = (await api("/api/tasks", { token: dad.token, body: { title: "Wash car" } })).json.task;
    await api(`/api/tasks/${t.id}/comments`, { token: nanny.token, body: { body: "Which soap?" } });
    const d = await api(`/api/tasks/${t.id}`, { method: "DELETE", token: dad.token });
    expect(d.json.trash_ids).toHaveLength(1);
    expect(await trashList(nanny)).toEqual([]);
    expect((await restore(nanny, d.json.trash_ids[0])).status).toBe(404);
    expect((await restore(mom, d.json.trash_ids[0])).status).toBe(200);
    const comments = await api(`/api/tasks/${t.id}/comments`, { token: dad.token });
    expect(comments.json.comments.map((c: any) => c.body)).toEqual(["Which soap?"]);
  });

  it("message: only the author sees it; restore brings back reactions; purge empties it", async () => {
    const m = (await post(nanny, { body: "Secret plan" })).json.message;
    await api(`/api/messages/${m.id}/reaction`, { method: "PUT", token: dad.token, body: { emoji: "👍" } });
    const d = await api(`/api/messages/${m.id}`, { method: "DELETE", token: nanny.token });
    expect(await trashList(dad)).toEqual([]);
    expect((await trashList(nanny)).map((x: any) => x.label)).toEqual(["Secret plan"]);
    expect((await restore(nanny, d.json.trash_id)).status).toBe(200);
    const page = await api("/api/messages", { token: dad.token });
    expect(page.json.messages.some((x: any) => x.id === m.id)).toBe(true);
    expect(page.json.reactions).toEqual([{ message_id: m.id, member_id: dad.id, emoji: "👍" }]);
    const d2 = await api(`/api/messages/${m.id}`, { method: "DELETE", token: nanny.token });
    expect((await api(`/api/trash/${d2.json.trash_id}`, { method: "DELETE", token: dad.token })).status).toBe(404);
    expect((await api(`/api/trash/${d2.json.trash_id}`, { method: "DELETE", token: nanny.token })).status).toBe(200);
    expect(await trashList(nanny)).toEqual([]);
  });

  it("expires after 24 hours", async () => {
    const it = (await addItem(dad, { name: "Old thing" })).json.item;
    const d = await api(`/api/items/${it.id}`, { method: "DELETE", token: dad.token });
    await env.DB.prepare("UPDATE trash SET deleted_at = ?1").bind(Date.now() - 25 * 3_600_000).run();
    expect(await trashList(dad)).toEqual([]);
    expect((await restore(dad, d.json.trash_id)).status).toBe(404);
    await runCleanup(env);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM trash").first<{ n: number }>();
    expect(n!.n).toBe(0);
  });
});
