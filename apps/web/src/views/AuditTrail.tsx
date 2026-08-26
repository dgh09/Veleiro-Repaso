import { useCallback } from "react";
import type { AuditEntryResponse } from "@veleiro/shared";

import { listProjectAudit } from "../api/client";
import { IDENTITIES, type Identity } from "../identity";
import { Button, Empty, ErrorBanner, formatTimestamp, Loading } from "../ui/atoms";
import { useAsync } from "../ui/useAsync";

/**
 * The audit trail for one project, oldest first.
 *
 * SPEC asks for agent actions and human actions to be shown distinctly, and
 * that distinction is the deliverable: the claim this whole system makes is
 * that no model output reached the destination without a recorded human
 * approval. This screen is where someone checks that claim, so an agent row and
 * a person's row must never be mistakable for each other at a glance.
 */

const ACTION_LABELS: Record<string, string> = {
  extract_requirements: "extracted requirements from the transcript",
  propose_change: "proposed a configuration change",
  apply_proposal: "approved and applied a change",
  apply_proposal_failed: "approved a change, but the CRM refused it",
  reject_proposal: "rejected a change",
  discard_requirement: "discarded the requirement behind a rejected change",
};

function describeAction(entry: AuditEntryResponse): string {
  return ACTION_LABELS[entry.action] ?? entry.action;
}

/**
 * `audit_log.actor_id` holds a user uuid for human actions and an agent name
 * for agent ones, because an agent has no row in `users`. A uuid tells a reader
 * nothing, so known users are resolved to their name here.
 *
 * The fallback is the raw id rather than "Unknown": an audit trail that quietly
 * relabels an actor it cannot identify is worse than one that shows the id.
 */
function actorName(entry: AuditEntryResponse): string {
  if (entry.actorType === "agent") return entry.actorId;
  return IDENTITIES.find((i) => i.userId === entry.actorId)?.userName ?? entry.actorId;
}

/** The stated reason, when the action carried one. */
function reasonOf(entry: AuditEntryResponse): string | null {
  if (typeof entry.after !== "object" || entry.after === null) return null;
  const after: Record<string, unknown> = entry.after as Record<string, unknown>;
  const reason = after["rejectionReason"] ?? after["error"];
  return typeof reason === "string" ? reason : null;
}

export function AuditTrail({
  identity,
  projectId,
}: {
  identity: Identity;
  projectId: string;
}) {
  const load = useCallback(
    () => listProjectAudit(identity, projectId),
    [identity, projectId],
  );
  const { state, reload } = useAsync(load, [identity.userId, projectId]);

  if (state.kind === "loading") return <Loading what="the audit trail" />;
  if (state.kind === "error") {
    return <ErrorBanner message={state.message} onRetry={reload} />;
  }

  if (state.value.length === 0) {
    return <Empty>Nothing has happened in this project yet.</Empty>;
  }

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-semibold text-neutral-900">
          What happened, in order ({state.value.length})
        </h2>
        <Button onClick={reload}>Refresh</Button>
      </div>

      <ol className="flex flex-col gap-2">
        {state.value.map((entry) => (
          <li key={entry.id}>
            <Entry entry={entry} />
          </li>
        ))}
      </ol>
    </div>
  );
}

function Entry({ entry }: { entry: AuditEntryResponse }) {
  const isAgent = entry.actorType === "agent";
  const reason = reasonOf(entry);

  return (
    <div
      className={`rounded-lg border-l-4 bg-white p-3 ${
        isAgent
          ? "border-l-violet-500 border-y border-r border-y-neutral-200 border-r-neutral-200"
          : "border-l-neutral-900 border-y border-r border-y-neutral-200 border-r-neutral-200"
      }`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm text-neutral-900">
          <span
            className={`mr-2 rounded px-1.5 py-0.5 text-xs font-semibold ${
              isAgent ? "bg-violet-100 text-violet-900" : "bg-neutral-900 text-white"
            }`}
          >
            {isAgent ? "AGENT" : "HUMAN"}
          </span>
          <span className="font-medium">{actorName(entry)}</span> {describeAction(entry)}
        </p>
        <span className="text-xs text-neutral-500">{formatTimestamp(entry.createdAt)}</span>
      </div>

      {reason !== null ? (
        <p className="mt-1 pl-1 text-xs text-neutral-700">
          <span className="font-semibold">Reason:</span> {reason}
        </p>
      ) : null}
    </div>
  );
}
