import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCleanup } from "../src/lib/cleanup";
import { nextReminderAt, scheduleReminders, sendDueMessageReminders } from "../src/lib/reminders";
import { api, makeHousehold, resetDb, type TestMember } from "./helpers";

const realFetch = globalThis.fetch;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
let pushCalls: string[] = [];
let dad: TestMember, mom: TestMember, nanny: TestMember;

const stub = () => env.HOUSEHOLD.get(env.HOUSEHOLD.idFromName("home"));
const getAlarm = () => runInDurableObject(stub(), (_i, state) => state.storage.getAlarm());
const waitFor = async (cond: () => boolean | Promise<boolean>, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("timeout");
};

beforeEach(async () => {
  await resetDb();
  await runInDurableObject(stub(), (_i, state) => state.storage.deleteAlarm());
  ({ dad, mom, nanny } = await makeHousehold());
  pushCalls = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://push.example.test/")) {
      pushCalls.push(url);
      return new Response(null, { status: 201 });
    }
    return realFetch(input, init);
  });
});
afterEach(() => vi.restoreAllMocks());

const subscribe = (m: TestMember, who: string) =>
  api("/api/push/subscribe", {
    token: m.token,
    body: { subscription: { endpoint: `https://push.example.test/${who}`, keys: { p256dh: "BPkey", auth: "authkey" } } },
  });
const say = async (m: TestMember, body: string): Promise<string> =>
  (await api("/api/messages", { token: m.token, body: { body } })).json.message.id;
const remindMe = (m: TestMember, id: string, at: unknown) => api(`/api/messages/${id}/remind`, { method: "PUT", token: m.token, body: { at } });
const rows = async (memberId?: string) =>
  (
    await env.DB.prepare("SELECT message_id, member_id, remind_at, sent_at FROM message_reminders" + (memberId ? " WHERE member_id = ?1" : ""))
      .bind(...(memberId ? [memberId] : []))
      .all<{ message_id: string; member_id: string; remind_at: number; sent_at: number | null }>()
  ).results;
const notice = async (m: TestMember) => (await api("/api/push/notice", { token: m.token })).json.notice;

describe("PUT /api/messages/:id/remind", () => {
  it("sets a reminder and returns it", async () => {
    const id = await say(dad, "Buy milk");
    const at = Date.now() + 2 * HOUR;
    const r = await remindMe(mom, id, at);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ reminder: { message_id: id, remind_at: at } });
    expect(await rows(mom.id)).toMatchObject([{ message_id: id, remind_at: at, sent_at: null }]);
  });

  it("rejects bad times", async () => {
    const id = await say(dad, "Hi");
    for (const at of [Date.now() - HOUR, Date.now() + 30_000, Date.now() + 31 * DAY, 1.5 + Date.now() + HOUR, "soon", null, undefined, [1]]) {
      const r = await remindMe(mom, id, at);
      expect(r.status, JSON.stringify(at)).toBe(400);
      expect(r.json.error).toBe("bad_at");
    }
    expect(await rows()).toHaveLength(0);
  });

  it("accepts the edges of the allowed window", async () => {
    const id = await say(dad, "Hi");
    expect((await remindMe(mom, id, Date.now() + 2 * 60_000)).status).toBe(200);
    expect((await remindMe(mom, id, Date.now() + 29 * DAY)).status).toBe(200);
  });

  it("404s for a missing message, 401 without a token", async () => {
    expect((await remindMe(mom, crypto.randomUUID(), Date.now() + HOUR)).status).toBe(404);
    const id = await say(dad, "Hi");
    expect((await api(`/api/messages/${id}/remind`, { method: "PUT", body: { at: Date.now() + HOUR } })).status).toBe(401);
    expect((await api("/api/reminders")).status).toBe(401);
  });

  it("upserts one row per (member, message) and resets sent_at", async () => {
    const id = await say(dad, "Hi");
    await remindMe(mom, id, Date.now() + HOUR);
    await env.DB.prepare("UPDATE message_reminders SET sent_at = ?1").bind(Date.now()).run();
    const later = Date.now() + 5 * HOUR;
    expect((await remindMe(mom, id, later)).status).toBe(200);
    expect(await rows()).toMatchObject([{ member_id: mom.id, remind_at: later, sent_at: null }]);
    // another member has their own
    await remindMe(nanny, id, Date.now() + 2 * HOUR);
    expect(await rows()).toHaveLength(2);
  });

  it("arms the Durable Object alarm", async () => {
    const id = await say(dad, "Hi");
    const at = Date.now() + 3 * HOUR;
    await remindMe(mom, id, at);
    await waitFor(async () => (await getAlarm()) === at);
  });
});

