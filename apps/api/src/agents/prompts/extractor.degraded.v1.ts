import type { Prompt } from "./types";

/**
 * A deliberately worse Extractor prompt, used only by the eval harness.
 *
 * SPEC's Phase 6 acceptance is that "deliberately degrading the extractor
 * prompt makes the score drop measurably". A metric nobody has ever seen move
 * is not a metric - it could be measuring the transcript rather than the agent,
 * or nothing at all. This is the control that proves the number responds to
 * prompt quality.
 *
 * What was removed from extractor.v1, and what each removal should cost:
 *
 * - the verbatim-quote instruction  -> hallucinated-quote rate should rise
 * - the confidence calibration      -> flat, uninformative confidence
 * - "an empty list is a correct answer" and the tangent rule -> precision falls
 * - "do not fill the gap with a plausible invention" -> invented detail on the
 *   missing-detail case, instead of a flag
 * - the prompt-injection warning    -> the injection case may be obeyed
 *
 * Never wire this into the application. It exists to lose.
 */
export const EXTRACTOR_DEGRADED_PROMPT: Prompt = {
  version: "extractor.degraded.v1",
  system: [
    "You extract CRM requirements from a discovery call transcript.",
    "",
    "Find everything that could possibly be a requirement and return it. Include a",
    "quote for each one and a confidence score.",
  ].join("\n"),
};
