import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runExtractor } from "../agents/extractor/extractor";
import { EXTRACTOR_DEGRADED_PROMPT } from "../agents/prompts/extractor.degraded.v1";
import { EXTRACTOR_PROMPT } from "../agents/prompts/extractor.v1";
import type { Prompt } from "../agents/prompts/types";
import { describeAgentFailure } from "../agents/runtime/errors";
import { pool } from "../db/client";
import { listLlmCalls } from "../db/repositories/llm-calls";
import { createTranscript } from "../db/repositories/transcripts";
import { env } from "../env";
import { ensureEvalTenant, EVAL_CONTEXT, EVAL_TENANT } from "./fixture";
import { aggregate, scoreCase, type CaseScore, type Totals } from "./score";
import { EvalCaseSchema, type EvalCase } from "./schema";

/**
 * `npm run eval` - runs the Extractor against the golden dataset and prints a
 * score.
 *
 * The point of this phase is that agent quality becomes a number that can be
 * tracked, and that a regression in it is visible. That only works if the
 * number can move, so the harness can also run a deliberately worse prompt
 * (`--prompt degraded`) as a control.
 *
 * Flags (npm swallows these on the root script, so pass them to the workspace:
 * `npm run eval -w @veleiro/api -- --limit 2`):
 *   --prompt degraded   run the degraded control prompt instead of the current one
 *   --delay <ms>        pause between cases (default 20000)
 *   --limit <n>         run only the first n cases, for debugging the harness
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATASET_DIR = path.resolve(HERE, "..", "..", "..", "..", "evals", "dataset");
const REPORTS_DIR = path.resolve(HERE, "..", "..", "..", "..", "evals", "reports");

/**
 * The Groq free tier allows 8K tokens per minute for this model - measured, not
 * assumed: a real call on the seeded transcript used 1019 in / 405 out, and the
 * dataset transcripts are the same size, so a case costs about 1.4K.
 *
 * Three a minute is ~4.3K/min, comfortably inside the limit. Five a minute
 * would be ~7.1K, which is 89% of it and trips on any variance - and a run that
 * spends its time in backoff reports latency numbers that describe the rate
 * limiter rather than the model.
 *
 * The client retries a 429 with the provider's own retry-after, so this pacing
 * is the thing that keeps the numbers meaningful, not the thing that keeps the
 * run alive.
 */
const DEFAULT_DELAY_MS = 20_000;

interface Args {
  prompt: Prompt;
  delayMs: number;
  limit: number | undefined;
}

function parseArgs(argv: readonly string[]): Args {
  const get = (name: string): string | undefined => {
    const at = argv.indexOf(name);
    return at === -1 ? undefined : argv[at + 1];
  };

  const promptName = get("--prompt");
  const delay = get("--delay");
  const limit = get("--limit");

  return {
    prompt: promptName === "degraded" ? EXTRACTOR_DEGRADED_PROMPT : EXTRACTOR_PROMPT,
    delayMs: delay === undefined ? DEFAULT_DELAY_MS : Number(delay),
    limit: limit === undefined ? undefined : Number(limit),
  };
}

function loadDataset(): EvalCase[] {
  const files = readdirSync(DATASET_DIR)
    .filter((name) => name.endsWith(".json"))
    .sort();

  return files.map((name) => {
    const raw: unknown = JSON.parse(readFileSync(path.join(DATASET_DIR, name), "utf8"));
    const parsed = EvalCaseSchema.safeParse(raw);

    if (!parsed.success) {
      // A malformed ground truth would silently change every score computed
      // against it, so this is fatal rather than skipped.
      throw new Error(`Invalid eval case in ${name}:\n${JSON.stringify(parsed.error.issues, null, 2)}`);
    }

    return parsed.data;
  });
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

interface Usage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  avgLatencyMs: number;
  errors: number;
}

