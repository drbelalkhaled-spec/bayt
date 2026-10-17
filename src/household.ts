import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import { reportError } from "./lib/errors";
import { nextReminderAt, sendDueReminders } from "./lib/reminders";

const MAX_FRAME = 1024;

interface Att {
  memberId: string;
  gone: boolean;
}

function safeSend(ws: WebSocket, event: unknown): void {
  try {
    ws.send(JSON.stringify(event));
  } catch {
    /* socket already gone */
  }
}

/** Single-instance hub (idFromName('home')) holding the household's hibernating WebSockets. */
export class Household extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/connect") {
      const memberId = request.headers.get("x-member-id");
      if (!memberId) return new Response("missing member", { status: 400 });
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server, [memberId]);
      server.serializeAttachment({ memberId, gone: false } satisfies Att);
      safeSend(server, { type: "hello", online: this.onlineIds() });
      this.broadcast({ type: "presence", online: this.onlineIds() });
      return new Response(null, {
        status: 101,
        webSocket: client,
        headers: { "sec-websocket-protocol": "bayt" },
      });
    }
    if (path === "/broadcast" && request.method === "POST") {
      let ev: unknown;
      try {
        ev = await request.json();
      } catch {
        return new Response("bad json", { status: 400 });
      }
      if (!ev || typeof ev !== "object" || Array.isArray(ev)) return new Response("bad event", { status: 400 });
      this.broadcast(ev);
      return new Response("ok");
    }
    if (path === "/kick" && request.method === "POST") {
      let memberId: unknown;
      try {
        memberId = ((await request.json()) as { memberId?: unknown })?.memberId;
      } catch {
        /* fallthrough */
      }
      if (typeof memberId !== "string" || !memberId) return new Response("bad request", { status: 400 });
      for (const ws of this.ctx.getWebSockets(memberId)) {
        this.markGone(ws);
        try {
          ws.close(4001, "removed");
        } catch {
          /* already closing */
        }
      }
      this.broadcast({ type: "presence", online: this.onlineIds() });
      return new Response("ok");
    }
    if (path === "/schedule" && request.method === "POST") {
      await this.armReminders();
      return new Response("ok");
    }
    return new Response("Not found", { status: 404 });
  }

  /** Points the alarm at the earliest pending task reminder (or clears it). */
  private async armReminders(): Promise<void> {
    const t = await nextReminderAt(this.env);
    if (t === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(Math.max(t, Date.now()));
  }

  /** Task reminders: push each due one once, tell clients, then re-arm for the next pending one. */
  async alarm(): Promise<void> {
    try {
      const sent = await sendDueReminders(this.env);
      if (sent) this.broadcast({ type: "changed", scope: "tasks" });
    } catch (e) {
      await reportError(this.env, "reminders", e);
    }
    await this.armReminders();
  }

  private markGone(ws: WebSocket): Att | null {
    const a = ws.deserializeAttachment() as Att | null;
    if (!a) return null;
    if (!a.gone) {
      a.gone = true;
      ws.serializeAttachment(a);
    }
    return a;
  }

  private onlineIds(): string[] {
    const ids = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as Att | null;
      if (a && !a.gone) ids.add(a.memberId);
    }
    return [...ids];
  }

  private broadcast(event: unknown, exceptMemberId?: string): void {
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as Att | null;
      if (a && !a.gone && a.memberId !== exceptMemberId) safeSend(ws, event);
    }
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string" || message.length > MAX_FRAME) return;
    let m: any;
    try {
      m = JSON.parse(message);
    } catch {
      return;
    }
    const a = ws.deserializeAttachment() as Att | null;
    if (!a || a.gone || !m || typeof m !== "object") return;
    if (m.type === "typing") this.broadcast({ type: "typing", memberId: a.memberId }, a.memberId);
  }

  async webSocketClose(ws: WebSocket, code?: number, reason?: string): Promise<void> {
    const a = this.markGone(ws);
    if (!a) return;
    try {
      ws.close(code && code !== 1005 && code !== 1006 ? code : 1000, reason);
    } catch {
      /* already closed */
    }
    this.broadcast({ type: "presence", online: this.onlineIds() });
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }
}
