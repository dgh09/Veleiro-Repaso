/**
 * The single definition of where integration tests point.
 *
 * vitest.config.ts injects it into the worker processes, and the global setup
 * imports it directly - `test.env` does not reach the setup, which runs in the
 * Vitest main process.
 */
export const TEST_DATABASE_NAME = "veleiro_test";

export const TEST_DATABASE_URL =
  `postgresql://veleiro:veleiro@localhost:5433/${TEST_DATABASE_NAME}`;
