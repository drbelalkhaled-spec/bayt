import { Hono } from "hono";
import type { Env } from "./env";
import { cleanupMedia, runCleanup } from "./lib/cleanup";
import { reportError } from "./lib/errors";
import auth from "./routes/auth";
import errors from "./routes/errors";
import items from "./routes/items";
import live from "./routes/live";
import media from "./routes/media";
import messages from "./routes/messages";
import push from "./routes/push";
import tasks from "./routes/tasks";
import trash from "./routes/trash";

const app = new Hono<{ Bindings: Env }>();

app.get("/api/health", (c) => c.json({ ok: true }));
app.route("/api", auth);
app.route("/api", items);
app.route("/api", tasks);
app.route("/api", messages);
app.route("/api", media);
app.route("/api", live);
app.route("/api", push);
app.route("/api", errors);
app.route("/api", trash);
app.all("/api/*", (c) => c.json({ error: "not_found" }, 404));
app.onError((e, c) => {
  const job = reportError(c.env, `${c.req.method} ${new URL(c.req.url).pathname}`, e);
  try {
    c.executionCtx.waitUntil(job);
  } catch {
    /* no execution context (tests): the report still runs */
  }
  return c.json({ error: "server_error" }, 500);
});

export default {
  fetch: app.fetch,
  async scheduled(_c: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      runCleanup(env)
        .then(() => cleanupMedia(env))
        .catch((e) => reportError(env, "daily cleanup", e)),
    );
  },
};

export { Household } from "./household";
