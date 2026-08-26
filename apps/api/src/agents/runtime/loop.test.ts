import { describe, expect, it } from "vitest";
import { z } from "zod";

import { calls, fakeLlmClient, says, toolCall } from "../../../test/fake-llm";
import { runAgentLoop } from "./loop";
import { defineTool } from "./tools";

const ran: string[] = [];

const lookupObject = defineTool({
  name: "lookup_object",
  description: "Check whether a CRM object exists",
  input: z.object({ name: z.string() }),
  handler: (input) => {
    ran.push(`lookup_object:${input.name}`);
    return `${input.name} exists`;
  },
});

const listFields = defineTool({
  name: "list_fields",
  description: "List the fields on a CRM object",
  input: z.object({ objectName: z.string() }),
  handler: (input) => {
    ran.push(`list_fields:${input.objectName}`);
    return `${input.objectName}: Amount, CloseDate`;
  },
});

const tools = [lookupObject, listFields];

function freshRun(): void {
  ran.length = 0;
}

describe("runAgentLoop", () => {
  it("drives a two-tool sequence and returns the final answer", async () => {
    freshRun();

    const client = fakeLlmClient([
      calls(toolCall("lookup_object", { name: "Opportunity" })),
      calls(toolCall("list_fields", { objectName: "Opportunity" })),
      says("Opportunity has Amount and CloseDate."),
    ]);

    const result = await runAgentLoop({
      client,
      tools,
      messages: [{ role: "user", content: "What fields does Opportunity have?" }],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");

    expect(result.value.content).toBe("Opportunity has Amount and CloseDate.");
    expect(result.value.iterations).toBe(3);
    expect(ran).toEqual(["lookup_object:Opportunity", "list_fields:Opportunity"]);

    // The tool results have to reach the model, keyed by the id it sent, or the
    // provider rejects the next turn.
    const toolMessages = result.value.messages.filter((m) => m.role === "tool");
    expect(toolMessages).toEqual([
      { role: "tool", toolCallId: "call_lookup_object", content: "Opportunity exists" },
      {
        role: "tool",
        toolCallId: "call_list_fields",
        content: "Opportunity: Amount, CloseDate",
      },
    ]);
  });

  it("sends the tool definitions to the model", async () => {
    freshRun();
    const client = fakeLlmClient([says("done")]);

    await runAgentLoop({ client, tools, messages: [{ role: "user", content: "hi" }] });

    expect(client.requests[0]?.tools?.map((t) => t.name)).toEqual([
      "lookup_object",
      "list_fields",
    ]);
  });

  it("terminates at the iteration cap instead of looping forever", async () => {
    freshRun();

    // The fake repeats its last entry, so this model never stops calling tools.
    const client = fakeLlmClient([calls(toolCall("lookup_object", { name: "Account" }))]);

    const result = await runAgentLoop({
      client,
      tools,
      messages: [{ role: "user", content: "go" }],
      maxIterations: 3,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toEqual({ kind: "iteration_cap", iterations: 3 });
    expect(client.callCount).toBe(3);
  });

  it("hands a bad tool argument back to the model, which then succeeds", async () => {
    freshRun();

    const client = fakeLlmClient([
      calls(toolCall("lookup_object", { name: 42 })),
      calls(toolCall("lookup_object", { name: "Lead" })),
      says("Lead exists."),
    ]);

    const result = await runAgentLoop({
      client,
      tools,
      messages: [{ role: "user", content: "check Lead" }],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.content).toBe("Lead exists.");
    // The handler never saw the bad input.
    expect(ran).toEqual(["lookup_object:Lead"]);

    const correction = result.value.messages.find(
      (m) => m.role === "tool" && m.content.startsWith("Error: the arguments"),
    );
    expect(correction).toBeDefined();
  });

  it("gives up after exactly one correction rather than arguing with the model", async () => {
    freshRun();

    const client = fakeLlmClient([calls(toolCall("lookup_object", { name: 42 }))]);

    const result = await runAgentLoop({
      client,
      tools,
      messages: [{ role: "user", content: "go" }],
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.kind).toBe("tool_input_invalid");
    // One correction means two attempts, not eight.
    expect(client.callCount).toBe(2);
  });

  it("lets the model recover from calling a tool that does not exist", async () => {
    freshRun();

    const client = fakeLlmClient([
      calls(toolCall("delete_everything", {})),
      calls(toolCall("lookup_object", { name: "Case" })),
      says("Case exists."),
    ]);

    const result = await runAgentLoop({
      client,
      tools,
      messages: [{ role: "user", content: "go" }],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(ran).toEqual(["lookup_object:Case"]);
  });

  it("fails when our own tool handler throws, without blaming the model", async () => {
    freshRun();

    const broken = defineTool({
      name: "broken",
      description: "always throws",
      input: z.object({}),
      handler: () => {
        throw new Error("the connector is down");
      },
    });

    const client = fakeLlmClient([calls(toolCall("broken", {}))]);

    const result = await runAgentLoop({
      client,
      tools: [broken],
      messages: [{ role: "user", content: "go" }],
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toEqual({
      kind: "tool_failed",
      toolName: "broken",
      message: "the connector is down",
    });
    // No retry: a bug in our code is not something the model can fix.
    expect(client.callCount).toBe(1);
  });

  it("surfaces a model failure as a typed value rather than throwing", async () => {
    freshRun();

    const client = fakeLlmClient([
      {
        ok: false,
        error: { kind: "transport", message: "socket hang up", latencyMs: 12 },
      },
    ]);

    const result = await runAgentLoop({
      client,
      tools,
      messages: [{ role: "user", content: "go" }],
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toEqual({
      kind: "llm",
      error: { kind: "transport", message: "socket hang up", latencyMs: 12 },
    });
  });
});
