import { describe, expect, it } from "vitest";
import type { ExtractedRequirement } from "@veleiro/shared";

import { findContradictions } from "./contradictions";

function requirement(partial: Partial<ExtractedRequirement>): ExtractedRequirement {
  return {
    title: "t",
    description: "d",
    crmObject: null,
    fieldName: null,
    fieldType: null,
    rationale: "r",
    sourceQuote: "q",
    confidence: 0.9,
    ...partial,
  };
}

describe("findContradictions", () => {
  it("flags both sides when one field is claimed with two types", () => {
    const items = [
      requirement({ crmObject: "Opportunity", fieldName: "CloseDate", fieldType: "Date" }),
      requirement({ crmObject: "Opportunity", fieldName: "CloseDate", fieldType: "Text" }),
    ];

    const conflicts = findContradictions(items);

    // Both, and neither resolved in favour of the other.
    expect(conflicts.get(0)).toBe(1);
    expect(conflicts.get(1)).toBe(0);
  });

  it("matches object and field case-insensitively", () => {
    const items = [
      requirement({ crmObject: "Opportunity", fieldName: "CloseDate", fieldType: "Date" }),
      requirement({ crmObject: "opportunity", fieldName: "closedate", fieldType: "Text" }),
    ];

    expect(findContradictions(items).size).toBe(2);
  });

  it("does not flag two requirements that agree on the type", () => {
    const items = [
      requirement({ crmObject: "Opportunity", fieldName: "CloseDate", fieldType: "Date" }),
      requirement({ crmObject: "Opportunity", fieldName: "CloseDate", fieldType: "date" }),
    ];

    expect(findContradictions(items).size).toBe(0);
  });

  it("does not flag the same field name on different objects", () => {
    const items = [
      requirement({ crmObject: "Opportunity", fieldName: "Status", fieldType: "Picklist" }),
      requirement({ crmObject: "Case", fieldName: "Status", fieldType: "Text" }),
    ];

    expect(findContradictions(items).size).toBe(0);
  });

  it("treats an unspecified type as disagreeing with nothing", () => {
    // Null means the model did not say, which is not the same as saying
    // something different.
    const items = [
      requirement({ crmObject: "Opportunity", fieldName: "CloseDate", fieldType: "Date" }),
      requirement({ crmObject: "Opportunity", fieldName: "CloseDate", fieldType: null }),
    ];

    expect(findContradictions(items).size).toBe(0);
  });

  it("ignores requirements that name no field, which cannot conflict on type", () => {
    const items = [
      requirement({ crmObject: "Opportunity", fieldName: null, fieldType: "Date" }),
      requirement({ crmObject: "Opportunity", fieldName: null, fieldType: "Text" }),
    ];

    expect(findContradictions(items).size).toBe(0);
  });

  it("flags every member of a three-way disagreement", () => {
    const items = [
      requirement({ crmObject: "Opportunity", fieldName: "Risk", fieldType: "Picklist" }),
      requirement({ crmObject: "Opportunity", fieldName: "Risk", fieldType: "Text" }),
      requirement({ crmObject: "Opportunity", fieldName: "Risk", fieldType: "Number" }),
    ];

    const conflicts = findContradictions(items);

    expect(conflicts.size).toBe(3);
    // Each links to a sibling that genuinely claims a different type.
    for (const [index, other] of conflicts) {
      expect(items[index]?.fieldType).not.toBe(items[other]?.fieldType);
    }
  });

  it("returns nothing for a single requirement", () => {
    const items = [
      requirement({ crmObject: "Opportunity", fieldName: "CloseDate", fieldType: "Date" }),
    ];

    expect(findContradictions(items).size).toBe(0);
  });
});
