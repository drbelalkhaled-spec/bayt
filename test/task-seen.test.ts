import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, makeHousehold, resetDb, type TestMember } from "./helpers";

const EP = "https://push.example.test/send/seen";
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
const patch = (m: TestMember, id: string, body: unknown) => api(`/api/tasks/${id}`, { method: "PATCH", token: m.token, body });
const newTask = async (body: Record<string, unknown>) => (await api("/api/tasks", { token: dad.token, body })).json.task;

describe("task seen", () => {
  it("helper marks a task seen, parents are told, done keeps it", async () => {
    await subscribe(mom);
    const t = await newTask({ title: "Laundry", assignee_id: nanny.id });
    expect(t.seen_at).toBeNull();
    const s = await patch(nanny, t.id, { seen: true });
    expect(s.status).toBe(200);
    expect(s.json.task.seen_by_name).toBe("Nanny");
    expect(s.json.task.seen_at).toBeGreaterThan(0);
    expect(s.json.task.done_at).toBeNull();
    await waitFor(async () => (await notice(mom))?.text === 'Nanny will do "Laundry"');
    expect((await notice(mom)).kind).toBe("task_seen");
    const first = s.json.task.seen_at;
    // Repeating is a no-op.
    expect((await patch(nanny, t.id, { seen: true })).json.task.seen_at).toBe(first);
    const d = await patch(nanny, t.id, { done: true });
    expect(d.json.task.seen_at).toBe(first);
  });

  it("done without seen also records seen", async () => {
    const t = await newTask({ title: "Mop" });
    const d = await patch(nanny, t.id, { done: true });
    expect(d.json.task.seen_by).toBe(nanny.id);
  });

  it("rejects bad values, other people's tasks and done tasks", async () => {
    const t = await newTask({ title: "Tax", assignee_id: mom.id });
    expect((await patch(nanny, t.id, { seen: true })).status).toBe(403);
    const u = await newTask({ title: "Dishes" });
    expect((await patch(nanny, u.id, { seen: false })).status).toBe(400);
    await patch(nanny, u.id, { done: true });
    expect((await patch(nanny, u.id, { seen: true })).status).toBe(400);
  });

  it("a parent's real edit asks for a new look; a no-op save does not", async () => {
    const t = await newTask({ title: "Bath", assignee_id: nanny.id });
    await patch(nanny, t.id, { seen: true });
    const same = await patch(dad, t.id, { title: "Bath", note: null, assignee_id: nanny.id, due_on: null, due_time: null });
    expect(same.json.task.seen_at).not.toBeNull();
    const changed = await patch(dad, t.id, { title: "Bath at 6" });
    expect(changed.json.task.seen_at).toBeNull();
    expect(changed.json.task.seen_by).toBeNull();
  });
});

describe("list push text", () => {
  it("names the item that was added", async () => {
    await subscribe(dad);
    expect((await api("/api/items", { token: nanny.token, body: { name: "Milk" } })).status).toBe(200);
    await waitFor(async () => (await notice(dad))?.text === "Nanny added Milk to the list");
    expect((await notice(dad)).kind).toBe("item");
  });
});
