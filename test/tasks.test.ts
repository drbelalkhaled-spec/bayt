import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { runCleanup } from "../src/lib/cleanup";
import { addDays, nextDue, todayIn, zonedToEpoch } from "../src/lib/recur";
import { api, makeHousehold, resetDb } from "./helpers";

const H = 3_600_000;
const DAY = 24 * H;

beforeEach(resetDb);

async function insertDone(by: string, ageMs: number, title = "old") {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO tasks(id, title, created_by, created_at, done_by, done_at) VALUES (?1,?2,?3,?4,?3,?5)",
  )
    .bind(id, title, by, Date.now() - ageMs - H, Date.now() - ageMs)
    .run();
  return id;
}

describe("tasks", () => {
  it("nanny cannot create, delete or edit title", async () => {
    const { dad, nanny } = await makeHousehold();
    expect((await api("/api/tasks", { token: nanny.token, body: { title: "x" } })).status).toBe(403);
    const t = await api("/api/tasks", { token: dad.token, body: { title: "Mop" } });
    expect(t.status).toBe(200);
    const id = t.json.task.id;
    expect((await api(`/api/tasks/${id}`, { method: "DELETE", token: nanny.token })).status).toBe(403);
    expect((await api(`/api/tasks/${id}`, { method: "PATCH", token: nanny.token, body: { title: "y" } })).status).toBe(403);
    expect((await api(`/api/tasks/${id}`, { method: "PATCH", token: nanny.token, body: { done: true, note: "z" } })).status).toBe(403);
  });

  it("assigned task flows open -> done with names", async () => {
    const { dad, nanny } = await makeHousehold();
    const t = await api("/api/tasks", {
      token: dad.token,
      body: { title: "Laundry", assignee_id: nanny.id, due_on: "2026-12-01" },
    });
    expect(t.json.task.assignee_name).toBe("Nanny");
    expect(t.json.task.created_by_name).toBe("Dad");
    const id = t.json.task.id;
    let l = await api("/api/tasks", { token: nanny.token });
    expect(l.json.open.map((x: any) => x.id)).toEqual([id]);
    const p = await api(`/api/tasks/${id}`, { method: "PATCH", token: nanny.token, body: { done: true } });
    expect(p.status).toBe(200);
    l = await api("/api/tasks", { token: nanny.token });
    expect(l.json.open).toHaveLength(0);
    expect(l.json.done[0].done_by_name).toBe("Nanny");
    expect(l.json.done[0].done_at).toBeGreaterThan(0);
  });

  it("nanny cannot complete a task assigned to mom; parent can un-done", async () => {
    const { dad, mom, nanny } = await makeHousehold();
    const t = await api("/api/tasks", { token: dad.token, body: { title: "Tax", assignee_id: mom.id } });
    const id = t.json.task.id;
    expect((await api(`/api/tasks/${id}`, { method: "PATCH", token: nanny.token, body: { done: true } })).status).toBe(403);
    expect((await api(`/api/tasks/${id}`, { method: "PATCH", token: mom.token, body: { done: true } })).status).toBe(200);
    const u = await api(`/api/tasks/${id}`, { method: "PATCH", token: dad.token, body: { done: false } });
    expect(u.json.task.done_at).toBeNull();
    expect(u.json.task.done_by).toBeNull();
    const l = await api("/api/tasks", { token: dad.token });
    expect(l.json.open).toHaveLength(1);
    expect(l.json.done).toHaveLength(0);
  });

  it("hides tasks done more than 24h ago", async () => {
    const { dad } = await makeHousehold();
    await insertDone(dad.id, 25 * H);
    const fresh = await insertDone(dad.id, 1 * H, "fresh");
    const l = await api("/api/tasks", { token: dad.token });
    expect(l.json.open).toHaveLength(0);
    expect(l.json.done.map((x: any) => x.id)).toEqual([fresh]);
  });

  it("validates input and 404s", async () => {
    const { dad } = await makeHousehold();
    const post = (body: unknown) => api("/api/tasks", { token: dad.token, body });
    expect((await post({ title: "x", assignee_id: "nope" })).status).toBe(400);
    expect((await post({ title: "x", due_on: "12/01/2026" })).status).toBe(400);
    expect((await post({ title: "x", due_on: "2026-02-31" })).status).toBe(400);
    expect((await post({ title: "" })).status).toBe(400);
    expect((await post({ title: "x".repeat(121) })).status).toBe(400);
    expect((await post({ title: "x", note: "n".repeat(501) })).status).toBe(400);
    expect((await api("/api/tasks/missing", { method: "PATCH", token: dad.token, body: { done: true } })).status).toBe(404);
    expect((await api("/api/tasks/missing", { method: "DELETE", token: dad.token })).status).toBe(404);
    const t = await post({ title: "ok" });
    expect((await api(`/api/tasks/${t.json.task.id}`, { method: "PATCH", token: dad.token, body: { assignee_id: "nope" } })).status).toBe(400);
    expect((await api(`/api/tasks/${t.json.task.id}`, { method: "DELETE", token: dad.token })).status).toBe(200);
  });

  it("?mine=1 filters to mine or unassigned", async () => {
    const { dad, mom, nanny } = await makeHousehold();
    const mk = (title: string, assignee_id?: string) =>
      api("/api/tasks", { token: dad.token, body: { title, assignee_id } });
    await mk("mine", nanny.id);
    await mk("moms", mom.id);
    await mk("anyone");
    const all = await api("/api/tasks", { token: nanny.token });
    expect(all.json.open).toHaveLength(3);
    const mine = await api("/api/tasks?mine=1", { token: nanny.token });
    expect(mine.json.open.map((x: any) => x.title).sort()).toEqual(["anyone", "mine"]);
  });

  it("orders open by due date, nulls last", async () => {
    const { dad } = await makeHousehold();
    const mk = (title: string, due_on?: string) => api("/api/tasks", { token: dad.token, body: { title, due_on } });
    await mk("none");
    await mk("late", "2026-12-09");
    await mk("early", "2026-11-01");
    const l = await api("/api/tasks", { token: dad.token });
    expect(l.json.open.map((x: any) => x.title)).toEqual(["early", "late", "none"]);
  });

  it("cleanup removes done tasks older than 30 days only", async () => {
    const { dad } = await makeHousehold();
    const old = await insertDone(dad.id, 31 * DAY);
    const recent = await insertDone(dad.id, 29 * DAY);
    await runCleanup(env, Date.now());
    const ids = (await env.DB.prepare("SELECT id FROM tasks").all<{ id: string }>()).results.map((r) => r.id);
    expect(ids).toContain(recent);
    expect(ids).not.toContain(old);
  });
});

