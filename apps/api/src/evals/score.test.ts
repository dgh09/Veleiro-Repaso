import { describe, expect, it } from "vitest";

import type { Requirement } from "../db/repositories/requirements";
import { aggregate, scoreCase } from "./score";
import type { EvalCase } from "./schema";

/**
 * The scoring is the one part of the harness where a bug is invisible: a wrong
 * number still prints, still goes in a report, and still gets compared against
 * the next run. So it is tested against cases with hand-computed answers.
 */

function extracted(
  partial: Partial<Requirement> & Pick<Requirement, "crmObject" | "fieldName">,
): Requirement {
  return {
    id: "00000000-0000-4000-8000-000000000000",
    tenantId: "00000000-0000-4000-8000-000000000000",
    projectId: "00000000-0000-4000-8000-000000000000",
    transcriptId: "00000000-0000-4000-8000-000000000000",
    title: "t",
    description: "d",
    fieldType: null,
    rationale: "r",
    sourceQuote: "q",
    sourceQuoteStart: null,
    sourceQuoteEnd: null,
    confidence: 0.9,
    status: "extracted",
    reviewReason: null,
    relatedRequirementId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...partial,
  } as Requirement;
}

function evalCase(partial: Partial<EvalCase>): EvalCase {
  return {
    id: "c",
    title: "t",
    adversarial: null,
    transcript: "x",
    expected: [],
    expectFlagged: false,
    ...partial,
  };
}

describe("scoreCase", () => {
  it("counts a clean match", () => {
    const score = scoreCase(
      evalCase({
        expected: [{ crmObject: "Opportunity", fieldName: "CloseDate", note: "" }],
      }),
      [extracted({ crmObject: "Opportunity", fieldName: "CloseDate" })],
    );

    expect(score).toMatchObject({ truePositives: 1, falsePositives: 0, falseNegatives: 0 });
  });

  it("matches on object and field regardless of case and spacing", () => {
    const score = scoreCase(
      evalCase({
        expected: [{ crmObject: "Opportunity", fieldName: "CloseDate", note: "" }],
      }),
      [extracted({ crmObject: " opportunity ", fieldName: "closedate" })],
    );

    expect(score.truePositives).toBe(1);
  });

  it("ignores naming convention, which is style rather than accuracy", () => {
    // Every one of these was a real miss in the harness's first run: the model
    // had found the right field and was marked wrong for its casing.
    const conventions = ["SLA_Due_Date", "sla due date", "SLADueDate", "Sla_Due_Date__c"];

    for (const fieldName of conventions) {
      const score = scoreCase(
        evalCase({ expected: [{ crmObject: "Case", fieldName: "SlaDueDate", note: "" }] }),
        [extracted({ crmObject: "Case", fieldName })],
      );

      expect(score.truePositives, `should have matched ${fieldName}`).toBe(1);
    }
  });

  it("still separates genuinely different fields", () => {
    // Normalisation must not become a wildcard: LossReason and LostReason are
    // different names, not different spellings of one name.
    const score = scoreCase(
      evalCase({ expected: [{ crmObject: "Opportunity", fieldName: "LossReason", note: "" }] }),
      [extracted({ crmObject: "Opportunity", fieldName: "Lost_Reason__c" })],
    );

    expect(score.truePositives).toBe(0);
  });

  it("counts an unexpected extraction as a false positive", () => {
    const score = scoreCase(
      evalCase({ expected: [] }),
      [extracted({ crmObject: "Account", fieldName: "Invented" })],
    );

    expect(score).toMatchObject({ truePositives: 0, falsePositives: 1, falseNegatives: 0 });
  });

  it("counts a missed requirement as a false negative", () => {
    const score = scoreCase(
      evalCase({ expected: [{ crmObject: "Lead", fieldName: "Source", note: "" }] }),
      [],
    );

    expect(score).toMatchObject({ truePositives: 0, falsePositives: 0, falseNegatives: 1 });
  });

  it("requires both halves of a contradiction, not just one", () => {
    // The case that motivates multiset matching. A set intersection would score
    // returning one of two incompatible statements as a perfect answer, and
    // picking a winner is precisely what the extractor must not do.
    const contradiction = evalCase({
      adversarial: "contradiction",
      expectFlagged: true,
      expected: [
        { crmObject: "Case", fieldName: "Priority", note: "as picklist" },
        { crmObject: "Case", fieldName: "Priority", note: "as number" },
      ],
    });

    const onlyOne = scoreCase(contradiction, [
      extracted({ crmObject: "Case", fieldName: "Priority" }),
    ]);
    expect(onlyOne).toMatchObject({ truePositives: 1, falseNegatives: 1 });

    const both = scoreCase(contradiction, [
      extracted({ crmObject: "Case", fieldName: "Priority" }),
      extracted({ crmObject: "Case", fieldName: "Priority" }),
    ]);
    expect(both).toMatchObject({ truePositives: 2, falseNegatives: 0, falsePositives: 0 });
  });

  it("treats a null object or field as a matchable value, not a wildcard", () => {
    const score = scoreCase(
      evalCase({ expected: [{ crmObject: "Quote", fieldName: null, note: "" }] }),
      [extracted({ crmObject: "Quote", fieldName: null })],
    );
    expect(score.truePositives).toBe(1);

    const mismatch = scoreCase(
      evalCase({ expected: [{ crmObject: "Quote", fieldName: null, note: "" }] }),
      [extracted({ crmObject: "Quote", fieldName: "Discount" })],
    );
    expect(mismatch.truePositives).toBe(0);
  });

  it("counts hallucinated quotes from the review reason the extractor recorded", () => {
    const score = scoreCase(evalCase({ expected: [] }), [
      extracted({
        crmObject: "A",
        fieldName: "B",
        status: "needs_review",
        reviewReason: "quote_not_found,low_confidence",
      }),
    ]);

    expect(score.hallucinatedQuotes).toBe(1);
    expect(score.actuallyFlagged).toBe(true);
  });

  it("marks flagging correct only when it matches what the case expects", () => {
    const shouldFlag = evalCase({ adversarial: "contradiction", expectFlagged: true });

    expect(scoreCase(shouldFlag, [extracted({ crmObject: "A", fieldName: "B" })]).flaggingCorrect).toBe(
      false,
    );

    expect(
      scoreCase(shouldFlag, [
        extracted({ crmObject: "A", fieldName: "B", status: "needs_review" }),
      ]).flaggingCorrect,
    ).toBe(true);
  });

  it("scores an agent failure as zero recall rather than skipping it", () => {
    const score = scoreCase(
      evalCase({ expected: [{ crmObject: "Lead", fieldName: "Source", note: "" }] }),
      [],
      "transport: socket hang up",
    );

    expect(score.failure).toBe("transport: socket hang up");
    expect(score.falseNegatives).toBe(1);
  });
});

