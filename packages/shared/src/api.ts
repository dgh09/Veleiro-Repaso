import { z } from "zod";

import {
  ActorTypeSchema,
  ChangeTypeSchema,
  ProposalStatusSchema,
  RequirementStatusSchema,
  RiskLevelSchema,
} from "./enums";
import { ProposalPayloadSchema } from "./proposal";

/**
 * The shapes the API actually puts on the wire, so the web app parses what it
 * receives instead of asserting a type onto it.
 *
 * Timestamps are strings here, not Dates: JSON has no date type, and modelling
 * them as what arrives rather than what the database holds is the difference
 * between a schema that validates and one that always fails. The web app turns
 * them back into Dates at the point of display.
 */
const isoTimestamp = z.string().min(1);

export const ProjectResponseSchema = z.object({
  id: z.uuid(),
  tenantId: z.uuid(),
  name: z.string(),
  clientName: z.string(),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
});
export type ProjectResponse = z.infer<typeof ProjectResponseSchema>;

export const TranscriptResponseSchema = z.object({
  id: z.uuid(),
  tenantId: z.uuid(),
  projectId: z.uuid(),
  title: z.string(),
  content: z.string(),
  meetingDate: isoTimestamp.nullable(),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
});
export type TranscriptResponse = z.infer<typeof TranscriptResponseSchema>;

export const RequirementResponseSchema = z.object({
  id: z.uuid(),
  tenantId: z.uuid(),
  projectId: z.uuid(),
  transcriptId: z.uuid(),
  title: z.string(),
  description: z.string(),
  crmObject: z.string().nullable(),
  fieldName: z.string().nullable(),
  fieldType: z.string().nullable(),
  rationale: z.string(),
  sourceQuote: z.string(),
  sourceQuoteStart: z.number().int().nullable(),
  sourceQuoteEnd: z.number().int().nullable(),
  confidence: z.number(),
  status: RequirementStatusSchema,
  reviewReason: z.string().nullable(),
  relatedRequirementId: z.uuid().nullable(),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
});
export type RequirementResponse = z.infer<typeof RequirementResponseSchema>;

export const ProposalResponseSchema = z.object({
  id: z.uuid(),
  tenantId: z.uuid(),
  requirementId: z.uuid(),
  changeType: ChangeTypeSchema,
  payload: ProposalPayloadSchema,
  riskLevel: RiskLevelSchema,
  status: ProposalStatusSchema,
  reviewedBy: z.uuid().nullable(),
  reviewedAt: isoTimestamp.nullable(),
  rejectionReason: z.string().nullable(),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
});
export type ProposalResponse = z.infer<typeof ProposalResponseSchema>;

export const AuditEntryResponseSchema = z.object({
  id: z.uuid(),
  tenantId: z.uuid(),
  actorType: ActorTypeSchema,
  actorId: z.string(),
  action: z.string(),
  entityType: z.string(),
  entityId: z.uuid(),
  // Shapes vary by action, so these stay unknown and are rendered as data.
  before: z.unknown(),
  after: z.unknown(),
  createdAt: isoTimestamp,
});
export type AuditEntryResponse = z.infer<typeof AuditEntryResponseSchema>;

/** POST /api/projects/:id/transcripts */
export const CreateTranscriptSchema = z.object({
  title: z.string().trim().min(1, "A title is required"),
  content: z.string().trim().min(1, "The transcript cannot be empty"),
  meetingDate: isoTimestamp.nullable().optional(),
});
export type CreateTranscript = z.infer<typeof CreateTranscriptSchema>;

export const ExtractResponseSchema = z.object({
  requirements: z.array(RequirementResponseSchema),
});

export const ProposeResponseSchema = z.object({
  proposal: ProposalResponseSchema,
});

export const ApproveResponseSchema = z.object({
  proposal: ProposalResponseSchema,
  applied: z.boolean(),
  alreadySettled: z.boolean(),
  externalId: z.string().optional(),
  error: z.string().optional(),
});
export type ApproveResponse = z.infer<typeof ApproveResponseSchema>;

export const RejectResponseSchema = z.object({
  proposal: ProposalResponseSchema,
});

/** Every error body the API produces has this shape. */
export const ApiErrorSchema = z.object({ error: z.string() });
