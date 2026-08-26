import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * CLAUDE.md rule 3: every LLM call is logged. That holds only if every client
 * is built through `createAgentLlmClient`, which is what composes the
 * instrumentation and the retry in the right order.
 *
 * A single `createOpenAiCompatibleClient(...)` somewhere in an agent would walk
 * straight past it and nobody would notice - the code would work, it just would
 * not be audited. This test is what makes the convention enforced, and it
 * mirrors the one that guards the repository layer in
 * src/routes/no-direct-db.test.ts.
 */

const LLM_DIR = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(LLM_DIR, "..");

const FORBIDDEN = [
  {
    pattern: /from\s+["'][^"']*llm\/openai-compatible["']/,
    what: "the raw HTTP client",
  },
  {
    pattern: /from\s+["'][^"']*llm\/instrumented["']/,
    what: "the instrumentation decorator",
  },
  { pattern: /from\s+["'][^"']*llm\/retry["']/, what: "the retry decorator" },
];

function sourceFilesIn(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFilesIn(full);
    if (!full.endsWith(".ts") || full.endsWith(".test.ts")) return [];
    // src/llm is where the pieces are assembled, so it is allowed to import them.
    if (full.startsWith(LLM_DIR + path.sep)) return [];
    return [full];
  });
}

describe("nothing outside src/llm assembles its own LLM client", () => {
  const files = sourceFilesIn(SRC_DIR);

  it("finds source files to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files.map((f) => [path.relative(SRC_DIR, f), f] as const))(
    "%s builds its client through the factory",
    (_name, file) => {
      const source = readFileSync(file, "utf8");

      for (const { pattern, what } of FORBIDDEN) {
        expect(
          pattern.test(source),
          `${path.relative(SRC_DIR, file)} imports ${what} directly. Use ` +
            `createAgentLlmClient() from src/llm/factory.ts, which is what guarantees ` +
            `every model call lands in llm_calls.`,
        ).toBe(false);
      }
    },
  );
});
