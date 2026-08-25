import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // The app module graph reaches env.ts, which parses configuration at import
    // time and fails loudly when it is missing. Tests never open a socket (pg
    // Pool connects lazily), so a placeholder URL is enough to import the app.
    env: {
      DATABASE_URL: "postgresql://veleiro:veleiro@localhost:5433/veleiro_test",
    },
  },
});
