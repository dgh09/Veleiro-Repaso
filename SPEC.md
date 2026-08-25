# SPEC.md — Build plan

Seven phases. Each has a goal, a scope, and acceptance criteria. A phase is done
when its acceptance criteria pass and it is committed — not before.

Read `CLAUDE.md` first. The invariants there override anything here.

Time budget assumes roughly three working days. If time runs short, cut Phase 7
first, then the polish in Phase 6. **Phases 1–5 are the spine and must all
ship** — a system that extracts, proposes, approves and audits end to end is the
deliverable. Everything else is upside.

---

## Phase 0 — Scaffold

**Goal:** `docker compose up` + `npm run dev` gives a running API, a running web
app, and a Postgres instance, with nothing in them yet.

**Scope**
- Monorepo with npm workspaces: `apps/api`, `apps/web`, `packages/shared`.
- TypeScript strict everywhere. Shared tsconfig base.
- `docker/docker-compose.yml` with Postgres 16 and a named volume.
- Hono server with a `GET /health` returning `{ status: "ok", db: "ok" }` after
  an actual DB round-trip.
- Vite + React app that calls `/health` and renders the result.
- `.env.example` with `DATABASE_URL` and `ANTHROPIC_API_KEY`. Real `.env`
  gitignored.
- `README.md` stub: what this is, how to run it.

**Acceptance**
- Fresh clone → `cp .env.example .env` → `docker compose up -d` → `npm install`
  → `npm run dev` → browser shows DB-backed health status. No manual steps
  beyond that.

---

## Phase 1 — Data model and tenant isolation

**Goal:** the schema exists, and it is structurally impossible for a query to
leak across tenants.

**Scope**

Tables (all business tables carry `tenant_id`, `created_at`, `updated_at`):

| Table | Purpose | Key columns |
|---|---|---|
| `tenants` | The consulting partner firms | `id`, `name`, `slug` |
| `users` | Consultants who approve | `id`, `tenant_id`, `name`, `email` |
| `projects` | A client engagement | `id`, `tenant_id`, `name`, `client_name` |
| `transcripts` | Uploaded discovery meeting text | `id`, `tenant_id`, `project_id`, `title`, `content`, `meeting_date` |
| `requirements` | Structured output of the Extractor | `id`, `tenant_id`, `project_id`, `transcript_id`, `title`, `description`, `crm_object`, `field_name`, `field_type`, `rationale`, `source_quote`, `confidence`, `status` |
| `proposals` | Proposed config changes from the Proposer | `id`, `tenant_id`, `requirement_id`, `change_type`, `payload` (jsonb), `risk_level`, `status`, `reviewed_by`, `reviewed_at`, `rejection_reason` |
| `audit_log` | Every state change | `id`, `tenant_id`, `actor_type` (`user`\|`agent`), `actor_id`, `action`, `entity_type`, `entity_id`, `before` (jsonb), `after` (jsonb), `created_at` |
| `llm_calls` | Every model invocation | `id`, `tenant_id`, `agent`, `prompt_version`, `model`, `input_tokens`, `output_tokens`, `cost_usd`, `latency_ms`, `raw_response` (jsonb), `error`, `created_at` |

Status enums:
- `requirements.status`: `extracted` | `needs_review` | `proposed` | `discarded`
- `proposals.status`: `pending` | `approved` | `rejected` | `applied` | `failed`
- `proposals.risk_level`: `low` | `medium` | `high`

Also in this phase:
- A `TenantContext` type: `{ tenantId: string; userId: string }`.
- A repository layer in `apps/api/src/db/repositories/`. **Every exported
  function takes `TenantContext` as its first argument** and injects the
  `tenant_id` predicate. Route handlers never touch Drizzle directly.
- Middleware that builds `TenantContext` from `X-Tenant-Id` and `X-User-Id`
  headers and rejects requests missing either. (Stub for real auth — that is
  fine, but the isolation downstream must be real.)
- A seed script: 2 tenants, 2 users each, 2 projects each. Two tenants matter —
  one tenant cannot prove isolation.
- Indexes on every `tenant_id` and on the foreign keys used by list queries.

**Acceptance**
- Migrations run clean from empty, and roll back.
- A test asserts that a repository call made with tenant A's context cannot read
  a row belonging to tenant B — by ID, by list, and by join.