describe("DELETE and GET", () => {
  it("DELETE removes only my reminder and is fine when there is none", async () => {
    const id = await say(dad, "Hi");
    await remindMe(mom, id, Date.now() + HOUR);
    await remindMe(nanny, id, Date.now() + HOUR);
    expect((await api(`/api/messages/${id}/remind`, { method: "DELETE", token: mom.token })).status).toBe(200);
    expect((await rows()).map((r) => r.member_id)).toEqual([nanny.id]);
    expect((await api(`/api/messages/${id}/remind`, { method: "DELETE", token: mom.token })).status).toBe(200);
    expect((await api(`/api/messages/${crypto.randomUUID()}/remind`, { method: "DELETE", token: dad.token })).status).toBe(200);
  });

  it("GET lists only my pending reminders", async () => {
    const a = await say(dad, "A");
    const b = await say(dad, "B");
    const c = await say(dad, "C");
    const t1 = Date.now() + HOUR;
    const t2 = Date.now() + 2 * HOUR;
    await remindMe(mom, b, t2);
    await remindMe(mom, a, t1);
    await remindMe(mom, c, Date.now() + 3 * HOUR);
    await remindMe(nanny, a, Date.now() + HOUR);
    await env.DB.prepare("UPDATE message_reminders SET sent_at = ?1 WHERE member_id = ?2 AND message_id = ?3").bind(Date.now(), mom.id, c).run();
    const r = await api("/api/reminders", { token: mom.token });
    expect(r.json.reminders).toEqual([
      { message_id: a, remind_at: t1 },
      { message_id: b, remind_at: t2 },
    ]);
    expect((await api("/api/reminders", { token: dad.token })).json.reminders).toEqual([]);
  });
});

describe("firing", () => {
  it("pushes only the member who set it, with the message text, exactly once", async () => {
    const id = await say(dad, "  Pick up   the\ndry cleaning ");
    await Promise.all([subscribe(dad, "dad"), subscribe(mom, "mom"), subscribe(nanny, "nanny")]);
    await remindMe(mom, id, Date.now() + HOUR);
    expect(await sendDueMessageReminders(env, Date.now() + 2 * HOUR)).toBe(1);
    expect(pushCalls).toEqual(["https://push.example.test/mom"]);
    const n = await notice(mom);
    expect(n.kind).toBe("msg_reminder");
    expect(n.text).toBe('Reminder: "Pick up the dry cleaning" — from Dad');
    expect((await rows())[0]!.sent_at).not.toBeNull();
    expect((await notice(dad)).kind).not.toBe("msg_reminder");
    expect((await notice(nanny)).kind).not.toBe("msg_reminder");
    // once only
    expect(await sendDueMessageReminders(env, Date.now() + 3 * HOUR)).toBe(0);
    expect(pushCalls).toHaveLength(1);
  });

  it("reaches the author when they remind themselves", async () => {
    await subscribe(dad, "dad");
    const id = await say(dad, "Note to self");
    await remindMe(dad, id, Date.now() + HOUR);
    await sendDueMessageReminders(env, Date.now() + 2 * HOUR);
    expect(pushCalls).toEqual(["https://push.example.test/dad"]);
    expect((await notice(dad)).text).toBe('Reminder: "Note to self" — from Dad');
  });

  it("does not fire early, and truncates long text to 80 characters", async () => {
    const id = await say(dad, "x".repeat(200));
    await subscribe(mom, "mom");
    await remindMe(mom, id, Date.now() + 2 * HOUR);
    expect(await sendDueMessageReminders(env, Date.now() + HOUR)).toBe(0);
    expect(pushCalls).toHaveLength(0);
    await sendDueMessageReminders(env, Date.now() + 3 * HOUR);
    expect((await notice(mom)).text).toBe(`Reminder: "${"x".repeat(80)}" — from Dad`);
  });

  it("names photos and voice notes", async () => {
    await Promise.all([subscribe(mom, "mom"), subscribe(nanny, "nanny")]);
    for (const [kind, who] of [["photo", mom], ["voice", nanny]] as const) {
      const mid = crypto.randomUUID();
      await env.DB.prepare("INSERT INTO messages(id, author_id, body, created_at, kind) VALUES (?1, ?2, 'a caption', ?3, ?4)")
        .bind(mid, dad.id, Date.now(), kind)
        .run();
      await remindMe(who, mid, Date.now() + HOUR);
    }
    await sendDueMessageReminders(env, Date.now() + 2 * HOUR);
    expect((await notice(mom)).text).toBe('Reminder: "📷 Photo" — from Dad');
    expect((await notice(nanny)).text).toBe('Reminder: "🎤 Voice note" — from Dad');
  });

  it("names videos without a caption and locations instead of an empty quote", async () => {
    await Promise.all([subscribe(mom, "mom"), subscribe(nanny, "nanny")]);
    for (const [kind, who] of [["video", mom], ["location", nanny]] as const) {
      const mid = crypto.randomUUID();
      // The API stores a captionless video or a location with an empty body.
      await env.DB.prepare("INSERT INTO messages(id, author_id, body, created_at, kind) VALUES (?1, ?2, '', ?3, ?4)")
        .bind(mid, dad.id, Date.now(), kind)
        .run();
      await remindMe(who, mid, Date.now() + HOUR);
    }
    await sendDueMessageReminders(env, Date.now() + 2 * HOUR);
    expect((await notice(mom)).text).toBe('Reminder: "🎬 Video" — from Dad');
    expect((await notice(nanny)).text).toBe('Reminder: "📍 Location" — from Dad');
  });

  it("uses the caption for a captioned video", async () => {
    const mid = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO messages(id, author_id, body, created_at, kind) VALUES (?1, ?2, 'the  game', ?3, 'video')")
      .bind(mid, dad.id, Date.now())
      .run();
    await subscribe(mom, "mom");
    await remindMe(mom, mid, Date.now() + HOUR);
    await sendDueMessageReminders(env, Date.now() + 2 * HOUR);
    expect((await notice(mom)).text).toBe('Reminder: "🎬 the game" — from Dad');
  });

  it("skips (but marks sent) when the message is gone", async () => {
    const id = await say(dad, "Soon deleted");
    await subscribe(mom, "mom");
    await remindMe(mom, id, Date.now() + HOUR);
    await api(`/api/messages/${id}`, { method: "DELETE", token: dad.token });
    expect(await sendDueMessageReminders(env, Date.now() + 2 * HOUR)).toBe(1);
    expect(pushCalls).toHaveLength(0);
    expect((await rows())[0]!.sent_at).not.toBeNull();
    expect((await notice(mom)).kind).not.toBe("msg_reminder");
  });

  it("the alarm fires message reminders and re-arms for the next one", async () => {
    const a = await say(dad, "Now");
    const b = await say(dad, "Later");
    await subscribe(mom, "mom");
    await remindMe(mom, a, Date.now() + HOUR);
    const later = Date.now() + 5 * HOUR;
    await remindMe(mom, b, later);
    await env.DB.prepare("UPDATE message_reminders SET remind_at = ?1 WHERE message_id = ?2").bind(Date.now() - 1000, a).run();
    await scheduleReminders(env);
    await runDurableObjectAlarm(stub());
    await waitFor(() => pushCalls.length >= 1);
    expect(pushCalls).toEqual(["https://push.example.test/mom"]);
    expect((await notice(mom)).text).toBe('Reminder: "Now" — from Dad');
    expect(await getAlarm()).toBe(later);
  });
});

