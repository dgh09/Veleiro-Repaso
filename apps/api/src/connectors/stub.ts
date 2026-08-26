import { randomUUID } from "node:crypto";

import type { ProposalPayload } from "@veleiro/shared";

import type { ApplyResult, CrmConnector } from "./types";

/**
 * The local stand-in for a CRM.
 *
 * It logs what it would have done and reports success. What it does not do is
 * matter to the rest of the system: everything upstream treats it as an
 * external service that can fail, so replacing it with something real changes
 * no calling code.
 *
 * SPEC asks for "deterministic failure for a payload flagged as a test failure
 * case". The flag is the prefix below on any name in the payload. That keeps
 * the failure path exercisable end to end - through the HTTP endpoint, with a
 * real proposal row - without a mock, which matters because the thing being
 * tested is that a failed apply leaves the proposal recoverable rather than
 * lost.
 */
export const FAILURE_PREFIX = "FAIL_";

function namesIn(payload: ProposalPayload): string[] {
  switch (payload.changeType) {
    case "create_object":
      return [payload.objectName, payload.label];
    case "create_field":
      return [payload.objectName, payload.fieldName, payload.label];
    case "create_validation_rule":
      return [payload.objectName, payload.ruleName];
    case "update_field":
      return [payload.objectName, payload.fieldName];
  }
}

function describe(payload: ProposalPayload): string {
  switch (payload.changeType) {
    case "create_object":
      return `create object ${payload.objectName}`;
    case "create_field":
      return `create field ${payload.objectName}.${payload.fieldName} (${payload.fieldType})`;
    case "create_validation_rule":
      return `create validation rule ${payload.ruleName} on ${payload.objectName}`;
    case "update_field":
      return `update field ${payload.objectName}.${payload.fieldName}`;
  }
}

export function createStubConnector(): CrmConnector {
  return {
    async apply(payload: ProposalPayload): Promise<ApplyResult> {
      const action = describe(payload);

      if (namesIn(payload).some((name) => name.startsWith(FAILURE_PREFIX))) {
        console.warn(`[connector] refused: ${action}`);
        return {
          ok: false,
          error: `The CRM rejected ${action}: name is reserved`,
        };
      }

      console.log(`[connector] applied: ${action}`);
      return {
        ok: true,
        externalId: `stub-${randomUUID()}`,
        details: action,
      };
    },
  };
}
