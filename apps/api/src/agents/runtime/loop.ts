import type { LlmClient, LlmMessage, LlmRequest } from "../../llm/types";
import type { AgentResult } from "./errors";
import { toolsByName, type RegisteredTool } from "./tools";

/**
 * The agent loop, written by hand.
 *
 * No framework, on purpose - CLAUDE.md is explicit that writing this is part of
 * the point. It is also small enough to read in one sitting, which is the real
 * argument: every decision about what happens when a model misbehaves is
 * visible here rather than buried in someone else's abstraction.
 *
 * One turn:
 *   1. send the conversation and the tool definitions to the model
 *   2. if the reply has tool calls, run them and append the results, then loop
 *   3. if it has none, that is the final answer
 *   4. never more than `maxIterations` turns
 */

export interface AgentLoopOptions {
  client: LlmClient;
  messages: LlmMessage[];
  tools?: readonly RegisteredTool[];
  /**
   * Hard cap. Exceeding it is a typed failure rather than an infinite loop -
   * a model that keeps calling tools forever is a bug, and on a metered free
   * tier it is an expensive one.
   */
  maxIterations?: number;
  request?: Omit<LlmRequest, "messages" | "tools">;
}

export interface AgentLoopOutcome {
  content: string;
  /** The full conversation including tool traffic, for auditing and debugging. */
  messages: LlmMessage[];
  iterations: number;
}

const DEFAULT_MAX_ITERATIONS = 8;

/**
 * How many times the model is allowed to fix its own mistake for a given tool
 * before the run is abandoned. One: enough to recover from a malformed
 * argument, not enough to burn the token budget arguing with itself.
 */
const MAX_CORRECTIONS_PER_TOOL = 1;

export async function runAgentLoop(
  options: AgentLoopOptions,
): Promise<AgentResult<AgentLoopOutcome>> {
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const tools = options.tools ?? [];
  const registry = toolsByName(tools);
  const wire = tools.map((tool) => tool.wire);
  const available = tools.map((tool) => tool.name);

  const conversation: LlmMessage[] = [...options.messages];
  const corrections = new Map<string, number>();

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    const request: LlmRequest = {
      ...options.request,
      messages: conversation,
      ...(wire.length > 0 ? { tools: wire } : {}),
    };

    const result = await options.client.complete(request);
    if (!result.ok) {
      return { ok: false, error: { kind: "llm", error: result.error } };
    }

    const response = result.value;

    conversation.push(
      response.toolCalls.length > 0
        ? { role: "assistant", content: response.content, toolCalls: response.toolCalls }
        : { role: "assistant", content: response.content },
    );

    if (response.toolCalls.length === 0) {
      return {
        ok: true,
        value: { content: response.content ?? "", messages: conversation, iterations: iteration },
      };
    }

    for (const call of response.toolCalls) {
      const tool = registry.get(call.name);

      if (tool === undefined) {
        // A hallucinated tool name is the same class of mistake as malformed
        // arguments, so it gets the same single chance to be corrected.
        const attempts = (corrections.get(call.name) ?? 0) + 1;
        corrections.set(call.name, attempts);

        if (attempts > MAX_CORRECTIONS_PER_TOOL) {
          return { ok: false, error: { kind: "tool_not_found", toolName: call.name, available } };
        }

        conversation.push({
          role: "tool",
          toolCallId: call.id,
          content:
            `Error: no tool named "${call.name}" exists. ` +
            `Available tools: ${available.join(", ")}. Call one of those instead.`,
        });
        continue;
      }

      const outcome = await tool.run(call.arguments);

      if (outcome.ok) {
        conversation.push({ role: "tool", toolCallId: call.id, content: outcome.content });
        continue;
      }

      if (outcome.reason === "handler_failed") {
        // Our code broke, not the model's output. Handing this back would ask
        // the model to fix a bug it cannot see.
        return {
          ok: false,
          error: { kind: "tool_failed", toolName: call.name, message: outcome.message },
        };
      }

      const attempts = (corrections.get(call.name) ?? 0) + 1;
      corrections.set(call.name, attempts);

      if (attempts > MAX_CORRECTIONS_PER_TOOL) {
        return {
          ok: false,
          error: {
            kind: "tool_input_invalid",
            toolName: call.name,
            issues: outcome.message,
          },
        };
      }

      // The validation error goes back as the tool result, so the model can see
      // exactly what was wrong and try again.
      conversation.push({
        role: "tool",
        toolCallId: call.id,
        content:
          `Error: the arguments did not match the schema for "${call.name}".\n` +
          `${outcome.message}\n` +
          `Call the tool again with corrected arguments.`,
      });
    }
  }

  return { ok: false, error: { kind: "iteration_cap", iterations: maxIterations } };
}