// ---------------------------------------------------------------------------
// Scheduling, repeating tasks, routine slots, photos, "couldn't do it"
// ---------------------------------------------------------------------------

const patch = (token: string, id: string, body: unknown) => api(`/api/tasks/${id}`, { method: "PATCH", token, body });
const row = (id: string) => env.DB.prepare("SELECT * FROM tasks WHERE id = ?1").bind(id).first<any>();
const allTasks = async () => (await env.DB.prepare("SELECT * FROM tasks ORDER BY created_at, due_on").all<any>()).results;

async function upload(token: string, type = "image/png"): Promise<string> {
  const res = await SELF.fetch("http://x/api/media", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": type },
    body: new Uint8Array([1, 2, 3, 4]),
  });
  const j: any = await res.json();
  if (res.status !== 200) throw new Error("upload " + JSON.stringify(j));
  return j.key;
}

describe("task scheduling validation", () => {
  it("validates recur, due_time and slot", async () => {
    const { dad } = await makeHousehold();
    const post = (body: unknown) => api("/api/tasks", { token: dad.token, body });
    expect((await post({ title: "x", recur: { freq: "hourly" } })).status).toBe(400);
    expect((await post({ title: "x", recur: { freq: "every", days: 1 } })).status).toBe(400);
    expect((await post({ title: "x", recur: { freq: "weekly", weekdays: [] } })).status).toBe(400);
    expect((await post({ title: "x", recur: "daily" })).status).toBe(400);
    expect((await post({ title: "x", due_on: "2026-12-01", due_time: "24:00" })).status).toBe(400);
    expect((await post({ title: "x", due_on: "2026-12-01", due_time: "9:00" })).status).toBe(400);
    expect((await post({ title: "x", due_time: "09:00" })).status).toBe(400); // time needs a date
    expect((await post({ title: "x", slot: "night", recur: { freq: "daily" } })).status).toBe(400);
    expect((await post({ title: "x", slot: "morning" })).status).toBe(400); // slot needs recur
    // the chat worker's request shape stays valid
    expect((await post({ title: "from chat", note: "msg" })).status).toBe(200);
    const ok = await post({ title: "Bath", recur: { freq: "weekly", weekdays: [3, 1] }, slot: "evening" });
    expect(ok.status).toBe(200);
    expect(ok.json.task.recur).toEqual({ freq: "weekly", weekdays: [1, 3] });
    expect(ok.json.task.slot).toBe("evening");
    expect(ok.json.task.series_id).toBe(ok.json.task.id);
    expect(ok.json.task.due_on).toBe(todayIn("UTC"));
    const id = ok.json.task.id;
    expect((await patch(dad.token, id, { recur: { freq: "every", days: 31 } })).status).toBe(400);
    expect((await patch(dad.token, id, { recur: null })).status).toBe(400); // slot still set
    expect((await patch(dad.token, id, { recur: null, slot: null })).status).toBe(200);
  });

  it("computes remind_at in the household tz and resets reminded_at on change", async () => {
    const { dad } = await makeHousehold();
    expect((await api("/api/household", { method: "PUT", token: dad.token, body: { tz: "Asia/Riyadh" } })).status).toBe(200);
    const t = await api("/api/tasks", { token: dad.token, body: { title: "Pickup", due_on: "2030-03-08", due_time: "09:00" } });
    expect(t.status).toBe(200);
    expect(t.json.task.remind_at).toBe(Date.UTC(2030, 2, 8, 6, 0) - 15 * 60_000);
    expect(t.json.task.reminded_at).toBeNull();
    const id = t.json.task.id;
    await env.DB.prepare("UPDATE tasks SET reminded_at = 1 WHERE id = ?1").bind(id).run();
    const p = await patch(dad.token, id, { due_time: "10:30" });
    expect(p.json.task.remind_at).toBe(Date.UTC(2030, 2, 8, 7, 30) - 15 * 60_000);
    expect(p.json.task.reminded_at).toBeNull();
    // editing only the title keeps reminder state
    await env.DB.prepare("UPDATE tasks SET reminded_at = 1 WHERE id = ?1").bind(id).run();
    expect((await patch(dad.token, id, { title: "Pick up kids" })).json.task.reminded_at).toBe(1);
    // clearing the time clears the reminder
    expect((await patch(dad.token, id, { due_time: null })).json.task.remind_at).toBeNull();
    // America/New_York across DST
    await api("/api/household", { method: "PUT", token: dad.token, body: { tz: "America/New_York" } });
    const n = await api("/api/tasks", { token: dad.token, body: { title: "x", due_on: "2030-03-10", due_time: "09:00" } });
    expect(n.json.task.remind_at).toBe(Date.UTC(2030, 2, 10, 13, 0) - 15 * 60_000);
    // due moment already past -> marked reminded so it never fires late
    const past = await api("/api/tasks", { token: dad.token, body: { title: "y", due_on: "2020-01-01", due_time: "09:00" } });
    expect(past.json.task.reminded_at).toBeGreaterThan(0);
  });
});

