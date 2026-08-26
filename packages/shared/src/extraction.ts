import { z } from "zod";

/**
 * What the Extractor is allowed to return.
 *
 * This is the only definition of the shape. The prompt is generated from it,
 * the model's reply is parsed against it, and the database row is built from
 * the parsed value - so the prompt cannot drift from the validator the way a
 * hand-written "return JSON like this: ..." example always eventually does.
 *
 * Nullable rather than optional throughout: models are markedly better at
 * emitting `"fieldName": null` than at omitting a key, and a null reads the
 * same as the column it lands in.
 */
export const ExtractedRequirementSchema = z.object({
  title: z.string().min(1).max(200).describe("Short imperative summary of the change"),
  description: z
    .string()
    .min(1)
    .describe("What the client needs, in one or two sentences"),

  crmObject: z
    .string()
    .min(1)
    .nullable()
    .describe("The CRM object this touches, e.g. Opportunity. Null if not applicable."),
  fieldName: z
    .string()
    .min(1)
    .nullable()
    .describe("The field this touches, e.g. CloseDate. Null if not a field change."),
  fieldType: z
    .string()
    .min(1)
    .nullable()
    .describe("The field data type, e.g. Date, Picklist, Currency. Null if not a field."),

  rationale: z.string().min(1).describe("Why this is a requirement, from the discussion"),

  sourceQuote: z
    .string()
    .min(1)
    .describe("A span copied verbatim from the transcript that evidences this requirement"),

  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe("0.0 to 1.0. How certain the transcript actually asks for this."),
});

export type ExtractedRequirement = z.infer<typeof ExtractedRequirementSchema>;

export const ExtractionResultSchema = z.object({
  requirements: z.array(ExtractedRequirementSchema),
});

export type ExtractionResult = z.infer<typeof ExtractionResultSchema>;

/**
 * Why a requirement was routed to `needs_review`.
 *
 * These are assigned by code after the model has answered, never by the model
 * itself - a model asked to grade its own evidence will say it is fine.
 */
export const REVIEW_REASON = [
  "quote_not_found",
  "low_confidence",
  "contradiction",
] as const;
export const ReviewReasonSchema = z.enum(REVIEW_REASON);
export type ReviewReason = z.infer<typeof ReviewReasonSchema>;

/** Below this, an extraction is a suggestion rather than a finding. SPEC sets it. */
export const CONFIDENCE_THRESHOLD = 0.6;
