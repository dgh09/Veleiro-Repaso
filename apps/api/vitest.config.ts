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
    //
    // The LLM_* values are placeholders, and required: env.ts only falls back
    // to the root .env when DATABASE_URL is absent, and it is injected right
    // here - so without these the whole suite would fail to parse its config.
    //
    // The .invalid TLD is reserved by RFC 2606 and can never resolve. Every
    // test drives a fake client; if one ever reaches the network by accident it
    // fails loudly here instead of quietly spending real tokens.
    env: {
      DATABASE_URL: TEST_DATABASE_URL,
      LLM_BASE_URL: "http://llm.invalid/v1",
      LLM_MODEL: "test-model",
      LLM_API_KEY: "test-key-not-a-real-credential",
    },
  },
});
