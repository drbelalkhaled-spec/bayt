import type { Env } from "../env";
import { deliver } from "./push";

export type Scope = "list" | "tasks" | "chat" | "members";

export interface PushIntent {
  kind: "item" | "task_new" | "task_seen" | "task_done" | "chat" | "task_blocked" | "reminder" | "shopping";
  to: string[];
  actorId: string;
  /** Optional notice text; a default is built from kind + actor name when absent. */
  text?: string;
}

function doPost(env: Env, path: string, body: unknown): Promise<unknown> {
  try {
    const stub = env.HOUSEHOLD.get(env.HOUSEHOLD.idFromName("home"));
    return stub
      .fetch("https://do" + path, { method: "POST", body: JSON.stringify(body) })
      .then((r) => r.body?.cancel())
      .catch((e) => console.error("household call failed", e));
  } catch (e) {
    console.error("household call failed", e);
    return Promise.resolve();
  }
}

/** Closes all live sockets of a removed member. Never throws. */
export function kick(env: Env, ctx: Pick<ExecutionContext, "waitUntil">, memberId: string): void {
  try {
    ctx.waitUntil(doPost(env, "/kick", { memberId }));
  } catch (e) {
    console.error("kick failed", e);
  }
}

/** Call after every mutation. Never throws. */
export async function emit(
  env: Env,
  ctx: Pick<ExecutionContext, "waitUntil">,
  scope: Scope,
  push?: PushIntent,
): Promise<void> {
  try {
    ctx.waitUntil(doPost(env, "/broadcast", { type: "changed", scope }));
    if (push) ctx.waitUntil(deliver(env, push).catch((e) => console.error("push failed", e)));
  } catch (e) {
    console.error("emit failed", e);
  }
}
