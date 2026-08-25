import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROUTES_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * CLAUDE.md rule 2 says tenant isolation is enforced in one place: repositories
 * that take a TenantContext and inject the tenant_id filter. SPEC calls that
 * "structurally impossible" to violate, but a repository layer is really a
 * convention - a single `import { db }` in a route walks straight past it, and
 * a reviewer has to notice.
 *
 * This test is what makes the convention enforced. It is the cheapest honest
 * answer available; the genuinely structural one is Postgres row-level
 * security, and the README records why that was not chosen.
 */
const FORBIDDEN = [
  { pattern: /from\s+["'][^"']*db\/client["']/, what: "the Drizzle client" },
  { pattern: /from\s+["']drizzle-orm/, what: "drizzle-orm directly" },
  { pattern: /from\s+["'][^"']*db\/schema["']/, what: "the table definitions" },
];

function sourceFilesIn(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFilesIn(full);
    if (!full.endsWith(".ts") || full.endsWith(".test.ts")) return [];
    return [full];
  });
}

describe("route handlers never touch the database directly", () => {
  const files = sourceFilesIn(ROUTES_DIR);

  it("finds route files to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files.map((f) => [path.basename(f), f] as const))(
    "%s goes through the repository layer",
    (_name, file) => {
      const source = readFileSync(file, "utf8");

      for (const { pattern, what } of FORBIDDEN) {
        expect(
          pattern.test(source),
          `${path.relative(ROUTES_DIR, file)} imports ${what}. Route handlers must ` +
            `go through src/db/repositories/, which is where the tenant_id filter ` +
            `is applied.`,
        ).toBe(false);
      }
    },
  );
});
