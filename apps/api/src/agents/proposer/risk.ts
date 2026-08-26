import type { ProposalPayload, RiskLevel } from "@veleiro/shared";

/**
 * Risk is assigned by rule, never by the model.
 *
 * SPEC insists on this and it is worth saying why: risk is the number a human
 * uses to decide how much attention a proposal deserves. A model that assigns
 * its own risk is grading its own homework, and the failure mode is silent -
 * a confidently-worded "low risk" on a change that drops a column reads
 * exactly like a correct one. A rule can be audited, argued with, and unit
 * tested. A model's opinion cannot.
 *
 * The rules, from SPEC:
 * - touching an existing field, or adding a validation rule, is at least medium
 * - a type change is high
 *
 * SPEC also names deletions as high. There is no deletion in the `change_type`
 * enum, so nothing here can express one; if a delete type is ever added it
 * belongs in the `high` branch and this comment is the reminder.
 */
export function assessRisk(payload: ProposalPayload): RiskLevel {
  switch (payload.changeType) {
    case "create_object":
    case "create_field":
      // Net-new metadata. There is no existing configuration to break, and
      // nothing already in the database depends on it yet.
      return "low";

    case "create_validation_rule":
      // Nothing is lost, but every future save on that object has to satisfy
      // it - including saves by integrations nobody thought to check.
      return "medium";

    case "update_field":
      // Retyping a field is the destructive case: existing values have to be
      // coerced or dropped, and that is not reversible by editing metadata back.
      return payload.newFieldType === null ? "medium" : "high";
  }
}