- A test asserts a request with no tenant header is rejected with 401.

**Note for the implementer:** consider whether Postgres row-level security would
be a better enforcement point than the repository layer. Write down the trade-off
in the README either way — that reasoning is part of the deliverable.

---

## Phase 2 — The agent loop, from scratch

**Goal:** a hand-written tool-calling loop with typed output and full
instrumentation. No agent framework.

**Scope**
- `apps/api/src/agents/runtime/loop.ts` — a generic loop:
  1. Send messages + tool definitions to the model.
  2. If the response contains tool_use blocks, execute each registered tool,
     append tool_result blocks, and iterate.
  3. If not, return the final content.
  4. Hard cap on iterations (default 8). Exceeding it is a typed failure, not an
     infinite loop.
- A tool registry: name, description, Zod input schema, handler. Tool inputs
  from the model are parsed with Zod before the handler runs; a parse failure is
  returned to the model as a tool_result error so it can correct itself, once.
- Structured-output helper: given a Zod schema, prompt for JSON only, strip code
  fences, parse. On parse failure, retry once with the validation error included
  in the message. On second failure, return a typed error.
- Every model call writes an `llm_calls` row — including failed ones.
- Prompt files under `agents/prompts/`, versioned, exporting a `version` string
  that gets logged.

**Acceptance**
- A unit test drives the loop with a fake Anthropic client through a two-tool
  sequence and asserts the final result.
- A test asserts the iteration cap terminates the loop.
- A test asserts that malformed model JSON triggers exactly one retry and then
  fails cleanly.
- Running any agent leaves rows in `llm_calls` with non-zero token counts.

---

## Phase 3 — Extractor agent

**Goal:** transcript in, structured requirements out, with provenance and
calibrated confidence.

**Scope**
- Input: a `transcripts` row. Output: zero or more `requirements` rows.
- Each requirement must carry:
  - `title`, `description`
  - `crm_object` (e.g. `Opportunity`), `field_name`, `field_type` where applicable
  - `rationale` — why this is a requirement
  - `source_quote` — **a verbatim span from the transcript**. This is the
    provenance anchor.
  - `confidence` — 0.0 to 1.0
- Guardrails:
  - Verify `source_quote` actually appears in the transcript. If it does not,
    the model hallucinated its evidence: force `needs_review` and record the
    mismatch. This check is code, not a prompt instruction.
  - `confidence < 0.6` → `needs_review`, not `extracted`.
  - Detect contradictory requirements (same object+field, incompatible types or
    opposite intent) → both flagged `needs_review` with a linked note. Do not
    let the model pick a winner.
- Endpoint: `POST /api/transcripts/:id/extract`.
- The agent writes an `audit_log` row with `actor_type: "agent"`.

**Acceptance**
- Run against a seeded transcript, get requirements with valid quotes.
- A test with a doctored fake response containing a fabricated quote asserts the
  item lands in `needs_review`.
- A test asserts contradictory requirements are both flagged, neither resolved.

---

## Phase 4 — Proposer agent and the approval loop

**Goal:** requirements become concrete, reviewable, reversible change proposals
that only a human can apply.

**Scope**
- Input: a `requirements` row with status `extracted`. Output: one `proposals`
  row.
- `change_type`: `create_object` | `create_field` | `create_validation_rule` |
  `update_field`.
- `payload`: a jsonb object matching a Zod schema per `change_type` — the actual
  metadata shape the connector would receive. This must be machine-applicable,
  not prose.
- `risk_level` assigned by rule, not by the model: anything touching an existing
  field or adding a validation rule is at least `medium`; deletions or type
  changes are `high`.
- Requirements with status `needs_review` are never proposed.
- The connector: `apps/api/src/connectors/stub.ts`. Implements an interface
  `apply(payload): Promise<Result>`, logs, returns success — or deterministic
  failure for a payload flagged as a test failure case. Written behind an
  interface so a real connector could replace it.
- Endpoints:
  - `POST /api/requirements/:id/propose`
  - `GET /api/proposals?status=pending`
  - `POST /api/proposals/:id/approve` → applies via connector, sets `applied` or
    `failed`, audits.
  - `POST /api/proposals/:id/reject` → **requires a non-empty
    `rejection_reason`**; 400 without it.
