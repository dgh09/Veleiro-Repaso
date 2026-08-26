import type { ExtractedRequirement } from "@veleiro/shared";

/**
 * Finds requirements from one extraction that contradict each other.
 *
 * SPEC asks for "same object+field, incompatible types or opposite intent".
 * The first half is decidable; the second is not. "Opposite intent" has no
 * deterministic test - deciding that "make close date required" and "let reps
 * save without a close date" conflict is itself a language-understanding
 * judgement, and handing that judgement back to the same model that produced
 * both statements is exactly the move SPEC forbids elsewhere.
 *
 * So this implements the decidable half only: the same CRM object and field
 * claimed with two different data types. That is a genuine conflict a machine
 * can prove, and it is the case that would silently corrupt a config change.
 *
 * Semantic contradiction is deliberately out of scope, and saying so is more
 * honest than shipping a detector that works on the demo transcript and
 * nowhere else. What catches those instead is the human in the approval queue,
 * which is the whole point of the product.
 *
 * Neither side is ever resolved automatically. Both are flagged and linked.
 */

function groupKey(requirement: ExtractedRequirement): string | undefined {
  const object = requirement.crmObject?.trim().toLowerCase();
  const field = requirement.fieldName?.trim().toLowerCase();

  // A requirement that names no object or no field cannot conflict on type.
  if (!object || !field) return undefined;

  return `${object}::${field}`;
}

function normalizedType(requirement: ExtractedRequirement): string | undefined {
  const type = requirement.fieldType?.trim().toLowerCase();
  // Null means "unspecified", which disagrees with nothing.
  return type ? type : undefined;
}

/**
 * Maps a requirement's index to the index of a sibling it conflicts with.
 * Absent from the map means no contradiction was proved.
 */
export function findContradictions(
  requirements: readonly ExtractedRequirement[],
): Map<number, number> {
  const groups = new Map<string, number[]>();

  requirements.forEach((requirement, index) => {
    const key = groupKey(requirement);
    if (key === undefined) return;
    if (normalizedType(requirement) === undefined) return;

    const existing = groups.get(key);
    if (existing) existing.push(index);
    else groups.set(key, [index]);
  });

  const conflicts = new Map<number, number>();

  for (const indices of groups.values()) {
    if (indices.length < 2) continue;

    for (const index of indices) {
      const requirement = requirements[index];
      /* c8 ignore next */
      if (requirement === undefined) continue;

      const type = normalizedType(requirement);

      // Link to the first sibling claiming a different type for the same field.
      const other = indices.find((candidate) => {
        if (candidate === index) return false;
        const sibling = requirements[candidate];
        return sibling !== undefined && normalizedType(sibling) !== type;
      });

      if (other !== undefined) conflicts.set(index, other);
    }
  }

  return conflicts;
}
