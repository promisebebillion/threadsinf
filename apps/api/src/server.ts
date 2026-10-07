import { createApp } from "./app.js";
import { config } from "./config.js";
import { prisma } from "./db.js";
import { startScheduler } from "./scheduler.js";
import { closeSessionBrowsers } from "./browser-sessions.js";

await prisma.$connect();
const stopScheduler = startScheduler();
const server = createApp().listen(config.PORT, () =>
  console.log(
    `ThreadFlow API listening on http://localhost:${config.PORT} (${config.THREADS_PROVIDER} provider)`,
  ),
);

function shutdown() {
  stopScheduler();
  server.close(() => {
    void closeSessionBrowsers()
      .finally(() => prisma.$disconnect())
      .finally(() => process.exit(0));
  });
  // Persisted claims allow restart recovery if an external request outlives shutdown.
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
