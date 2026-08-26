/**
 * Prompts live in versioned files named `<agent>.v<n>.ts` and are never inlined
 * in business logic (CLAUDE.md). The `version` string is what gets written to
 * `llm_calls.prompt_version`, which is what makes it possible to say "quality
 * dropped when we shipped extractor.v3" instead of guessing.
 *
 * Editing a prompt means writing a new file with a new version, not changing
 * one in place - otherwise old `llm_calls` rows claim a version whose text no
 * longer exists.
 */
export interface Prompt {
  version: string;
  system: string;
}
