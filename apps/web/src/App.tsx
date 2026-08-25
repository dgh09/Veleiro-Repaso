import { useCallback, useEffect, useState } from "react";
import { HealthResponseSchema, type HealthResponse } from "@veleiro/shared";

/**
 * Every state the client can actually be in gets its own case. No optimistic
 * "ok" while the request is in flight, and a response that does not match the
 * shared schema is a failure, not something to render around (CLAUDE.md: all
 * output is parsed before use).
 */
type HealthState =
  | { kind: "loading" }
  | { kind: "healthy"; data: HealthResponse }
  | { kind: "unhealthy"; data: HealthResponse }
  | { kind: "unreachable"; message: string };

async function fetchHealth(signal: AbortSignal): Promise<HealthState> {
  let res: Response;
  try {
    res = await fetch("/health", { signal });
  } catch (cause) {
    return {
      kind: "unreachable",
      message: `Could not reach the API: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }

  const parsed = HealthResponseSchema.safeParse(await res.json().catch(() => null));
  if (!parsed.success) {
    return {
      kind: "unreachable",
      message: `The API replied with ${res.status}, but the body did not match HealthResponseSchema.`,
    };
  }

  return parsed.data.status === "ok"
    ? { kind: "healthy", data: parsed.data }
    : { kind: "unhealthy", data: parsed.data };
}

export function App() {
  const [state, setState] = useState<HealthState>({ kind: "loading" });
  const [reloadKey, setReloadKey] = useState(0);

  const recheck = useCallback(() => {
    setState({ kind: "loading" });
    setReloadKey((k) => k + 1);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;

    void fetchHealth(controller.signal).then((next) => {
      if (active) setState(next);
    });

    return () => {
      active = false;
      controller.abort();
    };
  }, [reloadKey]);

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-6 p-8 font-sans">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Veleiro — Discovery to Config</h1>
        <p className="mt-1 text-sm text-neutral-600">
          Phase 0 scaffold. This page reports a real round-trip to Postgres.
        </p>
      </header>

      <section aria-live="polite">
        <StatusPanel state={state} />
      </section>

      <button
        type="button"
        onClick={recheck}
        className="self-start rounded border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-100"
      >
        Check again
      </button>
    </main>
  );
}

function StatusPanel({ state }: { state: HealthState }) {
  switch (state.kind) {
    case "loading":
      return <Panel tone="neutral" title="Checking…" body="Waiting for GET /health." />;

    case "healthy":
      return (
        <Panel
          tone="ok"
          title="API ok · database ok"
          body="The API answered and completed a query against Postgres."
        />
      );

    case "unhealthy":
      return (
        <Panel
          tone="bad"
          title={`API ok · database ${state.data.db}`}
          body="The API is running but its database round-trip failed. Try `npm run db:up`."
        />
      );

    case "unreachable":
      return <Panel tone="bad" title="No usable response" body={state.message} />;
  }
}

const TONES = {
  neutral: "border-neutral-300 bg-neutral-50 text-neutral-800",
  ok: "border-green-300 bg-green-50 text-green-900",
  bad: "border-red-300 bg-red-50 text-red-900",
} as const;

function Panel({
  tone,
  title,
  body,
}: {
  tone: keyof typeof TONES;
  title: string;
  body: string;
}) {
  return (
    <div className={`rounded-lg border p-4 ${TONES[tone]}`}>
      <p className="font-medium">{title}</p>
      <p className="mt-1 text-sm opacity-80">{body}</p>
    </div>
  );
}
