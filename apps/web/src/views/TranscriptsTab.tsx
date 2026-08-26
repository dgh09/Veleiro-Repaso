import { useCallback, useState } from "react";
import type { TranscriptResponse } from "@veleiro/shared";

import { createTranscript, listTranscripts } from "../api/client";
import type { Identity } from "../identity";
import { Button, Card, Empty, ErrorBanner, formatTimestamp, Loading } from "../ui/atoms";
import { useAsync } from "../ui/useAsync";
import { TranscriptDetail } from "./TranscriptDetail";

/**
 * The transcripts of one project, plus the paste box that adds another.
 *
 * Selecting a transcript swaps this panel for its detail view rather than
 * navigating: there is no router in this app, because adding one would be a
 * dependency CLAUDE.md asks to be consulted about and the whole surface is four
 * screens. The cost is no deep links, which for a tool driven start to finish
 * in one sitting is a fair trade.
 */
export function TranscriptsTab({
  identity,
  projectId,
  onProposed,
}: {
  identity: Identity;
  projectId: string;
  onProposed: () => void;
}) {
  const load = useCallback(
    () => listTranscripts(identity, projectId),
    [identity, projectId],
  );
  const { state, reload, set } = useAsync(load, [identity.userId, projectId]);
  const [selected, setSelected] = useState<TranscriptResponse | null>(null);

  if (selected !== null) {
    return (
      <TranscriptDetail
        identity={identity}
        transcript={selected}
        onBack={() => setSelected(null)}
        onProposed={onProposed}
      />
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <NewTranscript
        identity={identity}
        projectId={projectId}
        onCreated={(transcript) => {
          if (state.kind === "ready") set([transcript, ...state.value]);
          setSelected(transcript);
        }}
      />

      <section>
        <h2 className="mb-3 font-semibold text-neutral-900">Discovery transcripts</h2>

        {state.kind === "loading" ? <Loading what="transcripts" /> : null}
        {state.kind === "error" ? (
          <ErrorBanner message={state.message} onRetry={reload} />
        ) : null}

        {state.kind === "ready" && state.value.length === 0 ? (
          <Empty>No transcripts yet. Paste one above to get started.</Empty>
        ) : null}

        {state.kind === "ready" && state.value.length > 0 ? (
          <ul className="flex flex-col gap-2">
            {state.value.map((transcript) => (
              <li key={transcript.id}>
                <button
                  type="button"
                  onClick={() => setSelected(transcript)}
                  className="w-full rounded-lg border border-neutral-200 bg-white p-3 text-left hover:border-neutral-400"
                >
                  <span className="block font-medium text-neutral-900">
                    {transcript.title}
                  </span>
                  <span className="mt-0.5 block text-xs text-neutral-500">
                    {transcript.meetingDate !== null
                      ? `Met ${formatTimestamp(transcript.meetingDate)} · `
                      : ""}
                    {transcript.content.length.toLocaleString()} characters
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </div>
  );
}

function NewTranscript({
  identity,
  projectId,
  onCreated,
}: {
  identity: Identity;
  projectId: string;
  onCreated: (transcript: TranscriptResponse) => void;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const usable = title.trim().length > 0 && content.trim().length > 0;

  async function onSubmit(): Promise<void> {
    setSaving(true);
    setError(null);

    const result = await createTranscript(identity, projectId, { title, content });
    setSaving(false);

    if (!result.ok) {
      setError(result.message);
      return;
    }

    setTitle("");
    setContent("");
    setOpen(false);
    onCreated(result.value);
  }

  if (!open) {
    // Wrapped so the button sizes to its label rather than stretching across
    // the flex column it lives in.
    return (
      <div>
        <Button tone="primary" onClick={() => setOpen(true)}>
          Paste a new transcript
        </Button>
      </div>
    );
  }

  return (
    <Card>
      <form
        className="flex flex-col gap-3 p-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (usable) void onSubmit();
        }}
      >
        <label className="text-sm font-medium text-neutral-800" htmlFor="transcript-title">
          Title
        </label>
        <input
          id="transcript-title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="Discovery call — Acme Industrial"
          className="rounded border border-neutral-300 p-2 text-sm"
        />

        <label className="text-sm font-medium text-neutral-800" htmlFor="transcript-content">
          Transcript
        </label>
        <textarea
          id="transcript-content"
          value={content}
          onChange={(event) => setContent(event.target.value)}
          rows={10}
          placeholder={"Consultant: Walk me through how your team tracks a deal today.\nClient: …"}
          className="rounded border border-neutral-300 p-2 font-mono text-xs"
        />

        {error ? <ErrorBanner message={error} /> : null}

        <div className="flex gap-2">
          <Button type="submit" tone="primary" disabled={!usable || saving}>
            {saving ? "Saving…" : "Save transcript"}
          </Button>
          <Button onClick={() => setOpen(false)} disabled={saving}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}