describe("aggregate", () => {
  it("computes precision, recall and f1 over every case", () => {
    const scores = [
      scoreCase(
        evalCase({ expected: [{ crmObject: "A", fieldName: "B", note: "" }] }),
        [extracted({ crmObject: "A", fieldName: "B" })],
      ),
      scoreCase(
        evalCase({ expected: [{ crmObject: "C", fieldName: "D", note: "" }] }),
        [extracted({ crmObject: "X", fieldName: "Y" })],
      ),
    ];

    const totals = aggregate(scores);

    // 1 tp, 1 fp, 1 fn -> precision 0.5, recall 0.5, f1 0.5
    expect(totals.precision).toBeCloseTo(0.5);
    expect(totals.recall).toBeCloseTo(0.5);
    expect(totals.f1).toBeCloseTo(0.5);
  });

  it("separates adversarial flagging from false alarms on clean cases", () => {
    const scores = [
      // Adversarial, correctly flagged.
      scoreCase(
        evalCase({ adversarial: "contradiction", expectFlagged: true, expected: [] }),
        [extracted({ crmObject: "A", fieldName: "B", status: "needs_review" })],
      ),
      // Adversarial, missed.
      scoreCase(
        evalCase({ adversarial: "tangent", expectFlagged: true, expected: [] }),
        [extracted({ crmObject: "A", fieldName: "B" })],
      ),
      // Clean, but flagged anyway.
      scoreCase(evalCase({ expected: [] }), [
        extracted({ crmObject: "A", fieldName: "B", status: "needs_review" }),
      ]),
      // Clean and quiet.
      scoreCase(evalCase({ expected: [] }), [extracted({ crmObject: "A", fieldName: "B" })]),
    ];

    const totals = aggregate(scores);

    expect(totals.adversarialFlaggingAccuracy).toBeCloseTo(0.5);
    // Kept separate on purpose: a system that flags everything would score
    // perfectly on the first number and terribly on this one.
    expect(totals.flagsOnCleanCasesRate).toBeCloseTo(0.5);
  });

  it("accepts any name the ground truth says is equally correct", () => {
    const withAlias = evalCase({
      expected: [
        {
          crmObject: "Account",
          fieldName: "Owner",
          alsoAcceptFieldNames: ["AccountOwner", "Account Owner"],
          note: "",
        },
      ],
    });

    for (const fieldName of ["Owner", "AccountOwner", "Account Owner", "account_owner"]) {
      expect(
        scoreCase(withAlias, [extracted({ crmObject: "Account", fieldName })]).truePositives,
        `should have accepted ${fieldName}`,
      ).toBe(1);
    }

    // An alias list is not a free pass for any name at all.
    expect(
      scoreCase(withAlias, [extracted({ crmObject: "Account", fieldName: "Manager" })])
        .truePositives,
    ).toBe(0);
  });

  it("does not pay twice for the same extraction", () => {
    const score = scoreCase(
      evalCase({ expected: [{ crmObject: "A", fieldName: "B", note: "" }] }),
      [extracted({ crmObject: "A", fieldName: "B" }), extracted({ crmObject: "A", fieldName: "B" })],
    );

    // One credit, and the duplicate counts against precision.
    expect(score).toMatchObject({ truePositives: 1, falsePositives: 1 });
  });

  it("reports zero rather than NaN when there is nothing to score", () => {
    const totals = aggregate([]);

    expect(totals.precision).toBe(0);
    expect(totals.f1).toBe(0);
    expect(totals.adversarialFlaggingAccuracy).toBe(0);
  });
});
