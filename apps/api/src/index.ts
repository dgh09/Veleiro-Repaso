import { serve } from "@hono/node-server";

import { createApp } from "./app";
import { env } from "./env";
import { pool } from "./db/client";

const server = serve({ fetch: createApp().fetch, port: env.API_PORT }, (info) => {
  console.log(`[api] listening on http://localhost:${info.port}`);
});

async function shutdown(signal: string): Promise<void> {
  console.log(`[api] ${signal} received, shutting down`);
  server.close();
  await pool.end();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
