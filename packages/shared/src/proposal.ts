import { z } from "zod";

/**
 * The machine-applicable metadata a connector would receive.
 *
 * SPEC is emphatic that this is not prose: "add a close date field" is a
 * sentence, not a change. Everything here is a value a connector could act on
 * without interpreting English, which is what makes the approval queue show a
 * real diff in Phase 5 rather than a paragraph.
 *
 * `changeType` is the discriminator and lives inside the payload, so the
 * `proposals.change_type` column is derived from the payload rather than
 * tracked alongside it and allowed to disagree with it.
 */

export const CreateObjectPayloadSchema = z.object({
  changeType: z.literal("create_object"),
  objectName: z.string().min(1).describe("API name, e.g. Renewal__c"),
  label: z.string().min(1).describe("Human-readable label"),
  description: z.string().nullable(),
});

export const CreateFieldPayloadSchema = z.object({
  changeType: z.literal("create_field"),
  objectName: z.string().min(1).describe("Object the field goes on, e.g. Opportunity"),
  fieldName: z.string().min(1).describe("API name, e.g. Renewal_Risk__c"),
  fieldType: z.string().min(1).describe("e.g. Date, Text, Currency, Picklist"),
  label: z.string().min(1),
  required: z.boolean(),
  picklistValues: z
    .array(z.string().min(1))
    .nullable()
    .describe("Only for Picklist fields; null otherwise"),
});

export const CreateValidationRulePayloadSchema = z.object({
  changeType: z.literal("create_validation_rule"),
  objectName: z.string().min(1),
  ruleName: z.string().min(1),
  condition: z
    .string()
    .min(1)
    .describe("The formula that must be false for the record to save"),
  errorMessage: z.string().min(1).describe("Shown to the user when the rule fires"),
});

/**
 * Null on a change means "leave this alone". An update that changes nothing is
 * still valid here and is caught as a low-value proposal by the human, not by
 * a schema rule that would be guessing.
 */
export const UpdateFieldPayloadSchema = z.object({
  changeType: z.literal("update_field"),
  objectName: z.string().min(1),
  fieldName: z.string().min(1),
  newFieldType: z.string().min(1).nullable(),
  newRequired: z.boolean().nullable(),
  newLabel: z.string().min(1).nullable(),
  newPicklistValues: z.array(z.string().min(1)).nullable(),
});

export const ProposalPayloadSchema = z.discriminatedUnion("changeType", [
  CreateObjectPayloadSchema,
  CreateFieldPayloadSchema,
  CreateValidationRulePayloadSchema,
  UpdateFieldPayloadSchema,
]);

export type ProposalPayload = z.infer<typeof ProposalPayloadSchema>;

/**
 * What the Proposer model is asked to return. Wrapped in an object rather than
 * being a bare union, because a top-level `anyOf` is a needlessly awkward thing
 * to put in front of a model.
 */
export const ProposalDraftSchema = z.object({
  payload: ProposalPayloadSchema,
});

export type ProposalDraft = z.infer<typeof ProposalDraftSchema>;

/** Body of POST /api/proposals/:id/reject. The reason is the point of it. */
export const RejectProposalSchema = z.object({
  rejectionReason: z
    .string()
    .trim()
    .min(1, "A rejection reason is required"),
});

export type RejectProposal = z.infer<typeof RejectProposalSchema>;
