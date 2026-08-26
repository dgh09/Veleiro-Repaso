import { useCallback, useState } from "react";
import type { ProjectResponse } from "@veleiro/shared";

import { listProjects } from "./api/client";
import { IDENTITIES, loadIdentity, saveIdentity, type Identity } from "./identity";
import { Button, Empty, ErrorBanner, Loading } from "./ui/atoms";
import { useAsync } from "./ui/useAsync";
import { AuditTrail } from "./views/AuditTrail";
import { MetricsPanel } from "./views/MetricsPanel";
import { ProposalQueue } from "./views/ProposalQueue";
import { TranscriptsTab } from "./views/TranscriptsTab";

/**
 * The whole console: pick who you are, pick a project, then move between the
 * three things a consultant does - read what was extracted, decide on what was
 * proposed, and check the record of both.
 *
 * Navigation is component state rather than a router. That is a deliberate
 * limitation (no deep links, no back button) taken because a router would be a
 * new dependency and CLAUDE.md asks before adding those.
 */

type Tab = "transcripts" | "proposals" | "audit";

const TABS: { id: Tab; label: string }[] = [
  { id: "transcripts", label: "Transcripts & requirements" },
  { id: "proposals", label: "Proposal queue" },
  { id: "audit", label: "Audit trail" },
];

export function App() {
  const [identity, setIdentity] = useState<Identity>(loadIdentity);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("transcripts");
  // Bumped when a proposal is created, so the queue re-reads when it is opened.
  const [queueKey, setQueueKey] = useState(0);

  const load = useCallback(() => listProjects(identity), [identity]);
  const { state, reload } = useAsync(load, [identity.userId]);

  function changeIdentity(next: Identity): void {
    setIdentity(next);
    saveIdentity(next);
    // Another tenant's project ids mean nothing here, and holding one would
    // just produce a 404 on the next read.
    setProjectId(null);
  }

  const projects: ProjectResponse[] = state.kind === "ready" ? state.value : [];
  const project = projects.find((p) => p.id === projectId) ?? null;

  return (
    <div className="min-h-screen bg-neutral-50 font-sans text-neutral-900">
      <header className="border-b border-neutral-200 bg-white">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-6 py-4">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">
              Veleiro — Discovery to Config
            </h1>
            <p className="text-xs text-neutral-600">
              The agent proposes. You approve. Only then does anything execute.
            </p>
          </div>

          <label className="flex items-center gap-2 text-xs text-neutral-600">
            {/* Standing in for login: tenant and user come from headers. */}
            Acting as
            <select
              value={identity.userId}
              onChange={(event) => {
                const next = IDENTITIES.find((i) => i.userId === event.target.value);
                if (next) changeIdentity(next);
              }}
              className="rounded border border-neutral-300 bg-white px-2 py-1 text-sm text-neutral-900"
            >
              {IDENTITIES.map((option) => (
                <option key={option.userId} value={option.userId}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-6">
        {state.kind === "loading" ? <Loading what="projects" /> : null}
        {state.kind === "error" ? (
          <ErrorBanner message={state.message} onRetry={reload} />
        ) : null}

        {state.kind === "ready" && projects.length === 0 ? (
          <Empty>
            No projects for {identity.tenantName}. Run <code>npm run db:seed</code> to
            create the sample data.
          </Empty>
        ) : null}

        {state.kind === "ready" && projects.length > 0 ? (
          <div className="flex flex-col gap-6">
            <MetricsPanel identity={identity} />

            <section>
              <h2 className="mb-2 text-xs font-semibold tracking-wide text-neutral-500 uppercase">
                {identity.tenantName}
              </h2>
              <div className="flex flex-wrap gap-2">
                {projects.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => setProjectId(option.id)}
                    className={`rounded-lg border px-3 py-2 text-left text-sm ${
                      option.id === projectId
                        ? "border-neutral-900 bg-neutral-900 text-white"
                        : "border-neutral-300 bg-white text-neutral-900 hover:border-neutral-500"
                    }`}
                  >
                    <span className="block font-medium">{option.name}</span>
                    <span
                      className={`block text-xs ${
                        option.id === projectId ? "text-neutral-300" : "text-neutral-500"
                      }`}
                    >
                      {option.clientName}
                    </span>
                  </button>
                ))}
              </div>
            </section>

            {project === null ? (
              <Empty>Pick a project to begin.</Empty>
            ) : (
              <section className="flex flex-col gap-4">
                <nav className="flex flex-wrap gap-2 border-b border-neutral-200">
                  {TABS.map((entry) => (
                    <button
                      key={entry.id}
                      type="button"
                      onClick={() => setTab(entry.id)}
                      className={`-mb-px border-b-2 px-3 py-2 text-sm ${
                        entry.id === tab
                          ? "border-neutral-900 font-medium text-neutral-900"
                          : "border-transparent text-neutral-600 hover:text-neutral-900"
                      }`}
                    >
                      {entry.label}
                    </button>
                  ))}
                </nav>

                {tab === "transcripts" ? (
                  <TranscriptsTab
                    identity={identity}
                    projectId={project.id}
                    onProposed={() => setQueueKey((k) => k + 1)}
                  />
                ) : null}

                {tab === "proposals" ? (
                  <ProposalQueue key={queueKey} identity={identity} projectId={project.id} />
                ) : null}

                {tab === "audit" ? (
                  <AuditTrail identity={identity} projectId={project.id} />
                ) : null}
              </section>
            )}
          </div>
        ) : null}
      </main>

      <footer className="mx-auto max-w-5xl px-6 pb-8">
        <Button onClick={reload}>Reload projects</Button>
      </footer>
    </div>
  );
}