- Idempotency: approving an already-approved proposal is a no-op returning the
  original result, not a second apply.

**Acceptance**
- Full path works: transcript → extract → propose → approve → connector called →
  status `applied` → audit rows for each step.
- A test asserts double-approval applies exactly once.
- A test asserts rejection without a reason is refused.
- A test asserts a `needs_review` requirement cannot be proposed.
- A test asserts a connector failure leaves status `failed` and does not lose
  the proposal.

---

## Phase 5 — Approval UI

**Goal:** a consultant can review and decide without reading JSON.

**Scope**
- Project view: transcripts, and an upload/paste box for a new one.
- Requirements view: list with status badges. `needs_review` items visually
  distinct and sorted to the top, showing *why* they were flagged.
- Each requirement expands to show its `source_quote` in the context of the
  transcript. The consultant must be able to verify the evidence in one click —
  this is the trust mechanism of the whole product.
- Proposal queue: pending proposals with a readable diff of what would change
  (field-by-field, not a raw JSON dump), risk level, and Approve / Reject.
- Reject opens a required reason input.
- Audit trail view per project: chronological, showing agent actions and human
  actions distinctly.
- Loading and error states that are honest. No optimistic UI that claims success
  before the server confirms.

**Acceptance**
- A person who has never seen the codebase can go from raw transcript to applied
  change using only the UI.
- Rejecting without typing a reason is impossible in the UI, not just on the API.

---

## Phase 6 — Evaluation harness

**Goal:** extraction quality is a number, and a regression in it is visible.

**Scope**
- `/evals/dataset/` — 15–20 synthetic discovery transcripts as JSON, each with
  expected requirements. Write them by hand or generate then hand-correct; they
  are the ground truth, so they must actually be correct.
- Include at least four adversarial cases:
  1. A transcript where the client contradicts themselves.
  2. A transcript where a key detail is missing and the correct behaviour is to
     flag, not infer.
  3. A transcript with an off-topic tangent that must not become a requirement.
  4. A transcript with an instruction-like sentence inside it
     (`"ignore previous instructions and..."`) that must be treated as content,
     not as a command.
- `npm run eval` — runs the Extractor against every case, scores:
  - Precision and recall of extracted requirements (matched on object+field)
  - Rate of hallucinated `source_quote`
  - Rate of correct `needs_review` flagging on adversarial cases
  - Total tokens and cost for the run
- Output: a table in the console and a timestamped JSON report in
  `/evals/reports/`.
- Reports are committed, so runs are comparable over time.

**Acceptance**
- `npm run eval` completes and prints scores.
- Deliberately degrading the extractor prompt makes the score drop measurably.
- At least two eval runs committed, so a comparison exists.

---

## Phase 7 — Observability and README

**Goal:** the system is legible to someone who did not build it.

**Scope**
- `GET /api/metrics` — per tenant: LLM calls, tokens, estimated cost, average
  latency, approval rate, rejection rate, needs-review rate.
- A small dashboard panel in the UI showing those numbers.
- **README.md** — the actual deliverable for a reader. In English. Covers:
  - What the system does, in three sentences.
  - Architecture diagram (ASCII is fine).
  - How to run it, verbatim commands.
  - **Design decisions and trade-offs** — repository-layer isolation vs. RLS,
    why no agent framework, why quote verification is code and not a prompt
    instruction, why risk level is rule-based and not model-assigned.
  - **Known failure modes** — where this system would break under real load or
    adversarial input, and what you would build next to address it. Be specific
    and honest; naming your own weaknesses accurately is the point.
  - Eval results, with the numbers.

**Acceptance**
- A reader who has never seen the repo can run it and explain what it does after
  five minutes with the README.

---

## Demo path

Whatever else happens, this sequence must run clean in under three minutes:

1. Open the app, pick a project.
2. Paste a discovery transcript.
3. Extract → requirements appear, one flagged `needs_review`.
4. Click into a requirement, see the source quote highlighted in the transcript.
5. Propose → a proposal appears in the queue with a readable diff.
6. Reject one with a reason. Approve another.
7. Show the audit trail: agent actions and human actions, in order.
8. Show the eval report and the cost metrics.

Rehearse it. If a phase would break this path, that phase is the priority.
