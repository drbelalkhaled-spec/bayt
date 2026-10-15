import { Hono } from "hono";
import type { Env } from "./env";
import { cleanupMedia, runCleanup } from "./lib/cleanup";
import auth from "./routes/auth";
import items from "./routes/items";
import live from "./routes/live";
import media from "./routes/media";
import messages from "./routes/messages";
import push from "./routes/push";
import tasks from "./routes/tasks";

const app = new Hono<{ Bindings: Env }>();

app.get("/api/health", (c) => c.json({ ok: true }));
app.route("/api", auth);
app.route("/api", items);
app.route("/api", tasks);
app.route("/api", messages);
app.route("/api", media);
app.route("/api", live);
app.route("/api", push);
app.all("/api/*", (c) => c.json({ error: "not_found" }, 404));
app.onError((e, c) => {
  console.error(e);
  return c.json({ error: "server_error" }, 500);
});

export default {
  fetch: app.fetch,
  async scheduled(_c: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runCleanup(env).then(() => cleanupMedia(env)));
  },
};

export { Household } from "./household";
