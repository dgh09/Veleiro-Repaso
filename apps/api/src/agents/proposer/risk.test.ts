import { describe, expect, it } from "vitest";
import type { ProposalPayload } from "@veleiro/shared";

import { assessRisk } from "./risk";

describe("assessRisk", () => {
  it("rates a brand new object low, because nothing depends on it yet", () => {
    const payload: ProposalPayload = {
      changeType: "create_object",
      objectName: "Renewal__c",
      label: "Renewal",
      description: null,
    };

    expect(assessRisk(payload)).toBe("low");
  });

  it("rates a brand new field low", () => {
    const payload: ProposalPayload = {
      changeType: "create_field",
      objectName: "Opportunity",
      fieldName: "Renewal_Risk__c",
      fieldType: "Picklist",
      label: "Renewal Risk",
      required: false,
      picklistValues: ["Low", "Medium", "High"],
    };

    expect(assessRisk(payload)).toBe("low");
  });

  it("rates a validation rule at least medium, as SPEC requires", () => {
    const payload: ProposalPayload = {
      changeType: "create_validation_rule",
      objectName: "Opportunity",
      ruleName: "Close_Date_Required",
      condition: "ISBLANK(CloseDate)",
      errorMessage: "Close date is required",
    };

    expect(assessRisk(payload)).toBe("medium");
  });

  it("rates touching an existing field medium when the type is left alone", () => {
    const payload: ProposalPayload = {
      changeType: "update_field",
      objectName: "Opportunity",
      fieldName: "CloseDate",
      newFieldType: null,
      newRequired: true,
      newLabel: null,
      newPicklistValues: null,
    };

    expect(assessRisk(payload)).toBe("medium");
  });

  it("rates a type change high, because existing values cannot survive it", () => {
    const payload: ProposalPayload = {
      changeType: "update_field",
      objectName: "Opportunity",
      fieldName: "CloseDate",
      newFieldType: "Text",
      newRequired: null,
      newLabel: null,
      newPicklistValues: null,
    };

    expect(assessRisk(payload)).toBe("high");
  });

  it("depends only on the payload, so a model cannot influence it", () => {
    // The same change described with alarming or reassuring prose scores
    // identically, because no prose reaches this function at all.
    const reassuring: ProposalPayload = {
      changeType: "update_field",
      objectName: "Opportunity",
      fieldName: "Amount",
      newFieldType: "Text",
      newRequired: null,
      newLabel: "Totally safe cosmetic tweak",
      newPicklistValues: null,
    };

    expect(assessRisk(reassuring)).toBe("high");
  });
});
