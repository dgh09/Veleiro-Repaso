import { z } from "zod";

/**
 * Enum values are declared once, here, as `as const` tuples. Drizzle's
 * `pgEnum` and Zod's `z.enum` both consume these tuples, so the Postgres type
 * and the runtime validator cannot drift apart - which is the whole point of
 * CLAUDE.md's rule that a shape is defined in exactly one place.
 */

export const REQUIREMENT_STATUS = [
  "extracted",
  "needs_review",
  "proposed",
  "discarded",
] as const;
export const RequirementStatusSchema = z.enum(REQUIREMENT_STATUS);
export type RequirementStatus = z.infer<typeof RequirementStatusSchema>;

export const PROPOSAL_STATUS = [
  "pending",
  "approved",
  "rejected",
  "applied",
  "failed",
] as const;
export const ProposalStatusSchema = z.enum(PROPOSAL_STATUS);
export type ProposalStatus = z.infer<typeof ProposalStatusSchema>;

export const RISK_LEVEL = ["low", "medium", "high"] as const;
export const RiskLevelSchema = z.enum(RISK_LEVEL);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

export const ACTOR_TYPE = ["user", "agent"] as const;
export const ActorTypeSchema = z.enum(ACTOR_TYPE);
export type ActorType = z.infer<typeof ActorTypeSchema>;

export const CHANGE_TYPE = [
  "create_object",
  "create_field",
  "create_validation_rule",
  "update_field",
] as const;
export const ChangeTypeSchema = z.enum(CHANGE_TYPE);
export type ChangeType = z.infer<typeof ChangeTypeSchema>;
