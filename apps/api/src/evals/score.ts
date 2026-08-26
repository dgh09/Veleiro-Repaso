import type { Requirement } from "../db/repositories/requirements";
import type { AdversarialKind, EvalCase, ExpectedRequirement } from "./schema";

/**
 * Turning one extraction into numbers.
 *
 * SPEC fixes the matching rule: requirements are matched on object + field.
 * Titles, descriptions and rationales are the model's to word however it likes;
 * what it has to get right is which piece of configuration the client asked
 * for. Scoring on wording would measure prose style and call it accuracy.
 */

/**
 * Names are compared with formatting removed, not literally.
 *
 * The first run of this harness scored 55% precision, and almost all of the
 * misses were `SLA_Due_Date` against `SlaDueDate`, `Lead Source` against
 * `LeadSource`, `Loss_Reason__c` against `LossReason`. The model had found the
 * right field every time and the harness was marking it wrong for choosing a
 * different casing convention.
 *
 * That is the failure this file's own header warns about - measuring style and
 * calling it accuracy. Separators, capitalisation and the Salesforce `__c`
 * custom-object suffix are conventions, not content, so they come out before
 * the comparison. What survives is which field the model picked.
 */
function normalizeName(value: string | null): string {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/__c$/, "")
    .replace(/[^a-z0-9]/g, "");
}

function key(crmObject: string | null, fieldName: string | null): string {
  return `${normalizeName(crmObject)}::${normalizeName(fieldName)}`;
}

/** Every key that would count as finding this expected requirement. */
function acceptableKeys(expected: ExpectedRequirement): Set<string> {
  const names = [expected.fieldName, ...(expected.alsoAcceptFieldNames ?? [])];
  return new Set(names.map((name) => key(expected.crmObject, name)));
}

export interface CaseScore {
  id: string;
  adversarial: AdversarialKind | null;
  /** Set when the agent itself failed; the case then counts as zero recall. */
  failure: string | null;

  expected: number;
  extracted: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;

  hallucinatedQuotes: number;

  expectFlagged: boolean;
  actuallyFlagged: boolean;
  flaggingCorrect: boolean;
}

/**
 * Matching is a 1:1 assignment over the multiset of keys, not a set
 * intersection.
 *
 * The difference matters for the contradiction cases, where the correct answer
 * genuinely contains the same object+field twice - the model is supposed to
 * return both of the client's incompatible statements rather than pick one. A
 * set intersection would score returning one of them as a perfect answer, which
 * is exactly the behaviour those cases exist to catch.
 */
export function scoreCase(
  evalCase: EvalCase,
  extracted: Requirement[],
  failure: string | null = null,
): CaseScore {
  // Greedy 1:1 assignment. Each extracted item can satisfy at most one expected
  // requirement and vice versa, so returning the same field twice does not earn
  // two credits - and the contradiction cases, which genuinely expect the same
  // field twice, still need two extractions to score two.
  const claimed = new Set<number>();
  let truePositives = 0;

  for (const expected of evalCase.expected) {
    const accepts = acceptableKeys(expected);

    const match = extracted.findIndex(
      (item, index) => !claimed.has(index) && accepts.has(key(item.crmObject, item.fieldName)),
    );

    if (match !== -1) {
      claimed.add(match);
      truePositives += 1;
    }
  }

  const hallucinatedQuotes = extracted.filter((r) =>
    (r.reviewReason ?? "").includes("quote_not_found"),
  ).length;

  const actuallyFlagged = extracted.some((r) => r.status === "needs_review");

  return {
    id: evalCase.id,
    adversarial: evalCase.adversarial,
    failure,
    expected: evalCase.expected.length,
    extracted: extracted.length,
    truePositives,
    falsePositives: extracted.length - truePositives,
    falseNegatives: evalCase.expected.length - truePositives,
    hallucinatedQuotes,
    expectFlagged: evalCase.expectFlagged,
    actuallyFlagged,
    flaggingCorrect: actuallyFlagged === evalCase.expectFlagged,
  };
}

export interface Totals {
  cases: number;
  failures: number;
  precision: number;
  recall: number;
  f1: number;
  /** Share of everything extracted whose quote was not in the transcript. */
  hallucinationRate: number;
  /** Share of adversarial cases flagged as the dataset says they should be. */
  adversarialFlaggingAccuracy: number;
  /**
   * Share of clean cases that raised a flag.
   *
   * Deliberately NOT called a false-alarm rate. The first run flagged
   * `case-sla-due`, and the flag was right: the model had stitched two separate
   * passages of the transcript into one quote, and the verifier caught exactly
   * the thing it exists to catch. Calling that a false alarm would assert the
   * guardrail was wrong when the model was.
   *
   * So this number means "clean transcripts that still needed a human", which
   * is a cost worth tracking without pretending to know whose fault it was.
   * Which it is, per case, is in the report.
   */
  flagsOnCleanCasesRate: number;
}

/** 0 when the denominator is 0, which is the honest reading of "nothing to get wrong". */
function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

export function aggregate(scores: readonly CaseScore[]): Totals {
  const tp = scores.reduce((sum, s) => sum + s.truePositives, 0);
  const fp = scores.reduce((sum, s) => sum + s.falsePositives, 0);
  const fn = scores.reduce((sum, s) => sum + s.falseNegatives, 0);

  const precision = ratio(tp, tp + fp);
  const recall = ratio(tp, tp + fn);

  const extractedTotal = scores.reduce((sum, s) => sum + s.extracted, 0);
  const hallucinated = scores.reduce((sum, s) => sum + s.hallucinatedQuotes, 0);

  const adversarial = scores.filter((s) => s.adversarial !== null);
  const clean = scores.filter((s) => s.adversarial === null);

  return {
    cases: scores.length,
    failures: scores.filter((s) => s.failure !== null).length,
    precision,
    recall,
    f1: ratio(2 * precision * recall, precision + recall),
    hallucinationRate: ratio(hallucinated, extractedTotal),
    adversarialFlaggingAccuracy: ratio(
      adversarial.filter((s) => s.flaggingCorrect).length,
      adversarial.length,
    ),
    // Counted separately from the adversarial accuracy on purpose: a harness
    // that only rewards flagging would score a system that flags everything as
    // perfect, and a review queue nobody trusts is worse than no queue.
    flagsOnCleanCasesRate: ratio(
      clean.filter((s) => s.actuallyFlagged).length,
      clean.length,
    ),
  };
}
