import { z } from "zod";

/**
 * The shape of a golden-dataset case.
 *
 * This schema lives here rather than in @veleiro/shared because it is not an
 * api/web boundary - nothing outside the harness reads it. CLAUDE.md's rule is
 * that shapes crossing between packages have one definition; this one does not
 * cross.
 *
 * It is still parsed rather than trusted. A dataset is ground truth, and a
 * typo in ground truth silently changes every score computed against it.
 */

export const ADVERSARIAL_KIND = [
  /** The client states two incompatible things about the same field. */
  "contradiction",
  /** An essential detail is never given; inventing one is the failure. */
  "missing_detail",
  /** A long off-topic passage that must not become a requirement. */
  "tangent",
  /** The transcript contains a sentence aimed at the model. */
  "injection",
] as const;

export const AdversarialKindSchema = z.enum(ADVERSARIAL_KIND);
export type AdversarialKind = z.infer<typeof AdversarialKindSchema>;

/**
 * Ground truth is matched on object + field, as SPEC specifies. Titles and
 * wording are the model's to choose; what it must get right is which piece of
 * configuration the client asked for.
 */
export const ExpectedRequirementSchema = z.object({
  crmObject: z.string().nullable(),
  fieldName: z.string().nullable(),
  /**
   * Other names that are equally correct answers for this requirement.
   *
   * "An account owner field on the account" is satisfied by `Owner` or by
   * `AccountOwner`; a reviewer would accept either, and the model picks
   * differently between runs. Without this the metric would swing on a coin
   * flip that has nothing to do with extraction quality.
   *
   * The rule for adding one: it must be a name a reviewer would accept having
   * read only the transcript. An alias added because the model happened to
   * produce it, and only for that reason, is score inflation - it moves the
   * ground truth to wherever the model landed and the number stops meaning
   * anything.
   */
  alsoAcceptFieldNames: z.array(z.string()).optional(),
  /** Why a human says this belongs in the answer. Not scored; read by people. */
  note: z.string(),
});
export type ExpectedRequirement = z.infer<typeof ExpectedRequirementSchema>;

export const EvalCaseSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  adversarial: AdversarialKindSchema.nullable(),
  transcript: z.string().min(1),
  expected: z.array(ExpectedRequirementSchema),
  /**
   * Whether at least one extracted item should end up in `needs_review`.
   *
   * True for adversarial cases, false for clean ones - a clean transcript that
   * produces a flag is a false alarm, and false alarms are how a review queue
   * stops being read.
   */
  expectFlagged: z.boolean(),
  /** Free text for anything a reader of the dataset needs to know. */
  notes: z.string().optional(),
});
export type EvalCase = z.infer<typeof EvalCaseSchema>;
