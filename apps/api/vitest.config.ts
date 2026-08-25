import { defineConfig } from "vitest/config";

import { TEST_DATABASE_URL } from "./test/database-url.ts";

export default defineConfig({
  test: {
    environment: "node",
    globalSetup: ["./vitest.globalSetup.ts"],
    // Integration tests share one Postgres database, so they run in a single
    // process. Parallel files would race on the same rows.
    fileParallelism: false,
    // Reaches the worker processes only. The global setup imports the constant.
    env: { DATABASE_URL: TEST_DATABASE_URL },
  },
});
