import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { api, makeHousehold, resetDb, setupFirst } from "./helpers";

beforeEach(resetDb);

describe("setup", () => {
  it("status flips after setup", async () => {
    expect((await api("/api/status")).json).toEqual({ setup: true });
    await setupFirst();
    expect((await api("/api/status")).json).toEqual({ setup: false });
  });

  it("wrong code is 403 then rate limited", async () => {
    const hdr = { "cf-connecting-ip": "9.9.9.9" };
    for (let i = 0; i < 5; i++) {
      expect((await api("/api/setup", { body: { code: "nope", name: "A" }, headers: hdr })).status).toBe(403);
    }
    const r = await api("/api/setup", { body: { code: "test-setup", name: "A" }, headers: hdr });
    expect(r.status).toBe(429);
  });

  it("is refused once a member exists", async () => {
    await setupFirst();
    const r = await api("/api/setup", { body: { code: "test-setup", name: "Evil" } });
    expect(r.status).toBe(403);
  });
});

describe("invites and join", () => {
  const invite = (token: string, role: string, name: string) => api("/api/invites", { token, body: { role, name } });

  it("only parents can invite", async () => {
    const { nanny } = await makeHousehold();
    expect((await invite(nanny.token, "parent", "X")).status).toBe(403);
    expect((await api("/api/invites", { body: { role: "parent", name: "X" } })).status).toBe(401);
  });

  it("invite requires a valid, unused name", async () => {
    const dad = await setupFirst();
    expect((await api("/api/invites", { token: dad.token, body: { role: "nanny" } })).status).toBe(400);
    expect((await invite(dad.token, "nanny", "a".repeat(41))).status).toBe(400);
    expect((await invite(dad.token, "parent", " dAd ")).json.error).toBe("name_taken");
    const inv = await invite(dad.token, "nanny", "Aisha");
    expect(inv.status).toBe(200);
    expect(inv.json.secret).toMatch(/^[0-9a-f]{32}$/);
    expect(inv.json.name).toBe("Aisha");
    const peek = await api("/api/invites/peek?s=" + inv.json.secret);
    expect(peek.json).toEqual({ role: "nanny", name: "Aisha", invited_by_name: "Dad" });
    expect((await api("/api/invites/peek?s=" + "0".repeat(32))).status).toBe(404);
  });

  it("stores only the secret hash", async () => {
    const dad = await setupFirst();
    const inv = await invite(dad.token, "parent", "Mom");
    const row = await env.DB.prepare("SELECT secret_hash FROM invites").first<{ secret_hash: string }>();
    expect(row!.secret_hash).not.toBe(inv.json.secret);
    expect(row!.secret_hash).toHaveLength(64);
  });

  it("caps open invites at 5", async () => {
    const dad = await setupFirst();
    for (let i = 0; i < 5; i++) expect((await invite(dad.token, "parent", "P" + i)).status).toBe(200);
    expect((await invite(dad.token, "parent", "P5")).status).toBe(429);
  });

  it("join uses the inviter's name, ignores the joiner's; invite is single-use", async () => {
    const dad = await setupFirst();
    const inv = await invite(dad.token, "nanny", "Aisha");
    const j = await api("/api/join", { body: { secret: inv.json.secret, name: "Nanny" } });
    expect(j.status).toBe(200);
    expect(j.json.member).toMatchObject({ role: "nanny", name: "Aisha" });
    const me = await api("/api/me", { token: j.json.token });
    expect(me.json.members.map((m: any) => m.name)).toEqual(["Dad", "Aisha"]);
    expect((await api("/api/join", { body: { secret: inv.json.secret } })).status).toBe(404);
    expect((await api("/api/invites/peek?s=" + inv.json.secret)).status).toBe(404);
  });

  it("invited helper cannot rename; parents can", async () => {
    const { mom, nanny } = await makeHousehold();
    const r = await api("/api/me", { token: nanny.token, method: "PATCH", body: { name: "Other" } });
    expect(r.status).toBe(403);
    expect(r.json.error).toBe("name_locked");
    expect((await api("/api/me", { token: mom.token, method: "PATCH", body: { name: "Mama" } })).status).toBe(200);
  });

  it("rejects an expired invite", async () => {
    const dad = await setupFirst();
    const inv = await invite(dad.token, "parent", "Mom");
    await env.DB.prepare("UPDATE invites SET expires_at = ?1").bind(Date.now() - 1000).run();
    expect((await api("/api/invites/peek?s=" + inv.json.secret)).status).toBe(404);
    expect((await api("/api/join", { body: { secret: inv.json.secret } })).status).toBe(404);
  });

  it("rejects the 4th member and leaves the invite unused", async () => {
    const { dad } = await makeHousehold();
    const inv = await invite(dad.token, "parent", "Fourth");
    const j = await api("/api/join", { body: { secret: inv.json.secret } });
    expect(j.status).toBe(409);
    expect(j.json.error).toBe("household_full");
    const row = await env.DB.prepare("SELECT used_by FROM invites WHERE used_by IS NULL").first();
    expect(row).not.toBeNull();
    const c = await env.DB.prepare("SELECT COUNT(*) AS c FROM members").first<{ c: number }>();
    expect(c!.c).toBe(3);
  });

  it("rejects joining when the name was taken after inviting, and keeps the invite", async () => {
    const dad = await setupFirst("Dad");
    const inv = await invite(dad.token, "parent", "Mom");
    await api("/api/me", { token: dad.token, method: "PATCH", body: { name: "mom" } });
    const j = await api("/api/join", { body: { secret: inv.json.secret } });
    expect(j.status).toBe(409);
    expect(j.json.error).toBe("name_taken");
    await api("/api/me", { token: dad.token, method: "PATCH", body: { name: "Dad" } });
    expect((await api("/api/join", { body: { secret: inv.json.secret } })).status).toBe(200);
  });
});

describe("members", () => {
  it("rename, duplicate rename, and remove", async () => {
    const { dad, mom, nanny } = await makeHousehold();
    expect((await api("/api/me", { token: mom.token, method: "PATCH", body: { name: "Mama" } })).status).toBe(200);
    expect((await api("/api/me", { token: mom.token, method: "PATCH", body: { name: "dad" } })).status).toBe(409);
    expect((await api("/api/members/" + nanny.id, { token: mom.token, method: "DELETE" })).status).toBe(200);
    expect((await api("/api/me", { token: nanny.token })).status).toBe(401);
    expect((await api("/api/members/" + dad.id, { token: dad.token, method: "DELETE" })).status).toBe(400);
    const me = await api("/api/me", { token: dad.token });
    expect(me.json.members.map((m: any) => m.name)).toEqual(["Dad", "Mama"]);
  });

  it("nanny cannot remove members", async () => {
    const { dad, nanny } = await makeHousehold();
    expect((await api("/api/members/" + dad.id, { token: nanny.token, method: "DELETE" })).status).toBe(403);
  });

  it("never leaks token_hash or push_sub", async () => {
    const { dad } = await makeHousehold();
    const me = await api("/api/me", { token: dad.token });
    const s = JSON.stringify(me.json);
    expect(s).not.toContain("token_hash");
    expect(s).not.toContain("push_sub");
    expect(Object.keys(me.json.member).sort()).toEqual(["id", "name", "role"]);
  });

  it("unknown api route is JSON 404", async () => {
    const r = await api("/api/nope");
    expect(r.status).toBe(404);
    expect(r.json).toEqual({ error: "not_found" });
  });
});
