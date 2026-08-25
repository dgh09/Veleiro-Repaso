import { describe, expect, it, vi } from "vitest";
import { HealthResponseSchema } from "@veleiro/shared";

import { createApp } from "../app";

describe("GET /health", () => {
  it("returns 200 and a schema-valid ok body when the database responds", async () => {
    const app = createApp({
      health: { pingDb: async () => ({ ok: true }) },
    });

    const res = await app.request("/health");

    expect(res.status).toBe(200);
    expect(HealthResponseSchema.parse(await res.json())).toEqual({
      status: "ok",
      db: "ok",
    });
  });

  it("returns 503 and reports db: error when the ping fails", async () => {
    // Silence the intentional error log so the suite output stays readable.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const app = createApp({
      health: {
        pingDb: async () => ({ ok: false, error: new Error("connection refused") }),
      },
    });

    const res = await app.request("/health");
    const raw = await res.text();

    expect(res.status).toBe(503);
    expect(HealthResponseSchema.parse(JSON.parse(raw))).toEqual({
      status: "error",
      db: "error",
    });

    // The reason is logged server-side, never returned to the client.
    expect(errorSpy).toHaveBeenCalledOnce();
    expect(raw).not.toContain("connection refused");

    errorSpy.mockRestore();
  });
});
