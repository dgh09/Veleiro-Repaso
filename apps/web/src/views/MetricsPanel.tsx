import { useCallback, useState } from "react";

import { getMetrics } from "../api/client";
import type { Identity } from "../identity";
import { ErrorBanner } from "../ui/atoms";
import { useAsync } from "../ui/useAsync";

/**
 * What this tenant's agents have cost and what its humans have decided.
 *
 * Tenant-wide rather than per project, so it sits outside the project tabs -
 * putting a tenant number inside a project view would invite reading it as a
 * project number.
 *
 * Collapsed by default. It is a check you run occasionally, not the thing you
 * came here to do, and a row of statistics above the work is how a tool starts
 * feeling like a dashboard nobody asked for.
 */
export function MetricsPanel({ identity }: { identity: Identity }) {
  const [open, setOpen] = useState(false);

  return (
    <section className="rounded-lg border border-neutral-200 bg-white">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between px-4 py-2 text-left text-sm font-medium text-neutral-800"
      >
        <span>Model usage and decisions for {identity.tenantName}</span>
        <span className="text-neutral-500">{open ? "Hide" : "Show"}</span>
      </button>

      {open ? <Numbers identity={identity} /> : null}
    </section>
  );
}

function Numbers({ identity }: { identity: Identity }) {
  const load = useCallback(() => getMetrics(identity), [identity]);
  const { state, reload } = useAsync(load, [identity.userId]);

  if (state.kind === "loading") {
    return <p className="px-4 pb-3 text-sm text-neutral-500">Loading metrics…</p>;
  }

  if (state.kind === "error") {
    return (
      <div className="px-4 pb-3">
        <ErrorBanner message={state.message} onRetry={reload} />
      </div>
    );
  }

  const { llm, requirements, proposals } = state.value;

  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-4 border-t border-neutral-200 px-4 py-3 md:grid-cols-4">
      <Stat label="Model calls" value={String(llm.calls)} hint={`${llm.failedCalls} failed`} />
      <Stat
        label="Tokens"
        value={`${llm.inputTokens.toLocaleString()} / ${llm.outputTokens.toLocaleString()}`}
        hint="in / out"
      />
      <Stat
        label="Estimated cost"
        value={`$${Number(llm.costUsd).toFixed(4)}`}
        hint="free tier, so zero is the true figure"
      />
      <Stat label="Avg latency" value={`${llm.avgLatencyMs} ms`} hint="per model call" />

      <Stat
        label="Requirements"
        value={String(requirements.total)}
        hint={`${requirements.needsReview} flagged`}
      />
      <Stat
        label="Needs review"
        value={percent(requirements.needsReviewRate)}
        hint="of everything extracted"
      />
      <Stat
        label="Approved"
        value={percent(proposals.approvalRate)}
        hint={`${proposals.applied} applied, ${proposals.failed} refused by the CRM`}
      />
      <Stat
        label="Rejected"
        value={percent(proposals.rejectionRate)}
        hint={`${proposals.pending} still waiting`}
      />
    </div>
  );
}

function percent(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}

function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div>
      <dt className="text-xs text-neutral-500">{label}</dt>
      <dd className="text-lg font-semibold text-neutral-900">{value}</dd>
      <dd className="text-xs text-neutral-500">{hint}</dd>
    </div>
  );
}
