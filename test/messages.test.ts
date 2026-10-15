import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { runCleanup } from "../src/lib/cleanup";
import { api, makeHousehold, resetDb } from "./helpers";

beforeEach(resetDb);

const DAY = 86_400_000;
const insert = (id: string, author: string, body: string, t: number) =>
  env.DB.prepare("INSERT INTO messages(id, author_id, body, created_at) VALUES (?1, ?2, ?3, ?4)")
    .bind(id, author, body, t)
    .run();

describe("messages", () => {
  it("requires auth", async () => {
    expect((await api("/api/messages")).status).toBe(401);
    expect((await api("/api/messages", { body: { body: "x" } })).status).toBe(401);
    expect((await api("/api/messages/abc", { method: "DELETE" })).status).toBe(401);
  });

  it("posts and lists ascending with author_name", async () => {
    const { dad, mom } = await makeHousehold();
    const a = await api("/api/messages", { token: dad.token, body: { body: "  hello  " } });
    expect(a.status).toBe(200);
    expect(a.json.message.body).toBe("hello");
    expect(a.json.message.author_name).toBe("Dad");
    await new Promise((r) => setTimeout(r, 5));
    await api("/api/messages", { token: mom.token, body: { body: "hi back" } });
    const l = await api("/api/messages", { token: dad.token });
    expect(l.json.more).toBe(false);
    expect(l.json.cursor).toBeNull();
    expect(l.json.messages.map((m: any) => [m.body, m.author_name])).toEqual([
      ["hello", "Dad"],
      ["hi back", "Mom"],
    ]);
  });

  it("rejects empty, whitespace and too-long bodies", async () => {
    const { dad } = await makeHousehold();
    for (const body of ["", "   \n ", "a".repeat(2001), 5, undefined]) {
      const r = await api("/api/messages", { token: dad.token, body: { body } });
      expect(r.status).toBe(400);
    }
    const ok = await api("/api/messages", { token: dad.token, body: { body: "a".repeat(2000) } });
    expect(ok.status).toBe(200);
  });

  it("paginates with before cursor", async () => {
    const { dad } = await makeHousehold();
    const base = Date.now() - 10_000;
    for (let i = 0; i < 5; i++) await insert("m" + i, dad.id, "msg" + i, base + i);
    const p1 = await api("/api/messages?limit=2", { token: dad.token });
    expect(p1.json.messages.map((m: any) => m.body)).toEqual(["msg3", "msg4"]);
    expect(p1.json.more).toBe(true);
    expect(p1.json.cursor).toBe(`${base + 3}:m3`);
    const p2 = await api(`/api/messages?limit=2&before=${encodeURIComponent(p1.json.cursor)}`, { token: dad.token });
    expect(p2.json.messages.map((m: any) => m.body)).toEqual(["msg1", "msg2"]);
    expect(p2.json.more).toBe(true);
    const p3 = await api(`/api/messages?limit=2&before=${encodeURIComponent(p2.json.cursor)}`, { token: dad.token });
    expect(p3.json.messages.map((m: any) => m.body)).toEqual(["msg0"]);
    expect(p3.json.more).toBe(false);
    expect(p3.json.cursor).toBeNull();
    const plain = await api(`/api/messages?before=${base + 2}`, { token: dad.token });
    expect(plain.json.messages.map((m: any) => m.body)).toEqual(["msg0", "msg1"]);
    expect((await api("/api/messages?before=zzz", { token: dad.token })).status).toBe(400);
  });

  it("handles created_at ties with id tiebreak", async () => {
    const { dad } = await makeHousehold();
    const t = Date.now() - 1000;
    await insert("a", dad.id, "A", t);
    await insert("b", dad.id, "B", t);
    await insert("c", dad.id, "C", t);
    const after = await api(`/api/messages?after=${t}:a`, { token: dad.token });
    expect(after.json.messages.map((m: any) => m.body)).toEqual(["B", "C"]);
    const before = await api(`/api/messages?before=${t}:c`, { token: dad.token });
    expect(before.json.messages.map((m: any) => m.body)).toEqual(["A", "B"]);
  });

  it("after cursor returns only newer", async () => {
    const { dad, mom } = await makeHousehold();
    const base = Date.now() - 10_000;
    await insert("m0", dad.id, "one", base);
    await insert("m1", mom.id, "two", base + 1);
    await insert("m2", dad.id, "three", base + 2);
    const r = await api(`/api/messages?after=${base + 1}:m1`, { token: mom.token });
    expect(r.json.messages.map((m: any) => m.body)).toEqual(["three"]);
    expect(r.json.cursor).toBe(`${base + 2}:m2`);
    const none = await api(`/api/messages?after=${encodeURIComponent(r.json.cursor)}`, { token: mom.token });
    expect(none.json.messages).toEqual([]);
    expect(none.json.cursor).toBeNull();
  });

  it("only the author can delete", async () => {
    const { dad, mom } = await makeHousehold();
    const m = (await api("/api/messages", { token: dad.token, body: { body: "mine" } })).json.message;
    expect((await api(`/api/messages/${m.id}`, { method: "DELETE", token: mom.token })).status).toBe(403);
    expect((await api("/api/messages/nope", { method: "DELETE", token: dad.token })).status).toBe(404);
    expect((await api(`/api/messages/${m.id}`, { method: "DELETE", token: dad.token })).status).toBe(200);
    expect((await api("/api/messages", { token: dad.token })).json.messages).toEqual([]);
  });

  it("keeps author_name for removed members", async () => {
    const { dad, nanny } = await makeHousehold();
    await api("/api/messages", { token: nanny.token, body: { body: "bye" } });
    expect((await api(`/api/members/${nanny.id}`, { method: "DELETE", token: dad.token })).status).toBe(200);
    const l = await api("/api/messages", { token: dad.token });
    expect(l.json.messages[0].author_name).toBe("Nanny");
  });

  it("retention deletes >90 day old messages only", async () => {
    const { dad } = await makeHousehold();
    const t = Date.now();
    await insert("old", dad.id, "old", t - 91 * DAY);
    await insert("new", dad.id, "new", t - 89 * DAY);
    await runCleanup(env, t);
    const { results } = await env.DB.prepare("SELECT id FROM messages").all<{ id: string }>();
    expect(results.map((r) => r.id)).toEqual(["new"]);
  });
});
