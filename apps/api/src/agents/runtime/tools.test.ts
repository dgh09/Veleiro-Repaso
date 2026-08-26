import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineTool, jsonSchemaFor, toolsByName } from "./tools";

const echo = defineTool({
  name: "echo",
  description: "Echoes the given field name back",
  input: z.object({ fieldName: z.string(), required: z.boolean().optional() }),
  handler: (input) => `field=${input.fieldName} required=${input.required ?? false}`,
});

describe("jsonSchemaFor", () => {
  it("strips the $schema key that Zod emits, which the tools API does not expect", () => {
    const schema = jsonSchemaFor(z.object({ name: z.string() }));

    expect(schema).not.toHaveProperty("$schema");
    expect(schema).toMatchObject({
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    });
  });

  it("carries descriptions through, since they are what the model reads", () => {
    const schema = jsonSchemaFor(
      z.object({ crmObject: z.string().describe("e.g. Opportunity") }),
    );

    expect(schema).toMatchObject({
      properties: { crmObject: { description: "e.g. Opportunity" } },
    });
  });
});

describe("a defined tool", () => {
  it("parses valid arguments and runs the handler", async () => {
    const outcome = await echo.run(JSON.stringify({ fieldName: "CloseDate", required: true }));

    expect(outcome).toEqual({ ok: true, content: "field=CloseDate required=true" });
  });

  it("treats empty arguments as an empty object, as models often send them", async () => {
    const noArgs = defineTool({
      name: "ping",
      description: "no arguments",
      input: z.object({}),
      handler: () => "pong",
    });

    expect(await noArgs.run("")).toEqual({ ok: true, content: "pong" });
  });

  it("reports invalid JSON as recoverable input, not as a crash", async () => {
    const outcome = await echo.run("{not json");

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.reason).toBe("invalid_input");
    expect(outcome.message).toContain("not valid JSON");
  });

  it("reports a schema mismatch as recoverable input, with the reason attached", async () => {
    const outcome = await echo.run(JSON.stringify({ fieldName: 42 }));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.reason).toBe("invalid_input");
    // The message is what gets handed back to the model, so it has to name the
    // offending field rather than just say "invalid".
    expect(outcome.message).toContain("fieldName");
  });

  it("distinguishes our own handler blowing up from bad model input", async () => {
    const broken = defineTool({
      name: "broken",
      description: "always throws",
      input: z.object({}),
      handler: () => {
        throw new Error("the connector is down");
      },
    });

    const outcome = await broken.run("{}");

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.reason).toBe("handler_failed");
    expect(outcome.message).toBe("the connector is down");
  });
});

describe("toolsByName", () => {
  it("indexes tools for the loop to resolve by the name the model used", () => {
    const registry = toolsByName([echo]);

    expect(registry.get("echo")?.name).toBe("echo");
    expect(registry.get("nope")).toBeUndefined();
  });
});
