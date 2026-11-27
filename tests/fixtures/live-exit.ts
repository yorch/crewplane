// Starts a dashboard with an open event stream, closes the server, and lets the
// process exit by itself. A leaked timer, socket or stream would keep it alive;
// tests/live-exit.test.ts fails if this does not finish promptly.
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import {
  createDashboard,
  newSessionToken,
} from "../../src/engine/dashboard.ts";

const root = process.argv[2] ?? process.cwd();
const token = newSessionToken();
const server = createDashboard(root, {
  session: { token },
  live: { intervalMs: 20, heartbeatMs: 50 },
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as AddressInfo).port;
let events = 0;
await new Promise<void>((resolve, reject) => {
  const req = request(
    {
      host: "127.0.0.1",
      port,
      path: "/api/events",
      headers: { "x-crewplane-session": token },
    },
    (res) => {
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        events += chunk.split("event: ").length - 1;
        if (events >= 3) resolve();
      });
      res.on("error", () => {});
    },
  );
  req.on("error", reject);
  req.end();
});
await new Promise<void>((resolve) => server.close(() => resolve()));
console.log(`closed after ${events} events`);
// No process.exit(): the event loop must drain on its own.
