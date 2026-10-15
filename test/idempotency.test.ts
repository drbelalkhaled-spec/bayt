import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { api, makeHousehold, resetDb } from "./helpers";

beforeEach(resetDb);

const count = async (table: string) => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;

describe("idempotent POST /api/items", () => {
  it("uses the client id and returns the same row on replay", async () => {
    const { dad } = await makeHousehold();
    const id = crypto.randomUUID();
    const a = await api("/api/items", { token: dad.token, body: { id, name: "Milk" } });
    expect(a.status).toBe(200);
    expect(a.json.item.id).toBe(id);
    const b = await api("/api/items", { token: dad.token, body: { id, name: "Milk" } });
    expect(b.status).toBe(200);
    expect(b.json.item.id).toBe(id);
    expect(b.json.duplicate).toBeUndefined();
    expect(await count("items")).toBe(1);
  });

  it("replay does not create or change the row", async () => {
    const { dad, mom } = await makeHousehold();
    const id = crypto.randomUUID();
    await api("/api/items", { token: dad.token, body: { id, name: "Eggs" } });
    const row = await env.DB.prepare("SELECT added_at FROM items WHERE id = ?1").bind(id).first<{ added_at: number }>();
    await api("/api/items", { token: dad.token, body: { id, name: "Eggs" } });
    const row2 = await env.DB.prepare("SELECT added_at FROM items WHERE id = ?1").bind(id).first<{ added_at: number }>();
    expect(row2!.added_at).toBe(row!.added_at);
    expect(mom.id).toBeTruthy();
  });

  it("409 when the id belongs to another author", async () => {
    const { dad, mom } = await makeHousehold();
    const id = crypto.randomUUID();
    await api("/api/items", { token: dad.token, body: { id, name: "Bread" } });
    const r = await api("/api/items", { token: mom.token, body: { id, name: "Bread" } });
    expect(r.status).toBe(409);
    expect(await count("items")).toBe(1);
  });

  it("rejects ids that are not UUID v4", async () => {
    const { dad } = await makeHousehold();
    for (const id of ["abc", "123", "00000000-0000-1000-8000-000000000000", 5, {}]) {
      const r = await api("/api/items", { token: dad.token, body: { id, name: "X" } });
      expect(r.status).toBe(400);
    }
    expect(await count("items")).toBe(0);
  });

  it("still detects duplicate names for a fresh id", async () => {
    const { dad } = await makeHousehold();
    await api("/api/items", { token: dad.token, body: { id: crypto.randomUUID(), name: "Rice" } });
    const r = await api("/api/items", { token: dad.token, body: { id: crypto.randomUUID(), name: "rice" } });
    expect(r.status).toBe(200);
    expect(r.json.duplicate).toBe(true);
    expect(await count("items")).toBe(1);
  });

  it("works without an id as before", async () => {
    const { dad } = await makeHousehold();
    const r = await api("/api/items", { token: dad.token, body: { name: "Tea" } });
    expect(r.status).toBe(200);
    expect(r.json.item.id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("idempotent POST /api/messages", () => {
  it("uses the client id and returns the same message on replay", async () => {
    const { dad } = await makeHousehold();
    const id = crypto.randomUUID();
    const a = await api("/api/messages", { token: dad.token, body: { id, body: "hi" } });
    expect(a.status).toBe(200);
    expect(a.json.message.id).toBe(id);
    const b = await api("/api/messages", { token: dad.token, body: { id, body: "hi" } });
    expect(b.status).toBe(200);
    expect(b.json.message.id).toBe(id);
    expect(b.json.message.created_at).toBe(a.json.message.created_at);
    expect(b.json.message.author_name).toBe("Dad");
    expect(await count("messages")).toBe(1);
  });

  it("409 for another author, 400 for a malformed id", async () => {
    const { dad, mom } = await makeHousehold();
    const id = crypto.randomUUID();
    await api("/api/messages", { token: dad.token, body: { id, body: "mine" } });
    expect((await api("/api/messages", { token: mom.token, body: { id, body: "mine" } })).status).toBe(409);
    expect((await api("/api/messages", { token: dad.token, body: { id: "nope", body: "x" } })).status).toBe(400);
    expect(await count("messages")).toBe(1);
  });
});
