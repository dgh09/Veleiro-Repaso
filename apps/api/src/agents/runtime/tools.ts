import { z } from "zod";

import type { LlmToolDefinition } from "../../llm/types";

/**
 * The tool registry.
 *
 * Tool input arriving from the model is untrusted text, so it is parsed with
 * Zod before the handler sees it (CLAUDE.md rule 5). A parse failure is an
 * outcome the loop can hand back to the model, not an exception - that is what
 * lets the model correct itself once instead of failing the whole run.
 */

export type ToolRunOutcome =
  | { ok: true; content: string }
  /** The model's arguments were wrong. Recoverable: tell it and let it retry. */
  | { ok: false; reason: "invalid_input"; message: string }
  /** Our own handler blew up. Not the model's fault and not its problem to fix. */
  | { ok: false; reason: "handler_failed"; message: string };

export interface ToolSpec<TInput> {
  name: string;
  description: string;
  input: z.ZodType<TInput>;
  /** Returns the text placed in the tool_result the model reads next. */
  handler: (input: TInput) => Promise<string> | string;
}

/**
 * A tool after its input type has been erased.
 *
 * The loop holds a heterogeneous list of tools, which cannot be typed with a
 * single generic parameter. Rather than reach for `any` - which CLAUDE.md
 * forbids - `defineTool` closes over the typed schema and handler and exposes
 * only `run(rawArguments)`. The type safety happens at the definition site,
 * where it belongs, and the registry stays honest.
 */
export interface RegisteredTool {
  name: string;
  description: string;
  wire: LlmToolDefinition;
  run: (rawArguments: string) => Promise<ToolRunOutcome>;
}

/**
 * Zod 4 emits a `$schema` key that the tools API does not expect, so it is
 * stripped. Verified against the installed zod 4.4.3 rather than assumed.
 */
export function jsonSchemaFor(schema: z.ZodType): Record<string, unknown> {
  const generated: Record<string, unknown> = {
    ...z.toJSONSchema(schema, { io: "input" }),
  };
  delete generated["$schema"];
  return generated;
}

function describeThrown(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function defineTool<TInput>(spec: ToolSpec<TInput>): RegisteredTool {
  return {
    name: spec.name,
    description: spec.description,
    wire: {
      name: spec.name,
      description: spec.description,
      parameters: jsonSchemaFor(spec.input),
    },
    async run(rawArguments: string): Promise<ToolRunOutcome> {
      let parsedJson: unknown;
      try {
        // A tool taking no arguments is commonly called with "" or "{}".
        parsedJson = rawArguments.trim() === "" ? {} : JSON.parse(rawArguments);
      } catch (cause) {
        return {
          ok: false,
          reason: "invalid_input",
          message: `arguments are not valid JSON: ${describeThrown(cause)}`,
        };
      }

      const parsed = spec.input.safeParse(parsedJson);
      if (!parsed.success) {
        return {
          ok: false,
          reason: "invalid_input",
          message: z.prettifyError(parsed.error),
        };
      }

      try {
        return { ok: true, content: await spec.handler(parsed.data) };
      } catch (cause) {
        return {
          ok: false,
          reason: "handler_failed",
          message: describeThrown(cause),
        };
      }
    },
  };
}

export function toolsByName(tools: readonly RegisteredTool[]): Map<string, RegisteredTool> {
  return new Map(tools.map((tool) => [tool.name, tool]));
}