/** Reads back what this run actually cost, from the rows the agent wrote. */
async function usageSince(startedAt: Date): Promise<Usage> {
  const rows = (await listLlmCalls(EVAL_CONTEXT, 1000)).filter(
    (row) => row.createdAt >= startedAt,
  );

  const latency = rows.reduce((sum, row) => sum + row.latencyMs, 0);

  return {
    calls: rows.length,
    inputTokens: rows.reduce((sum, row) => sum + row.inputTokens, 0),
    outputTokens: rows.reduce((sum, row) => sum + row.outputTokens, 0),
    costUsd: rows.reduce((sum, row) => sum + Number(row.costUsd), 0),
    avgLatencyMs: rows.length === 0 ? 0 : Math.round(latency / rows.length),
    errors: rows.filter((row) => row.error !== null).length,
  };
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function printTable(scores: readonly CaseScore[]): void {
  const rows = scores.map((s) => ({
    case: s.id.slice(0, 34),
    kind: s.adversarial ?? "-",
    exp: String(s.expected),
    got: String(s.extracted),
    tp: String(s.truePositives),
    fp: String(s.falsePositives),
    fn: String(s.falseNegatives),
    halluc: String(s.hallucinatedQuotes),
    flag: s.flaggingCorrect ? "ok" : s.expectFlagged ? "MISSED" : "FLAGGED",
  }));

  console.table(rows);

  const failed = scores.filter((s) => s.failure !== null);
  if (failed.length > 0) {
    console.log("\nAgent failures:");
    for (const s of failed) console.log(`  ${s.id}: ${s.failure}`);
  }
}

function printTotals(totals: Totals, usage: Usage, prompt: Prompt): void {
  console.log(`\n  prompt                 ${prompt.version}`);
  console.log(`  model                  ${env.LLM_MODEL}`);
  console.log(`  cases                  ${totals.cases} (${totals.failures} agent failures)`);
  console.log(`  precision              ${pct(totals.precision)}`);
  console.log(`  recall                 ${pct(totals.recall)}`);
  console.log(`  f1                     ${pct(totals.f1)}`);
  console.log(`  hallucinated quotes    ${pct(totals.hallucinationRate)}`);
  console.log(`  adversarial flagging   ${pct(totals.adversarialFlaggingAccuracy)}`);
  console.log(`  flags on clean cases   ${pct(totals.flagsOnCleanCasesRate)}`);
  console.log(
    `  tokens                 ${usage.inputTokens} in / ${usage.outputTokens} out ` +
      `over ${usage.calls} calls (${usage.errors} failed)`,
  );
  console.log(`  cost                   $${usage.costUsd.toFixed(6)}`);
  console.log(`  avg latency            ${usage.avgLatencyMs}ms`);
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const dataset = loadDataset();
  const cases = args.limit === undefined ? dataset : dataset.slice(0, args.limit);

  const runId = randomUUID();
  const startedAt = new Date();

  console.log(`[eval] run ${runId}`);
  console.log(`[eval] prompt ${args.prompt.version}, ${cases.length} cases, ${args.delayMs}ms between\n`);

  await ensureEvalTenant();

  const scores: CaseScore[] = [];

  for (const [index, evalCase] of cases.entries()) {
    process.stdout.write(`  [${index + 1}/${cases.length}] ${evalCase.id} … `);

    // A fresh transcript per case per run, so a rerun never collides with the
    // rows a previous run left behind.
    const transcript = await createTranscript(EVAL_CONTEXT, {
      projectId: EVAL_TENANT.projectId,
      title: `${evalCase.id} @ ${runId.slice(0, 8)}`,
      content: evalCase.transcript,
      meetingDate: null,
    });

    const result = await runExtractor({
      ctx: EVAL_CONTEXT,
      transcript,
      prompt: args.prompt,
    });

    if (result.ok) {
      const score = scoreCase(evalCase, result.value.requirements);
      scores.push(score);
      console.log(
        `${score.truePositives}/${score.expected} matched, ${score.extracted} returned`,
      );
    } else {
      // A failed case is scored as zero recall rather than skipped. Dropping it
      // would quietly raise the average every time the agent broke.
      const score = scoreCase(evalCase, [], describeAgentFailure(result.error));
      scores.push(score);
      console.log(`FAILED (${score.failure})`);
    }

    if (index < cases.length - 1) await sleep(args.delayMs);
  }

  const totals = aggregate(scores);
  const usage = await usageSince(startedAt);

  console.log("");
  printTable(scores);
  printTotals(totals, usage, args.prompt);

  const report = {
    runId,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    promptVersion: args.prompt.version,
    model: env.LLM_MODEL,
    datasetCases: dataset.length,
    totals,
    usage,
    cases: scores,
  };

  mkdirSync(REPORTS_DIR, { recursive: true });
  const stamp = startedAt.toISOString().replace(/[:.]/g, "-");
  const file = path.join(REPORTS_DIR, `${stamp}-${args.prompt.version}.json`);
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  console.log(`\n[eval] report written to ${path.relative(process.cwd(), file)}`);

  // A non-zero exit when the agent itself broke, so this is usable as a gate.
  return totals.failures > 0 ? 1 : 0;
}

process.exitCode = await main();
await pool.end();
