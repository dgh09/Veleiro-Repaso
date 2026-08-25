import { fileURLToPath } from "node:url";
import path from "node:path";

import { z } from "zod";

/**
 * Configuration is a boundary, so it gets parsed like every other boundary in
 * this codebase. Failing here with a readable message beats failing later with
 * `undefined` somewhere deep in a connection string.
 *
 * The LLM_* values are reserved for Phase 2. Nothing reads them yet, so they
 * are optional for now - Phase 2 tightens LLM_API_KEY to required.
 */
const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  API_PORT: z.coerce.number().int().positive().default(3001),

  LLM_BASE_URL: z.url().optional(),
  LLM_MODEL: z.string().min(1).optional(),
  LLM_API_KEY: z.string().optional(),
});

export type Env = z.infer<typeof EnvSchema>;

const ROOT_ENV_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  ".env",
);

/**
 * Load the repo-root .env when the environment does not already carry the
 * config. Tools that are not ours - drizzle-kit, for one - do not accept
 * node's --env-file flag, and making this module self-sufficient beats
 * threading the flag through every entry point and forgetting it in one.
 *
 * A missing file is not an error here: real environment variables are a valid
 * way to configure this. If the config is genuinely absent, the parse below
 * says so precisely.
 */
function loadRootEnvFile(): void {
  if (process.env.DATABASE_URL !== undefined) return;
  try {
    process.loadEnvFile(ROOT_ENV_FILE);
  } catch {
    // No .env on disk. Fall through to the parse, which reports what is missing.
  }
}

function loadEnv(): Env {
  loadRootEnvFile();

  const parsed = EnvSchema.safeParse(process.env);

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");

    throw new Error(
      `Invalid environment configuration:\n${details}\n\n` +
        `Copy .env.example to .env at the repo root and fill it in.`,
    );
  }

  return parsed.data;
}

export const env = loadEnv();
