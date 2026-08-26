import { describe, expect, it } from "vitest";

import { isTransientConnectionError } from "./migrate";

/**
 * The predicate that decides whether a migration failure is worth retrying.
 *
 * It matters that this is narrow. Retrying a dropped socket is free; retrying a
 * migration that failed because the SQL is wrong just fails twice more and
 * buries the real error under a warning about connections.
 */

function withCode(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

describe("isTransientConnectionError", () => {
  it("recognises the failure actually observed on this project", () => {
    expect(isTransientConnectionError(new Error("Connection terminated unexpectedly"))).toBe(
      true,
    );
  });

  it("recognises socket-level error codes", () => {
    expect(isTransientConnectionError(withCode("read ECONNRESET", "ECONNRESET"))).toBe(true);
    expect(isTransientConnectionError(withCode("connect refused", "ECONNREFUSED"))).toBe(
      true,
    );
  });

  it("looks down the cause chain, because Drizzle wraps driver errors", () => {
    const wrapped = new Error("Failed query: create table ...");
    wrapped.cause = withCode("read ECONNRESET", "ECONNRESET");

    expect(isTransientConnectionError(wrapped)).toBe(true);
  });

  it("does not retry a genuine SQL error", () => {
    // 42601 is syntax_error. Retrying it would fail identically twice more.
    expect(
      isTransientConnectionError(withCode('syntax error at or near "creat"', "42601")),
    ).toBe(false);
  });

  it("does not retry a constraint violation", () => {
    expect(
      isTransientConnectionError(
        withCode("duplicate key value violates unique constraint", "23505"),
      ),
    ).toBe(false);
  });

  it("handles a non-Error being thrown", () => {
    expect(isTransientConnectionError("something odd")).toBe(false);
    expect(isTransientConnectionError(undefined)).toBe(false);
  });
});
