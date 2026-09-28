import { createApp } from "./app";
import { openDb } from "./db";
import { SystemClock } from "./clock";

const dbPath = process.env.DB_PATH || "cnc.db";
const db = openDb(dbPath);
const app = createApp(db, new SystemClock());

// Port 0 = auto-assign a free local port; the chosen port is printed so the
// CLI / demo can discover it.
const requested = Number(process.env.PORT || 0);
const server = app.listen(requested, "127.0.0.1", () => {
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : requested;
  console.log(`CNC tracker API listening on http://127.0.0.1:${port} (db: ${dbPath})`);
});

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
