import { useCallback, useState } from "react";
import type { ProposalResponse } from "@veleiro/shared";

import { approve, listProposals, reject } from "../api/client";
import { ProposalDiff } from "../components/ProposalDiff";
import type { Identity } from "../identity";
import {
  Button,
  Card,
  Empty,
  ErrorBanner,
  formatTimestamp,
  Loading,
  ProposalBadge,
  RiskBadge,
} from "../ui/atoms";
import { useAsync } from "../ui/useAsync";

/**
 * The approval queue: pending proposals, what each would change, and the two
 * decisions a human can make about it.
 *
 * Nothing here is optimistic. A row only changes after the server has said what
 * happened, because the whole point of the queue is that it reports reality -
 * a UI that flips to "applied" on click and quietly reverts would undermine
 * exactly the trust the audit trail is meant to establish.
 */
export function ProposalQueue({
  identity,
  projectId,
}: {
  identity: Identity;
  projectId: string;
}) {
  const load = useCallback(
    () => listProposals(identity, { projectId }),
    [identity, projectId],
  );
  const { state, reload, set } = useAsync(load, [identity.userId, projectId]);

  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<{ id: string; message: string } | null>(
    null,
  );

  function replace(updated: ProposalResponse): void {
    if (state.kind !== "ready") return;
    set(state.value.map((p) => (p.id === updated.id ? updated : p)));
  }

  async function onApprove(proposal: ProposalResponse): Promise<void> {
    setBusyId(proposal.id);
    setActionError(null);

    const result = await approve(identity, proposal.id);
    setBusyId(null);

    if (!result.ok) {
      setActionError({ id: proposal.id, message: result.message });
      return;
    }

    replace(result.value.proposal);

    // The request succeeded but the connector refused. That is not an error in
    // the UI's own terms, and saying so plainly beats a red banner that implies
    // the click failed.
    if (!result.value.applied && result.value.error !== undefined) {
      setActionError({
        id: proposal.id,
        message: `Approved, but the CRM refused the change: ${result.value.error}`,
      });
    }
  }

  async function onReject(proposal: ProposalResponse, reason: string): Promise<void> {
    setBusyId(proposal.id);
    setActionError(null);

    const result = await reject(identity, proposal.id, reason);
    setBusyId(null);

    if (!result.ok) {
      setActionError({ id: proposal.id, message: result.message });
      return;
    }

    replace(result.value.proposal);
  }

  if (state.kind === "loading") return <Loading what="the proposal queue" />;
  if (state.kind === "error") {
    return <ErrorBanner message={state.message} onRetry={reload} />;
  }

  const pending = state.value.filter((p) => p.status === "pending");
  const settled = state.value.filter((p) => p.status !== "pending");

  return (
    <div className="flex flex-col gap-6">
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-semibold text-neutral-900">
            Awaiting your decision ({pending.length})
          </h2>
          <Button onClick={reload}>Refresh</Button>
        </div>

        {pending.length === 0 ? (
          <Empty>Nothing is waiting. Propose a change from a requirement first.</Empty>
        ) : (
          <ul className="flex flex-col gap-3">
            {pending.map((proposal) => (
              <li key={proposal.id}>
                <PendingProposal
                  proposal={proposal}
                  busy={busyId === proposal.id}
                  error={actionError?.id === proposal.id ? actionError.message : null}
                  onApprove={() => void onApprove(proposal)}
                  onReject={(reason) => void onReject(proposal, reason)}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      {settled.length > 0 ? (
        <section>
          <h2 className="mb-3 font-semibold text-neutral-900">Already decided</h2>
          <ul className="flex flex-col gap-2">
            {settled.map((proposal) => (
              <li key={proposal.id}>
                <SettledProposal
                  proposal={proposal}
                  error={actionError?.id === proposal.id ? actionError.message : null}
                />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function PendingProposal({
  proposal,
  busy,
  error,
  onApprove,
  onReject,
}: {
  proposal: ProposalResponse;
  busy: boolean;
  error: string | null;
  onApprove: () => void;
  onReject: (reason: string) => void;
}) {
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");

  // SPEC: "Rejecting without typing a reason is impossible in the UI, not just
  // on the API." The API refuses it too - this is the second lock, not the only
  // one.
  const reasonIsUsable = reason.trim().length > 0;

  return (
    <Card>
      <div className="flex flex-col gap-3 p-4">
        <div className="flex items-start justify-between gap-3">
          {/* min-w-0 so the diff table uses the space, instead of collapsing to
              its content width and leaving the row half empty. */}
          <div className="min-w-0 flex-1">
            <ProposalDiff payload={proposal.payload} />
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            <RiskBadge level={proposal.riskLevel} />
            <span className="text-xs text-neutral-500">
              {formatTimestamp(proposal.createdAt)}
            </span>
          </div>
        </div>

        {error ? (
          <p
            className="rounded border border-red-300 bg-red-50 p-2 text-xs text-red-900"
            role="alert"
          >
            {error}
          </p>
        ) : null}

        {rejecting ? (
          <form
            className="flex flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (reasonIsUsable) onReject(reason.trim());
            }}
          >
            <label className="text-xs font-medium text-neutral-700" htmlFor={`reason-${proposal.id}`}>
              Why are you rejecting this? The reason is recorded in the audit trail.
            </label>
            <textarea
              id={`reason-${proposal.id}`}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              rows={2}
              autoFocus
              className="rounded border border-neutral-300 p-2 text-sm"
              placeholder="e.g. The client already has this field under another name"
            />
            <div className="flex gap-2">
              <Button
                type="submit"
                tone="danger"
                disabled={!reasonIsUsable || busy}
                title={reasonIsUsable ? undefined : "A reason is required"}
              >
                {busy ? "Rejecting…" : "Confirm rejection"}
              </Button>
              <Button
                onClick={() => {
                  setRejecting(false);
                  setReason("");
                }}
                disabled={busy}
              >
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <div className="flex gap-2">
            <Button tone="primary" onClick={onApprove} disabled={busy}>
              {busy ? "Applying…" : "Approve and apply"}
            </Button>
            <Button tone="danger" onClick={() => setRejecting(true)} disabled={busy}>
              Reject
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}

function SettledProposal({
  proposal,
  error,
}: {
  proposal: ProposalResponse;
  error: string | null;
}) {
  return (
    <Card>
      <div className="flex flex-col gap-2 p-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <ProposalDiff payload={proposal.payload} />
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            <ProposalBadge status={proposal.status} />
            <RiskBadge level={proposal.riskLevel} />
          </div>
        </div>

        {proposal.rejectionReason !== null ? (
          <p className="text-xs text-neutral-700">
            <span className="font-semibold">Rejected because:</span>{" "}
            {proposal.rejectionReason}
          </p>
        ) : null}

        {error ? (
          <p className="rounded border border-amber-400 bg-amber-50 p-2 text-xs text-amber-950">
            {error}
          </p>
        ) : null}
      </div>
    </Card>
  );
}
