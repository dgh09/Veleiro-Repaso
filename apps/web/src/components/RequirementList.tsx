import { useState } from "react";
import type { RequirementResponse, TranscriptResponse } from "@veleiro/shared";

import { Button, Card, RequirementBadge } from "../ui/atoms";
import { QuoteInContext } from "./QuoteInContext";

/**
 * `review_reason` is stored as comma-separated codes, because one requirement
 * can fail several guardrails at once. SPEC requires the UI to show *why* an
 * item was flagged, and a code is not a why.
 */
const REVIEW_REASONS: Record<string, string> = {
  quote_not_found:
    "The quoted evidence could not be found in the transcript. The agent may have invented it.",
  low_confidence:
    "The agent was not confident this was actually asked for. Check the transcript before proposing.",
  contradiction:
    "This conflicts with another requirement claiming a different type for the same field. Neither was resolved automatically.",
};

function explainReviewReasons(reviewReason: string | null): string[] {
  if (reviewReason === null) return [];
  return reviewReason
    .split(",")
    .map((code) => code.trim())
    .filter((code) => code.length > 0)
    .map((code) => REVIEW_REASONS[code] ?? `Flagged: ${code}`);
}

/**
 * needs_review first, then everything else. SPEC asks for it, and the reason is
 * that the flagged items are the only ones that need a decision - burying them
 * under a list of clean extractions is how a hallucinated quote gets approved.
 */
function sortForReview(requirements: RequirementResponse[]): RequirementResponse[] {
  return [...requirements].sort((a, b) => {
    const aFlagged = a.status === "needs_review" ? 0 : 1;
    const bFlagged = b.status === "needs_review" ? 0 : 1;
    if (aFlagged !== bFlagged) return aFlagged - bFlagged;
    return b.confidence - a.confidence;
  });
}

export function RequirementList({
  requirements,
  transcript,
  onPropose,
  proposingId,
  proposeError,
}: {
  requirements: RequirementResponse[];
  transcript: TranscriptResponse;
  onPropose: (requirement: RequirementResponse) => void;
  proposingId: string | null;
  proposeError: { id: string; message: string } | null;
}) {
  return (
    <ul className="flex flex-col gap-3">
      {sortForReview(requirements).map((requirement) => (
        <li key={requirement.id}>
          <RequirementCard
            requirement={requirement}
            transcript={transcript}
            onPropose={onPropose}
            busy={proposingId === requirement.id}
            error={proposeError?.id === requirement.id ? proposeError.message : null}
          />
        </li>
      ))}
    </ul>
  );
}

function RequirementCard({
  requirement,
  transcript,
  onPropose,
  busy,
  error,
}: {
  requirement: RequirementResponse;
  transcript: TranscriptResponse;
  onPropose: (requirement: RequirementResponse) => void;
  busy: boolean;
  error: string | null;
}) {
  const [showEvidence, setShowEvidence] = useState(false);
  const flagged = requirement.status === "needs_review";
  const reasons = explainReviewReasons(requirement.reviewReason);

  return (
    <Card className={flagged ? "border-amber-400 shadow-sm" : ""}>
      <div className="flex flex-col gap-3 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="font-medium text-neutral-900">{requirement.title}</h3>
            <p className="mt-1 text-sm text-neutral-700">{requirement.description}</p>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            <RequirementBadge status={requirement.status} />
            <span className="text-xs text-neutral-500">
              confidence {requirement.confidence.toFixed(2)}
            </span>
          </div>
        </div>

        {reasons.length > 0 ? (
          <div className="rounded border border-amber-400 bg-amber-50 p-3">
            <p className="text-xs font-semibold text-amber-950">Why this needs review</p>
            <ul className="mt-1 list-disc pl-4 text-xs text-amber-950">
              {reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          </div>
        ) : null}

        <dl className="grid grid-cols-3 gap-2 text-xs">
          <Field label="Object" value={requirement.crmObject} />
          <Field label="Field" value={requirement.fieldName} />
          <Field label="Type" value={requirement.fieldType} />
        </dl>

        <p className="text-xs text-neutral-600">
          <span className="font-semibold">Rationale.</span> {requirement.rationale}
        </p>

        <blockquote className="border-l-2 border-neutral-300 pl-3 text-sm text-neutral-800 italic">
          “{requirement.sourceQuote}”
        </blockquote>

        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => setShowEvidence((open) => !open)}>
            {showEvidence ? "Hide evidence" : "Check evidence in transcript"}
          </Button>

          {requirement.status === "extracted" ? (
            <Button tone="primary" onClick={() => onPropose(requirement)} disabled={busy}>
              {busy ? "Proposing…" : "Propose change"}
            </Button>
          ) : null}

          {flagged ? (
            <span className="text-xs text-neutral-500">
              Flagged items cannot be proposed until a human resolves them.
            </span>
          ) : null}

          {requirement.status === "proposed" ? (
            <span className="text-xs text-neutral-500">
              Already proposed — see the proposal queue.
            </span>
          ) : null}
        </div>

        {error ? (
          <p className="rounded border border-red-300 bg-red-50 p-2 text-xs text-red-900" role="alert">
            {error}
          </p>
        ) : null}

        {showEvidence ? (
          <QuoteInContext
            content={transcript.content}
            start={requirement.sourceQuoteStart}
            end={requirement.sourceQuoteEnd}
          />
        ) : null}
      </div>
    </Card>
  );
}

function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <dt className="text-neutral-500">{label}</dt>
      <dd className="font-mono text-neutral-900">{value ?? "—"}</dd>
    </div>
  );
}
