import { describe, expect, it } from "vitest";

import { verifySourceQuote } from "./verify-quote";

const TRANSCRIPT = [
  "Consultant: Walk me through how your team tracks a deal today.",
  "Client: Everything lives in a spreadsheet. We need the close date on the",
  "opportunity to be required, because half of them come in blank.",
].join("\n");

/** Asserts the offsets point at the real span, not just that something matched. */
function sliceOf(quote: string): string {
  const result = verifySourceQuote(TRANSCRIPT, quote);
  if (!result.found) throw new Error(`expected to find: ${quote}`);
  return TRANSCRIPT.slice(result.start, result.end);
}

describe("verifySourceQuote", () => {
  it("finds an exact span and reports offsets into the original text", () => {
    expect(sliceOf("Everything lives in a spreadsheet")).toBe(
      "Everything lives in a spreadsheet",
    );
  });

  it("finds a quote whose line break the model collapsed to a space", () => {
    // This is the common case, and the one an exact substring test would
    // wrongly call a hallucination: the transcript wraps mid-sentence, the
    // model re-emits it as one line.
    const quote = "We need the close date on the opportunity to be required";

    expect(TRANSCRIPT).not.toContain(quote);
    expect(sliceOf(quote)).toBe(
      "We need the close date on the\nopportunity to be required",
    );
  });

  it("finds a quote the model rewrote with typographic punctuation", () => {
    const source = "Client: the rep’s forecast — always wrong — needs fixing.";

    const result = verifySourceQuote(source, "the rep's forecast - always wrong");

    expect(result.found).toBe(true);
    if (!result.found) throw new Error("unreachable");
    expect(source.slice(result.start, result.end)).toBe(
      "the rep’s forecast — always wrong",
    );
  });

  it("ignores case, which cannot be used to fabricate evidence", () => {
    expect(sliceOf("EVERYTHING LIVES IN A SPREADSHEET")).toBe(
      "Everything lives in a spreadsheet",
    );
  });

  it("tolerates surrounding whitespace in the quote", () => {
    expect(sliceOf("   Everything lives in a spreadsheet  ")).toBe(
      "Everything lives in a spreadsheet",
    );
  });

  it("rejects a quote that is not in the transcript at all", () => {
    // The failure the whole design exists to catch.
    expect(
      verifySourceQuote(TRANSCRIPT, "We need a field for the client's astrological sign"),
    ).toEqual({ found: false });
  });

  it("rejects a quote that stitches two separate passages together", () => {
    expect(
      verifySourceQuote(TRANSCRIPT, "Everything lives in a spreadsheet come in blank"),
    ).toEqual({ found: false });
  });

  it("rejects an empty or whitespace-only quote", () => {
    expect(verifySourceQuote(TRANSCRIPT, "")).toEqual({ found: false });
    expect(verifySourceQuote(TRANSCRIPT, "   \n  ")).toEqual({ found: false });
  });

  it("keeps offsets correct when the text contains characters outside the BMP", () => {
    const source = "Client: the pipeline \u{1F4C8} needs a renewal risk field.";

    const result = verifySourceQuote(source, "needs a renewal risk field");

    expect(result.found).toBe(true);
    if (!result.found) throw new Error("unreachable");
    expect(source.slice(result.start, result.end)).toBe("needs a renewal risk field");
  });
});