describe("repeating tasks", () => {
  it("done on a recurring task creates the next occurrence; undo removes it", async () => {
    const { dad, nanny } = await makeHousehold();
    const today = todayIn("UTC");
    const t = await api("/api/tasks", {
      token: dad.token,
      body: {
        title: "Water plants",
        note: "balcony",
        assignee_id: nanny.id,
        recur: { freq: "every", days: 3 },
        due_on: today,
        due_time: "23:59",
        slot: "evening",
      },
    });
    const id = t.json.task.id;
    expect((await patch(nanny.token, id, { done: true })).status).toBe(200);
    let rows = await allTasks();
    expect(rows).toHaveLength(2);
    const next = rows.find((r) => r.id !== id);
    expect(next.series_id).toBe(id);
    expect(next.due_on).toBe(addDays(today, 3));
    expect(next.title).toBe("Water plants");
    expect(next.note).toBe("balcony");
    expect(next.assignee_id).toBe(nanny.id);
    expect(next.due_time).toBe("23:59");
    expect(next.slot).toBe("evening");
    expect(JSON.parse(next.recur)).toEqual({ freq: "every", days: 3 });
    expect(next.remind_at).toBe(zonedToEpoch(next.due_on, "23:59", "UTC") - 15 * 60_000);
    expect(next.done_at).toBeNull();
    // ticking again does nothing new
    await patch(nanny.token, id, { done: true });
    expect(await allTasks()).toHaveLength(2);
    // undo removes the untouched next occurrence
    expect((await patch(nanny.token, id, { done: false })).status).toBe(200);
    rows = await allTasks();
    expect(rows.map((r) => r.id)).toEqual([id]);
    // re-done, then the next is edited -> undo keeps it
    await patch(nanny.token, id, { done: true });
    const n2 = (await allTasks()).find((r) => r.id !== id);
    await patch(dad.token, n2.id, { title: "Water ALL plants" });
    await patch(dad.token, id, { done: false });
    expect((await allTasks()).map((r) => r.id).sort()).toEqual([id, n2.id].sort());
  });

  it("overdue recurring task schedules from today; future one from its date", async () => {
    const { dad } = await makeHousehold();
    const today = todayIn("UTC");
    const t = await api("/api/tasks", {
      token: dad.token,
      body: { title: "Bins", recur: { freq: "weekly", weekdays: [1, 4] }, due_on: addDays(today, -10) },
    });
    await patch(dad.token, t.json.task.id, { done: true });
    const next = (await allTasks()).find((r) => r.id !== t.json.task.id);
    expect(next.due_on).toBe(nextDue({ freq: "weekly", weekdays: [1, 4] }, today));
    const f = await api("/api/tasks", { token: dad.token, body: { title: "Future", recur: { freq: "daily" }, due_on: addDays(today, 5) } });
    await patch(dad.token, f.json.task.id, { done: true });
    const fn = (await allTasks()).find((r) => r.series_id === f.json.task.id && r.id !== f.json.task.id);
    expect(fn.due_on).toBe(addDays(today, 6));
  });

  it("editing recur on an occurrence applies to future copies", async () => {
    const { dad } = await makeHousehold();
    const t = await api("/api/tasks", { token: dad.token, body: { title: "Mop", recur: { freq: "daily" } } });
    await patch(dad.token, t.json.task.id, { done: true });
    const n = (await allTasks()).find((r) => r.id !== t.json.task.id);
    await patch(dad.token, n.id, { recur: { freq: "every", days: 2 } });
    await patch(dad.token, n.id, { done: true });
    const n3 = (await allTasks()).find((r) => r.id !== t.json.task.id && r.id !== n.id);
    expect(JSON.parse(n3.recur)).toEqual({ freq: "every", days: 2 });
    expect(n3.series_id).toBe(t.json.task.id);
    expect(n3.due_on).toBe(addDays(n.due_on, 2));
  });

  it("DELETE ?series=1 removes all open tasks of the series (parent only)", async () => {
    const { dad, nanny } = await makeHousehold();
    const t = await api("/api/tasks", { token: dad.token, body: { title: "Feed fish", recur: { freq: "daily" } } });
    const id = t.json.task.id;
    await patch(dad.token, id, { done: true });
    const other = await api("/api/tasks", { token: dad.token, body: { title: "unrelated" } });
    const next = (await allTasks()).find((r) => r.series_id === id && r.id !== id);
    expect((await api(`/api/tasks/${next.id}?series=1`, { method: "DELETE", token: nanny.token })).status).toBe(403);
    expect((await patch(dad.token, next.id, { done: true })).status).toBe(200);
    const third = (await allTasks()).find((r) => r.series_id === id && r.done_at === null);
    // add an extra open one in the same series
    await env.DB.prepare("INSERT INTO tasks(id, title, created_by, created_at, series_id, due_on) VALUES ('extra','Feed fish',?1,1,?2,'2099-01-01')")
      .bind(dad.id, id)
      .run();
    const del = await api(`/api/tasks/${third.id}?series=1`, { method: "DELETE", token: dad.token });
    expect(del.status).toBe(200);
    expect(del.json.deleted).toBe(2);
    expect((await allTasks()).map((r) => r.id).sort()).toEqual([id, next.id, other.json.task.id].sort()); // done ones stay
    const one = await api(`/api/tasks/${next.id}`, { method: "DELETE", token: dad.token });
    expect(one.json.deleted).toBe(1);
  });
});

