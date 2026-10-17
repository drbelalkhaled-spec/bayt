import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCleanup } from "../src/lib/cleanup";
import { api, makeHousehold, resetDb, type TestMember } from "./helpers";

const EP = "https://push.example.test/send/urgent";
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
const newTask = async (body: Record<string, unknown>) => (await api("/api/tasks", { token: dad.token, body })).json.task;
const patch = (m: TestMember, id: string, body: unknown) => api(`/api/tasks/${id}`, { method: "PATCH", token: m.token, body });
const ask = (m: TestMember, id: string, body: unknown) => api(`/api/tasks/${id}/comments`, { token: m.token, body: { body } });

describe("urgent tasks", () => {
  it("are created urgent, sorted first and ring the helper with their own kind", async () => {
    await subscribe(nanny);
    await newTask({ title: "Normal", assignee_id: nanny.id, due_on: "2026-01-01" });
    const u = await newTask({ title: "Fever, call me", assignee_id: nanny.id, urgent: true });
    expect(u.urgent).toBe(true);
    await waitFor(async () => (await notice(nanny))?.text === "Urgent from Dad: Fever, call me");
    expect((await notice(nanny)).kind).toBe("task_urgent");
    const l = await api("/api/tasks", { token: nanny.token });
    expect(l.json.open[0].id).toBe(u.id);
    expect(l.json.open[1].urgent).toBe(false);
  });

  it("making a task urgent later notifies; helpers cannot change it; bad values rejected", async () => {
    await subscribe(nanny);
    const t = await newTask({ title: "Shoes", assignee_id: nanny.id });
    expect((await patch(nanny, t.id, { urgent: true })).status).toBe(403);
    expect((await patch(dad, t.id, { urgent: "yes" })).status).toBe(400);
    expect((await api("/api/tasks", { token: dad.token, body: { title: "x", urgent: 1 } })).status).toBe(400);
    const p = await patch(dad, t.id, { urgent: true });
    expect(p.json.task.urgent).toBe(true);
    await waitFor(async () => (await notice(nanny))?.text === "Urgent from Dad: Shoes");
    expect((await patch(dad, t.id, { urgent: false })).json.task.urgent).toBe(false);
  });

  it("repeating urgent tasks stay urgent", async () => {
    const t = await newTask({ title: "Meds", assignee_id: nanny.id, recur: { freq: "daily" }, urgent: true });
    await patch(nanny, t.id, { done: true });
    const l = await api("/api/tasks", { token: dad.token });
    const next = l.json.open.find((x: any) => x.title === "Meds");
    expect(next.id).not.toBe(t.id);
    expect(next.urgent).toBe(true);
  });
});

describe("task questions", () => {
  it("helper asks, parents are told, thread is ordered and counted on the task", async () => {
    await subscribe(dad);
    await subscribe(mom);
    const t = await newTask({ title: "Towels", assignee_id: nanny.id });
    const q = await ask(nanny, t.id, "  Which towels, the blue ones?  ");
    expect(q.status).toBe(200);
    expect(q.json.comment).toMatchObject({ task_id: t.id, author_id: nanny.id, author_name: "Nanny", body: "Which towels, the blue ones?" });
    await waitFor(async () => (await notice(mom))?.text === 'Nanny on "Towels": Which towels, the blue ones?');
    expect((await notice(dad)).kind).toBe("task_comment");
    await ask(dad, t.id, "Yes, blue");
    const list = await api(`/api/tasks/${t.id}/comments`, { token: mom.token });
    expect(list.json.comments.map((c: any) => [c.author_name, c.body])).toEqual([
      ["Nanny", "Which towels, the blue ones?"],
      ["Dad", "Yes, blue"],
    ]);
    const tl = await api("/api/tasks", { token: nanny.token });
    const row = tl.json.open.find((x: any) => x.id === t.id);
    expect(row.comment_count).toBe(2);
    expect(row.last_comment_by).toBe(dad.id);
    expect(row.last_comment_at).toBeGreaterThan(0);
  });

  it("parent's question reaches the helper it is for", async () => {
    await subscribe(nanny);
    const t = await newTask({ title: "Lunch" });
    await ask(mom, t.id, "Did he eat?");
    await waitFor(async () => (await notice(nanny))?.text === 'Mom on "Lunch": Did he eat?');
  });

  it("rejects empty, too long and unknown tasks; needs a member", async () => {
    const t = await newTask({ title: "x" });
    expect((await ask(nanny, t.id, "   ")).status).toBe(400);
    expect((await ask(nanny, t.id, "a".repeat(501))).status).toBe(400);
    expect((await ask(nanny, "nope", "hi")).status).toBe(404);
    expect((await api(`/api/tasks/nope/comments`, { token: nanny.token })).status).toBe(404);
    expect((await api(`/api/tasks/${t.id}/comments`)).status).toBe(401);
  });

  it("goes away with its task (delete and retention)", async () => {
    const a = await newTask({ title: "A" });
    await ask(nanny, a.id, "q");
    await api(`/api/tasks/${a.id}`, { method: "DELETE", token: dad.token });
    const b = await newTask({ title: "B" });
    await ask(nanny, b.id, "q");
    await env.DB.prepare("UPDATE tasks SET done_at = ?1, done_by = ?2 WHERE id = ?3").bind(Date.now() - 40 * 86_400_000, nanny.id, b.id).run();
    await runCleanup(env);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM task_comments").first<{ n: number }>();
    expect(n!.n).toBe(0);
  });
});
