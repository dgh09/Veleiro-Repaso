import { describeLlmFailure, type LlmFailure } from "../../llm/types";

/**
 * Everything the runtime can fail at, as a value.
 *
 * CLAUDE.md: errors are values at boundaries, not exceptions that escape to a
 * 500. An agent run that hits its iteration cap, or a model that will not
 * produce parseable JSON, are expected outcomes of talking to a language model
 * - the caller has to handle them, so the type makes them impossible to ignore.
 */
export type AgentFailure =
  | { kind: "llm"; error: LlmFailure }
  | { kind: "iteration_cap"; iterations: number }
  | { kind: "tool_not_found"; toolName: string; available: string[] }
  | { kind: "tool_input_invalid"; toolName: string; issues: string }
  | { kind: "tool_failed"; toolName: string; message: string }
  | { kind: "unparsable_output"; message: string; raw: string }
  | { kind: "schema_mismatch"; issues: string; raw: string };

export type AgentResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: AgentFailure };

export function describeAgentFailure(failure: AgentFailure): string {
  switch (failure.kind) {
    case "llm":
      return describeLlmFailure(failure.error);
    case "iteration_cap":
      return `the agent loop hit its cap of ${failure.iterations} iterations without a final answer`;
    case "tool_not_found":
      return `the model called an unknown tool "${failure.toolName}" (available: ${failure.available.join(", ")})`;
    case "tool_input_invalid":
      return `the model could not produce valid input for tool "${failure.toolName}": ${failure.issues}`;
    case "tool_failed":
      return `tool "${failure.toolName}" failed: ${failure.message}`;
    case "unparsable_output":
      return `the model did not return parseable JSON: ${failure.message}`;
    case "schema_mismatch":
      return `the model returned JSON that does not match the schema: ${failure.issues}`;
  }
}