describe("couldn't do it", () => {
  it("nanny blocks with a reason, adds a shopping item, parent edit clears", async () => {
    const { dad, mom, nanny } = await makeHousehold();
    const t = await api("/api/tasks", { token: dad.token, body: { title: "Bake bread", assignee_id: nanny.id } });
    const id = t.json.task.id;
    expect((await patch(nanny.token, id, { blocked: { reason: "" } })).status).toBe(400);
    expect((await patch(nanny.token, id, { blocked: { reason: "x".repeat(201) } })).status).toBe(400);
    expect((await patch(nanny.token, id, { blocked: "nope" })).status).toBe(400);
    expect((await patch(nanny.token, id, { blocked: { reason: "x", add_item: 5 } })).status).toBe(400);
    const b = await patch(nanny.token, id, { blocked: { reason: "Out of supplies", add_item: " Flour " } });
    expect(b.status).toBe(200);
    expect(b.json.task.blocked_reason).toBe("Out of supplies");
    expect(b.json.task.blocked_by).toBe(nanny.id);
    expect(b.json.task.blocked_by_name).toBe("Nanny");
    expect(b.json.task.blocked_at).toBeGreaterThan(0);
    let items = (await env.DB.prepare("SELECT * FROM items").all<any>()).results;
    expect(items.map((i) => i.name)).toEqual(["Flour"]);
    expect(items[0].added_by).toBe(nanny.id);
    expect(items[0].bought_at).toBeNull();
    // an open item with the same name is not duplicated
    await patch(dad.token, id, { blocked: null });
    await patch(nanny.token, id, { blocked: { reason: "Still none", add_item: "flour" } });
    items = (await env.DB.prepare("SELECT * FROM items").all<any>()).results;
    expect(items).toHaveLength(1);
    // parent edit (reassign) clears the block
    const e = await patch(dad.token, id, { assignee_id: mom.id });
    expect(e.json.task.blocked_at).toBeNull();
    expect(e.json.task.blocked_reason).toBeNull();
  });

  it("enforces who may block and clear", async () => {
    const { dad, mom, nanny } = await makeHousehold();
    const moms = await api("/api/tasks", { token: dad.token, body: { title: "Tax", assignee_id: mom.id } });
    expect((await patch(nanny.token, moms.json.task.id, { blocked: { reason: "No time" } })).status).toBe(403);
    const anyone = await api("/api/tasks", { token: dad.token, body: { title: "Sweep" } });
    expect((await patch(nanny.token, anyone.json.task.id, { blocked: { reason: "Need help" } })).status).toBe(200);
    // "Try again"
    expect((await patch(dad.token, anyone.json.task.id, { blocked: null })).json.task.blocked_at).toBeNull();
    // cannot block a done task
    await patch(nanny.token, anyone.json.task.id, { done: true });
    expect((await patch(nanny.token, anyone.json.task.id, { blocked: { reason: "x" } })).status).toBe(400);
    // nanny still cannot edit title / mix keys
    expect((await patch(nanny.token, anyone.json.task.id, { title: "z" })).status).toBe(403);
    expect((await patch(nanny.token, anyone.json.task.id, { blocked: { reason: "x" }, note: "y" })).status).toBe(403);
  });
});

