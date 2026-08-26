import { useCallback, useState } from "react";
import type { RequirementResponse, TranscriptResponse } from "@veleiro/shared";

import { extract, listRequirements, propose } from "../api/client";
import { RequirementList } from "../components/RequirementList";
import type { Identity } from "../identity";
import { Button, Card, Empty, ErrorBanner, Loading } from "../ui/atoms";
import { useAsync } from "../ui/useAsync";

/**
 * One transcript: the text itself, the button that runs the Extractor, and
 * whatever it found.
 *
 * The extract button reports what it is doing and stays disabled while the
 * model is working. A discovery transcript takes a few seconds to process on a
 * free tier, and a button that looks idle during that is how someone ends up
 * clicking it twice - which the API would refuse with a 409, correctly but
 * confusingly.
 */
export function TranscriptDetail({
  identity,
  transcript,
  onBack,
  onProposed,
}: {
  identity: Identity;
  transcript: TranscriptResponse;
  onBack: () => void;
  onProposed: () => void;
}) {
  const load = useCallback(
    () => listRequirements(identity, transcript.id),
    [identity, transcript.id],
  );
  const { state, reload, set } = useAsync(load, [identity.userId, transcript.id]);

  const [extracting, setExtracting] = useState(false);
  const [extractError, setExtractError] = useState<string | null>(null);
  const [proposingId, setProposingId] = useState<string | null>(null);
  const [proposeError, setProposeError] = useState<{ id: string; message: string } | null>(
    null,
  );

  async function onExtract(): Promise<void> {
    setExtracting(true);
    setExtractError(null);

    const result = await extract(identity, transcript.id);
    setExtracting(false);

    if (!result.ok) {
      setExtractError(result.message);
      return;
    }

    set(result.value.requirements);
  }

  async function onPropose(requirement: RequirementResponse): Promise<void> {
    setProposingId(requirement.id);
    setProposeError(null);

    const result = await propose(identity, requirement.id);
    setProposingId(null);

    if (!result.ok) {
      setProposeError({ id: requirement.id, message: result.message });
      return;
    }

    // The requirement's status moved to `proposed` server-side; re-reading is
    // how the list learns that, rather than guessing it locally.
    reload();
    onProposed();
  }

  const requirements = state.kind === "ready" ? state.value : [];
  const flagged = requirements.filter((r) => r.status === "needs_review").length;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <Button onClick={onBack}>← All transcripts</Button>
        <h2 className="font-semibold text-neutral-900">{transcript.title}</h2>
      </div>

      <Card>
        <details className="p-4">
          <summary className="cursor-pointer text-sm font-medium text-neutral-800">
            Transcript text ({transcript.content.length.toLocaleString()} characters)
          </summary>
          <pre className="mt-3 max-h-80 overflow-auto rounded bg-neutral-50 p-3 text-xs leading-relaxed whitespace-pre-wrap text-neutral-800">
            {transcript.content}
          </pre>
        </details>
      </Card>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          tone="primary"
          onClick={() => void onExtract()}
          disabled={extracting || requirements.length > 0}
          title={
            requirements.length > 0
              ? "This transcript has already been extracted"
              : undefined
          }
        >
          {extracting ? "Extracting… this calls the model" : "Extract requirements"}
        </Button>

        {requirements.length > 0 ? (
          <p className="text-sm text-neutral-600">
            {requirements.length} requirement{requirements.length === 1 ? "" : "s"}
            {flagged > 0 ? (
              <span className="font-medium text-amber-800">
                {" "}
                · {flagged} need{flagged === 1 ? "s" : ""} review
              </span>
            ) : null}
          </p>
        ) : null}
      </div>

      {extractError ? (
        <ErrorBanner message={extractError} onRetry={() => void onExtract()} />
      ) : null}

      {state.kind === "loading" ? <Loading what="requirements" /> : null}
      {state.kind === "error" ? (
        <ErrorBanner message={state.message} onRetry={reload} />
      ) : null}

      {state.kind === "ready" && state.value.length === 0 && !extracting ? (
        <Empty>
          Nothing extracted yet. Run the Extractor to turn this conversation into
          structured requirements.
        </Empty>
      ) : null}

      {state.kind === "ready" && state.value.length > 0 ? (
        <RequirementList
          requirements={state.value}
          transcript={transcript}
          onPropose={(requirement) => void onPropose(requirement)}
          proposingId={proposingId}
          proposeError={proposeError}
        />
      ) : null}
    </div>
  );
}
