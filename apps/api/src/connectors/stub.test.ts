import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProposalPayload } from "@veleiro/shared";

import { createStubConnector, FAILURE_PREFIX } from "./stub";

const connector = createStubConnector();

const CREATE_FIELD: ProposalPayload = {
  changeType: "create_field",
  objectName: "Opportunity",
  fieldName: "Renewal_Risk__c",
  fieldType: "Picklist",
  label: "Renewal Risk",
  required: false,
  picklistValues: ["Low", "High"],
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the stub connector", () => {
  it("applies a change and returns an external id", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});

    const result = await connector.apply(CREATE_FIELD);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.externalId).toMatch(/^stub-/);
    expect(result.details).toContain("Opportunity.Renewal_Risk__c");
  });

  it("fails deterministically for a flagged payload, so the failure path is testable", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await connector.apply({
      ...CREATE_FIELD,
      fieldName: `${FAILURE_PREFIX}Renewal_Risk__c`,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toContain("reserved");
  });

  it("returns a failure rather than throwing, so the caller can record it", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});

    // A connector that threw would escape to a 500 and lose the proposal.
    await expect(
      connector.apply({
        changeType: "create_object",
        objectName: `${FAILURE_PREFIX}Thing__c`,
        label: "Thing",
        description: null,
      }),
    ).resolves.toMatchObject({ ok: false });
  });

  it("describes every change type it can be handed", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});

    const payloads: ProposalPayload[] = [
      { changeType: "create_object", objectName: "A__c", label: "A", description: null },
      CREATE_FIELD,
      {
        changeType: "create_validation_rule",
        objectName: "Opportunity",
        ruleName: "R",
        condition: "ISBLANK(CloseDate)",
        errorMessage: "nope",
      },
      {
        changeType: "update_field",
        objectName: "Opportunity",
        fieldName: "Amount",
        newFieldType: "Text",
        newRequired: null,
        newLabel: null,
        newPicklistValues: null,
      },
    ];

    for (const payload of payloads) {
      const result = await connector.apply(payload);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      expect(result.details.length).toBeGreaterThan(0);
    }
  });
});