describe("done photo", () => {
  it("completer attaches an image; replacement and delete remove old media", async () => {
    const { dad, mom, nanny } = await makeHousehold();
    const t = await api("/api/tasks", { token: dad.token, body: { title: "Clean room", assignee_id: nanny.id } });
    const id = t.json.task.id;
    const k1 = await upload(nanny.token);
    expect((await patch(nanny.token, id, { done_photo_key: k1 })).status).toBe(403); // not done (so not the completer)
    expect((await patch(dad.token, id, { done_photo_key: k1 })).status).toBe(400); // parent: not done yet
    await patch(nanny.token, id, { done: true });
    expect((await patch(nanny.token, id, { done_photo_key: "nope" })).status).toBe(400);
    const audio = await upload(nanny.token, "audio/webm");
    expect((await patch(nanny.token, id, { done_photo_key: audio })).status).toBe(400);
    const momKey = await upload(mom.token);
    expect((await patch(nanny.token, id, { done_photo_key: momKey })).status).toBe(400); // not hers
    const ok = await patch(nanny.token, id, { done_photo_key: k1 });
    expect(ok.status).toBe(200);
    expect(ok.json.task.done_photo_key).toBe(k1);
    expect((await env.DB.prepare("SELECT attached FROM media WHERE key = ?1").bind(k1).first<any>()).attached).toBe(1);
    const k2 = await upload(nanny.token);
    await patch(nanny.token, id, { done_photo_key: k2 });
    expect(await env.DB.prepare("SELECT 1 FROM media WHERE key = ?1").bind(k1).first()).toBeNull();
    expect(await env.MEDIA.get(k1)).toBeNull();
    // someone who did not complete it (and is not a parent) cannot set a photo
    const t2 = await api("/api/tasks", { token: dad.token, body: { title: "Other" } });
    await patch(mom.token, t2.json.task.id, { done: true });
    const nk = await upload(nanny.token);
    expect((await patch(nanny.token, t2.json.task.id, { done_photo_key: nk })).status).toBe(403);
    const dk = await upload(dad.token);
    expect((await patch(dad.token, t2.json.task.id, { done_photo_key: dk })).status).toBe(200);
    // deleting the task deletes its photo
    expect((await api(`/api/tasks/${id}`, { method: "DELETE", token: dad.token })).status).toBe(200);
    expect(await env.DB.prepare("SELECT 1 FROM media WHERE key = ?1").bind(k2).first()).toBeNull();
    expect(await env.MEDIA.get(k2)).toBeNull();
    expect((await row(t2.json.task.id)).done_photo_key).toBe(dk);
  });
});
