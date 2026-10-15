import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { CATEGORIES, guessCategory } from "../src/lib/categories";
import { runCleanup } from "../src/lib/cleanup";
import { api, makeHousehold, resetDb } from "./helpers";

beforeEach(resetDb);

const H = 3_600_000;
const names = (r: { json: any }) => r.json.items.map((i: any) => i.name);
const tick = () => new Promise((r) => setTimeout(r, 5));

async function insertItem(name: string, addedBy: string, addedAt: number, boughtBy?: string, boughtAt?: number) {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO items(id, name, qty, note, added_by, added_at, bought_by, bought_at) VALUES (?1, ?2, NULL, NULL, ?3, ?4, ?5, ?6)",
  )
    .bind(id, name, addedBy, addedAt, boughtBy ?? null, boughtAt ?? null)
    .run();
  return id;
}

describe("items", () => {
  it("requires auth", async () => {
    expect((await api("/api/items")).status).toBe(401);
    expect((await api("/api/items", { body: { name: "Milk" } })).status).toBe(401);
    expect((await api("/api/items/x", { method: "PATCH", body: { bought: true } })).status).toBe(401);
    expect((await api("/api/items/x", { method: "DELETE" })).status).toBe(401);
  });

  it("adds and lists newest first with names", async () => {
    const { dad, mom } = await makeHousehold();
    const a = await api("/api/items", { token: dad.token, body: { name: "  Milk ", qty: "2L", note: "full fat" } });
    expect(a.status).toBe(200);
    expect(a.json.item).toMatchObject({ name: "Milk", qty: "2L", note: "full fat", added_by: dad.id, added_by_name: "Dad", bought_at: null });
    expect(a.json.duplicate).toBeUndefined();
    await tick();
    await api("/api/items", { token: mom.token, body: { name: "Eggs" } });
    const l = await api("/api/items", { token: dad.token });
    expect(names(l)).toEqual(["Eggs", "Milk"]);
    expect(l.json.items[0].added_by_name).toBe("Mom");
    expect(l.json.items[0].qty).toBeNull();
    expect(l.json.suggestions).toEqual([]);
  });

  it("returns the existing open item as a duplicate", async () => {
    const { dad, mom } = await makeHousehold();
    const a = await api("/api/items", { token: dad.token, body: { name: "Milk" } });
    const b = await api("/api/items", { token: mom.token, body: { name: "  mILK " } });
    expect(b.status).toBe(200);
    expect(b.json.duplicate).toBe(true);
    expect(b.json.item.id).toBe(a.json.item.id);
    expect(names(await api("/api/items", { token: dad.token }))).toEqual(["Milk"]);
  });

  it("tick moves below open items and records buyer; untick restores", async () => {
    const { dad, mom } = await makeHousehold();
    const a = await api("/api/items", { token: dad.token, body: { name: "Milk" } });
    await tick();
    await api("/api/items", { token: dad.token, body: { name: "Eggs" } });
    expect(names(await api("/api/items", { token: dad.token }))).toEqual(["Eggs", "Milk"]);

    const t = await api(`/api/items/${a.json.item.id}`, { method: "PATCH", token: mom.token, body: { bought: true } });
    expect(t.status).toBe(200);
    expect(t.json.item.bought_by).toBe(mom.id);
    expect(t.json.item.bought_by_name).toBe("Mom");
    expect(t.json.item.bought_at).toBeGreaterThan(0);
    await tick();
    await api("/api/items", { token: dad.token, body: { name: "Bread" } });
    expect(names(await api("/api/items", { token: dad.token }))).toEqual(["Bread", "Eggs", "Milk"]);

    const u = await api(`/api/items/${a.json.item.id}`, { method: "PATCH", token: dad.token, body: { bought: false } });
    expect(u.json.item.bought_at).toBeNull();
    expect(u.json.item.bought_by).toBeNull();
    expect(u.json.item.bought_by_name).toBeNull();
    expect(names(await api("/api/items", { token: dad.token }))).toEqual(["Bread", "Eggs", "Milk"]);
  });

  it("nanny can add, tick, edit and delete", async () => {
    const { nanny } = await makeHousehold();
    const a = await api("/api/items", { token: nanny.token, body: { name: "Rice" } });
    expect(a.status).toBe(200);
    const id = a.json.item.id;
    const t = await api(`/api/items/${id}`, { method: "PATCH", token: nanny.token, body: { bought: true } });
    expect(t.json.item.bought_by_name).toBe("Nanny");
    const e = await api(`/api/items/${id}`, { method: "PATCH", token: nanny.token, body: { name: "Basmati", qty: "1kg" } });
    expect(e.json.item).toMatchObject({ name: "Basmati", qty: "1kg" });
    expect((await api(`/api/items/${id}`, { method: "DELETE", token: nanny.token })).status).toBe(200);
    expect(names(await api("/api/items", { token: nanny.token }))).toEqual([]);
  });

  it("404s for a missing item", async () => {
    const { dad } = await makeHousehold();
    expect((await api("/api/items/nope", { method: "PATCH", token: dad.token, body: { bought: true } })).status).toBe(404);
    expect((await api("/api/items/nope", { method: "DELETE", token: dad.token })).status).toBe(404);
  });

  it("validates input", async () => {
    const { dad } = await makeHousehold();
    const post = (body: unknown) => api("/api/items", { token: dad.token, body });
    expect((await post({})).status).toBe(400);
    expect((await post({ name: "   " })).status).toBe(400);
    expect((await post({ name: 5 })).status).toBe(400);
    expect((await post({ name: "a".repeat(81) })).status).toBe(400);
    expect((await post({ name: "a".repeat(80) })).status).toBe(200);
    expect((await post({ name: "x", qty: "q".repeat(21) })).status).toBe(400);
    expect((await post({ name: "x", qty: 3 })).status).toBe(400);
    expect((await post({ name: "x", note: "n".repeat(201) })).status).toBe(400);
    const id = (await post({ name: "ok" })).json.item.id;
    const patch = (body: unknown) => api(`/api/items/${id}`, { method: "PATCH", token: dad.token, body });
    expect((await patch({ name: "" })).status).toBe(400);
    expect((await patch({ bought: "yes" })).status).toBe(400);
    expect((await patch({ qty: "q".repeat(21) })).status).toBe(400);
    expect((await patch({ note: "n".repeat(201) })).status).toBe(400);
    expect((await patch({ note: "hi" })).json.item.note).toBe("hi");
  });

  it("hides bought items older than 48h and cleanup deletes them", async () => {
    const { dad } = await makeHousehold();
    const t = Date.now();
    await insertItem("Old", dad.id, t - 60 * H, dad.id, t - 49 * H);
    await insertItem("Recent", dad.id, t - 60 * H, dad.id, t - 47 * H);
    await insertItem("Ancient", dad.id, t - 100 * 24 * H, dad.id, t - 91 * 24 * H);
    expect(names(await api("/api/items", { token: dad.token }))).toEqual(["Recent"]);

    // bought rows are kept as history (for "usual items") for 90 days, then deleted
    await runCleanup(env, Date.now());
    const rows = await env.DB.prepare("SELECT name FROM items ORDER BY name").all<{ name: string }>();
    expect(rows.results.map((r) => r.name)).toEqual(["Old", "Recent"]);
  });

  it("suggestions are distinct, recent, and exclude open items", async () => {
    const { dad } = await makeHousehold();
    const t = Date.now();
    await insertItem("Milk", dad.id, t - 5 * H, dad.id, t - 4 * H);
    await insertItem("milk", dad.id, t - 3 * H, dad.id, t - 2 * H);
    await insertItem("Eggs", dad.id, t - 1 * H, dad.id, t - 30 * 60_000);
    await insertItem("Tea", dad.id, t - 100 * 24 * H, dad.id, t - 99 * 24 * H);
    await insertItem("Bread", dad.id, t - 6 * H);
    await insertItem("Butter", dad.id, t - 8 * H, dad.id, t - 7 * H);
    await insertItem("butter", dad.id, t - 1 * H);
    const l = await api("/api/items", { token: dad.token });
    expect(l.json.suggestions).toEqual(["Eggs", "milk"]);
    expect(names(l)).toEqual(["butter", "Bread", "Eggs", "milk", "Milk", "Butter"]);
  });

  it("guesses categories from names", () => {
    const cases: Record<string, string> = {
      Milk: "Dairy & eggs",
      Labneh: "Dairy & eggs",
      "Halloumi cheese": "Dairy & eggs",
      Tomatoes: "Produce",
      Dates: "Produce",
      "Chicken breast": "Meat & fish",
      "Pita bread": "Bakery",
      Khubz: "Bakery",
      Rice: "Pantry",
      Tahini: "Pantry",
      "Za'atar": "Pantry",
      Freekeh: "Pantry",
      Cardamom: "Pantry",
      "Ice cream": "Frozen",
      "Orange juice": "Drinks",
      Diapers: "Baby",
      "Baby wipes": "Baby",
      "Formula milk": "Baby",
      "Dish soap": "Cleaning",
      Shampoo: "Personal care",
      Chocolate: "Snacks",
      "Peanut butter": "Pantry",
      Zzzz: "Other",
    };
    for (const [n, c] of Object.entries(cases)) expect([n, guessCategory(n)]).toEqual([n, c]);
    expect(guessCategory("MILK")).toBe("Dairy & eggs");
    expect(CATEGORIES[0]).toBe("Produce");
    expect(CATEGORIES.at(-1)).toBe("Other");
  });

  it("auto-assigns category on create, allows manual change, rejects invalid", async () => {
    const { dad } = await makeHousehold();
    const a = await api("/api/items", { token: dad.token, body: { name: "Labneh" } });
    expect(a.json.item.category).toBe("Dairy & eggs");
    const id = a.json.item.id;
    const p = await api(`/api/items/${id}`, { method: "PATCH", token: dad.token, body: { category: "Pantry" } });
    expect(p.json.item.category).toBe("Pantry");
    expect((await api(`/api/items/${id}`, { method: "PATCH", token: dad.token, body: { category: "Nope" } })).status).toBe(400);
    expect((await api(`/api/items/${id}`, { method: "PATCH", token: dad.token, body: { category: 3 } })).status).toBe(400);
    expect((await api("/api/items", { token: dad.token, body: { name: "x", category: "Nope" } })).status).toBe(400);
    const l = await api("/api/items", { token: dad.token });
    expect(l.json.categories).toEqual([...CATEGORIES]);
    expect(l.json.items[0].category).toBe("Pantry");
  });

  it("falls back to a guessed category for legacy rows without one", async () => {
    const { dad } = await makeHousehold();
    await insertItem("Bread", dad.id, Date.now());
    expect((await api("/api/items", { token: dad.token })).json.items[0].category).toBe("Bakery");
  });
});
