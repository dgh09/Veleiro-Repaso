import type { ProposalPayload } from "@veleiro/shared";

/**
 * The seam where this system would meet a real CRM.
 *
 * It is an interface with a stub behind it because CLAUDE.md puts a real
 * Salesforce connector out of scope, and because the interesting property is
 * architectural rather than integrational: the agent has no reference to this
 * at all. Only the human-triggered approval path calls it. Swapping the stub
 * for a real implementation changes one line of wiring and no agent code.
 */

export type ApplyResult =
  | { ok: true; externalId: string; details: string }
  | { ok: false; error: string };

export interface CrmConnector {
  /**
   * Applies one approved change. Returns a result rather than throwing: a
   * connector failure is an expected outcome that has to be recorded against
   * the proposal, not an exception that escapes to a 500.
   */
  apply(payload: ProposalPayload): Promise<ApplyResult>;
}
