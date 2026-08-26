import type { Prompt } from "./types";

/**
 * A connectivity probe, not an agent.
 *
 * Its only job is to prove the wire works end to end - real endpoint, real
 * key, real `llm_calls` row - and to establish the `<agent>.v<n>.ts` convention
 * before the Extractor arrives in Phase 3. Deliberately trivial: a smoke test
 * that needs a good prompt is testing the wrong thing.
 */
export const SMOKE_PROMPT: Prompt = {
  version: "smoke.v1",
  system:
    "You are a connectivity probe for a CRM discovery assistant. " +
    "Answer in one short sentence. Do not elaborate.",
};
