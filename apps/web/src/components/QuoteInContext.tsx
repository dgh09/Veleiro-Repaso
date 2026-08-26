import { useEffect, useRef } from "react";

/**
 * The transcript with the source quote highlighted in place.
 *
 * SPEC calls the one-click evidence check "the trust mechanism of the whole
 * product", and this is it. The consultant does not have to take the agent's
 * word that a quote is real, or eyeball two blocks of text side by side - the
 * span is shown inside the sentences around it, in the document it came from.
 *
 * The offsets were computed and stored at extraction time against the original
 * text, so the highlight lands on the real characters even when the model
 * re-emitted the quote with different whitespace or punctuation.
 */
export function QuoteInContext({
  content,
  start,
  end,
}: {
  content: string;
  start: number | null;
  end: number | null;
}) {
  const markRef = useRef<HTMLElement>(null);

  useEffect(() => {
    // Bring the evidence into view rather than making someone hunt for it in a
    // long transcript.
    markRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [start, end]);

  const located =
    start !== null && end !== null && start >= 0 && end > start && end <= content.length;

  if (!located) {
    return (
      <div>
        <p className="mb-2 rounded border border-amber-400 bg-amber-50 p-2 text-xs text-amber-950">
          This quote could not be located in the transcript, so there is nothing to
          highlight. That is why the requirement was flagged.
        </p>
        <pre className="max-h-72 overflow-auto rounded bg-neutral-50 p-3 text-xs leading-relaxed whitespace-pre-wrap text-neutral-800">
          {content}
        </pre>
      </div>
    );
  }

  return (
    <pre className="max-h-72 overflow-auto rounded bg-neutral-50 p-3 text-xs leading-relaxed whitespace-pre-wrap text-neutral-800">
      {content.slice(0, start)}
      <mark ref={markRef} className="rounded bg-yellow-200 px-0.5 text-neutral-900">
        {content.slice(start, end)}
      </mark>
      {content.slice(end)}
    </pre>
  );
}