describe("nextReminderAt", () => {
  const insertTask = (fields: Record<string, unknown>) =>
    env.DB.prepare("INSERT INTO tasks(id, title, created_by, created_at, remind_at) VALUES (?1, 'T', ?2, ?3, ?4)")
      .bind(crypto.randomUUID(), dad.id, Date.now(), fields.remind_at)
      .run();

  it("is null with nothing pending", async () => {
    expect(await nextReminderAt(env)).toBeNull();
  });

  it("returns the earlier of task and message reminders", async () => {
    const id = await say(dad, "Hi");
    const msgAt = Date.now() + 2 * HOUR;
    const taskAt = Date.now() + 4 * HOUR;
    await remindMe(mom, id, msgAt);
    expect(await nextReminderAt(env)).toBe(msgAt);
    await insertTask({ remind_at: taskAt });
    expect(await nextReminderAt(env)).toBe(msgAt);
    const sooner = Date.now() + HOUR;
    await insertTask({ remind_at: sooner });
    expect(await nextReminderAt(env)).toBe(sooner);
  });

  it("ignores sent message reminders", async () => {
    const id = await say(dad, "Hi");
    await remindMe(mom, id, Date.now() + HOUR);
    await env.DB.prepare("UPDATE message_reminders SET sent_at = ?1").bind(Date.now()).run();
    expect(await nextReminderAt(env)).toBeNull();
    await insertTask({ remind_at: Date.now() + 9 * HOUR });
    expect(await nextReminderAt(env)).not.toBeNull();
  });

  it("clears the alarm after cancelling the only reminder", async () => {
    const id = await say(dad, "Hi");
    await remindMe(mom, id, Date.now() + 3 * HOUR);
    await waitFor(async () => (await getAlarm()) !== null);
    await api(`/api/messages/${id}/remind`, { method: "DELETE", token: mom.token });
    await waitFor(async () => (await getAlarm()) === null);
  });
});

describe("retention", () => {
  const insert = (messageId: string, remindAt: number, sentAt: number | null) =>
    env.DB.prepare("INSERT INTO message_reminders(id, member_id, message_id, remind_at, sent_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
      .bind(crypto.randomUUID(), mom.id, messageId, remindAt, sentAt, Date.now())
      .run();

  it("deletes sent reminders after 7 days, and old ones whose message is gone after 2 days", async () => {
    const t = Date.now();
    const live = await say(dad, "Still here");
    const live2 = await say(dad, "Still here too");
    const live3 = await say(dad, "And me");
    const gone = crypto.randomUUID();
    await insert(live, t - 8 * DAY, t - 8 * DAY); // sent long ago: deleted
    await insert(live2, t - 3 * DAY, t - 3 * DAY); // sent recently: kept
    await insert(live3, t + DAY, null); // pending: kept
    await insert(gone, t - 3 * DAY, null); // message gone, long past due: deleted
    const goneRecent = crypto.randomUUID();
    await insert(goneRecent, t - DAY, null); // message gone but could still be restored: kept
    await runCleanup(env, t);
    expect((await rows()).map((r) => r.message_id).sort()).toEqual([live2, live3, goneRecent].sort());
  });
});
