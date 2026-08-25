# CLAUDE.md — Discovery-to-Config Agent

Project context. Read this before doing anything. Everything in this repo is
written in English: code, comments, commit messages, PR descriptions, docs.

---

## What we are building

A miniature version of a supervised AI delivery platform for CRM consulting.

A consultant uploads the transcript of a discovery meeting with a client. The
system extracts structured CRM requirements from it, proposes the corresponding
configuration changes, and places those proposals in a queue where a human
approves or rejects them before anything is applied.

The one-line rule that governs the whole design:

> **The agent proposes. The human approves. Only then does anything execute.**

There is no code path in which an LLM output reaches the destination system
without a recorded human approval. If you find yourself writing one, stop and
flag it.

## Why it is built this way

This is a rehearsal project. The point is not feature count — it is to
demonstrate, end to end and in a small surface area:

1. An agent loop written from first principles, not glued together from a
   framework.
2. Guardrails that make agent output trustworthy enough to be client-facing.
3. Human-in-the-loop approval with a full audit trail.
4. Multi-tenant data isolation enforced at the data-access layer.
5. Evaluation: agent quality expressed as a number that can be tracked.

A small system that runs end to end beats an ambitious system that half-works.
When in doubt, cut scope, not correctness.

---

## Stack

- **Runtime:** Node.js 20+, TypeScript, strict mode on
- **API:** Hono
- **DB:** PostgreSQL 16 (via Docker Compose), Drizzle ORM + Drizzle Kit migrations
- **LLM:** any OpenAI-compatible `/chat/completions` endpoint, called with plain
  `fetch` — no vendor SDK. Configured by `LLM_BASE_URL` / `LLM_MODEL` /
  `LLM_API_KEY`. **The project must cost $0 to run**, so the default is a free
  hosted tier; a local Ollama is the offline fallback and needs no code change.
- **Validation:** Zod — every LLM output and every API boundary is parsed, never trusted
- **Frontend:** React + Vite + TypeScript, Tailwind (v4, via `@tailwindcss/vite`)
- **Tests:** Vitest
- **Everything runs with:** `docker compose up` + `npm run dev`

Do not add dependencies beyond these without asking. Specifically: **no
LangChain, no LangGraph, no agent framework.** The agent loop is written by hand
on purpose — that is part of the point of the project.

Approved beyond the list above, all dev-only: `concurrently` (one `npm run dev`
for both servers), `tsx`, `vitest`, `@tailwindcss/vite`, `@vitejs/plugin-react`.

## Repo layout

```
/apps/api          Hono server, agents, DB access
/apps/web          React approval UI
/packages/shared   Zod schemas and types shared by api and web
/evals             Golden dataset + eval runner
/docker            docker-compose.yml
SPEC.md            Phased build plan — the source of truth for what to build next
```

---

## Non-negotiable architecture rules

These are invariants. Violating one is a bug even if tests pass.

1. **No direct execution by the agent.** Agents write rows to `proposals`. A
   separate, human-triggered path applies them. The agent has no write access to
   the destination system, ever.

2. **Tenant isolation is enforced in one place.** All database reads and writes
   go through a repository layer that takes a `TenantContext` and injects the
   `tenant_id` filter. No route handler builds its own query. There must be no
   way to accidentally read another tenant's row.

3. **Every LLM call is logged.** Model, prompt version, input tokens, output
   tokens, latency, cost estimate, and the raw response — written to
   `llm_calls`. This is not optional instrumentation added later; it goes in
   with the first agent call.

4. **Every state change is audited.** `audit_log` records actor (user or agent),
   action, entity, before/after, and timestamp. Approvals and rejections
   included. Rejections must capture the human's stated reason.

5. **All LLM output is parsed with Zod before use.** If parsing fails, that is a
   handled failure with a retry-and-then-fail path, not an exception that
   escapes to a 500.

6. **Low confidence does not become a guess.** If the model's confidence for an
   extracted requirement is below threshold, or two requirements contradict each
   other, the item is flagged `needs_review` and surfaced to the human. It is
   never silently resolved.

7. **Applying a proposal is idempotent.** Approving twice must not apply twice.

## Conventions

- Strict TypeScript. No `any`. No non-null assertions to silence the compiler.
- Zod schemas live in `/packages/shared` and are the single definition of a
  shape; TypeScript types are derived with `z.infer`, never hand-written twice.
- Prompts live in versioned files under `/apps/api/src/agents/prompts/`, named
  `<agent>.v<n>.ts`. The version string is what gets logged. Prompts are never
  inlined in business logic.
- Errors are values at boundaries. Do not swallow. Do not log-and-continue.
- Conventional commits: `feat:`, `fix:`, `refactor:`, `test:`, `chore:`.
- Commit at the end of every phase, not before it passes its acceptance criteria.

---

## How I want you to work with me

- **Plan before you build.** For each phase in `SPEC.md`, propose the approach
  and the file changes first. Wait for me to approve. Do not write code for a
  phase I have not approved.
- **One phase at a time.** Do not run ahead into the next phase because it seems
  obvious.
- **Say when the spec is wrong.** If a requirement in `SPEC.md` is ambiguous,
  contradictory, or a bad idea, say so before building it. Proposing a better
  approach is more useful than faithfully implementing a flawed one. This is
  explicitly wanted, not tolerated.
- **Do not invent scope.** No auth system, no user management, no real
  Salesforce integration, no streaming UI, no multi-model support. If you think
  something is missing, ask instead of adding it.
  (Note: "no multi-model support" still holds. One `LlmClient` interface with
  one implementation and a configurable base URL is not multi-model support —
  there is no provider-selection feature, no routing, no fallback chain.)
- **Do not fabricate.** If you are unsure about an API signature in Drizzle, Zod
  or the LLM endpoint, say so and check rather than guessing plausibly.
- **Tests come with the code**, not in a cleanup phase afterwards.
- Keep responses short. I am reviewing every diff.

## Out of scope — do not build

- User authentication / login. Tenant and user come from a header stub.
- A real Salesforce or CRM connector. The connector is a local stub.
- Deployment, CI, cloud infra.
- Anything cosmetic in the UI beyond being legible and usable.
