import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Fails the build if anything credential-shaped is committed.
 *
 * A key in a commit is not fixed by deleting the commit - it is fixed by
 * revoking the key, and by then it has been pushed. So the cheap check runs
 * before that, on every test run.
 *
 * It scans what `git ls-files` reports rather than walking the working tree:
 * tracked files are exactly the risk surface. An untracked `.env` full of real
 * credentials is fine and is the whole point of the design; the same content
 * staged for commit is not.
 *
 * This lives under apps/api because that is the only workspace with a test
 * runner, but it deliberately scans the entire repository.
 */

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);

interface SecretPattern {
  name: string;
  pattern: RegExp;
}

const PATTERNS: SecretPattern[] = [
  { name: "Groq API key", pattern: /gsk_[A-Za-z0-9_-]{20,}/ },
  { name: "OpenAI-style API key", pattern: /sk-[A-Za-z0-9]{20,}/ },
  { name: "AWS access key id", pattern: /AKIA[0-9A-Z]{16}/ },
  { name: "Slack token", pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  {
    name: "private key block",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/,
  },
  // Catches a real .env committed by accident. `.env.example` keeps the value
  // empty on purpose, so it passes.
  { name: "populated LLM_API_KEY", pattern: /^[ \t]*LLM_API_KEY[ \t]*=[ \t]*\S+/m },
  { name: "populated DATABASE_URL password", pattern: /postgresql:\/\/[^\s:]+:[^\s@]+@/ },
];

/**
 * Literals that are known-safe and deliberately committed. Anything not on this
 * list trips the test, so adding to it is a decision someone has to make on
 * purpose rather than a silent exemption.
 */
const ALLOWED = new Map<string, string>([
  [
    "gsk_test_0123456789abcdefghijklmnop",
    "fake key in openai-compatible.test.ts, asserts redaction works",
  ],
  [
    "postgresql://veleiro:veleiro@",
    "local development credentials for the throwaway Docker Postgres",
  ],
]);

function trackedFiles(): string[] {
  const out = execFileSync("git", ["ls-files", "-z"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return out.split("\0").filter((entry) => entry.length > 0);
}

interface Finding {
  file: string;
  line: number;
  pattern: string;
  match: string;
}

function scan(relativePath: string): Finding[] {
  let contents: string;
  try {
    contents = readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
  } catch {
    // Unreadable or deleted-but-still-indexed; nothing to scan.
    return [];
  }

  // Binary files produce noise, not signal.
  if (contents.includes("\x00")) return [];

  const findings: Finding[] = [];

  contents.split(/\r?\n/).forEach((line, index) => {
    for (const { name, pattern } of PATTERNS) {
      const match = pattern.exec(line);
      if (match === null) continue;

      const matched = match[0];
      const allowed = [...ALLOWED.keys()].some((safe) => matched.includes(safe));
      if (allowed) continue;

      findings.push({
        file: relativePath,
        line: index + 1,
        pattern: name,
        match: `${matched.slice(0, 12)}...`,
      });
    }
  });

  return findings;
}

describe("no credentials are committed", () => {
  const files = trackedFiles();

  it("finds tracked files to scan", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("keeps the real .env out of version control", () => {
    expect(files).not.toContain(".env");
  });

  it("finds nothing credential-shaped in any tracked file", () => {
    const findings = files.flatMap(scan);

    // The match is truncated in the message: a test failure should tell you
    // where to look without reprinting the secret in full into CI logs.
    const report = findings
      .map((f) => `  ${f.file}:${f.line} - ${f.pattern} (${f.match})`)
      .join("\n");

    expect(
      findings,
      findings.length === 0
        ? ""
        : `Possible credentials in tracked files:\n${report}\n\n` +
            `If one is real: revoke it at the provider first, then remove it. ` +
            `If it is a deliberate fixture, add the literal to ALLOWED in this file.`,
    ).toEqual([]);
  });
});
