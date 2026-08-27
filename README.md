# Veleiro — Discovery to Config

A miniature supervised AI delivery platform for CRM consulting.

A consultant uploads the transcript of a discovery meeting. The system extracts
structured CRM requirements from it, proposes the corresponding configuration
changes, and puts those proposals in a queue where a human approves or rejects
them before anything is applied.

> **The agent proposes. The human approves. Only then does anything execute.**

Read [`CLAUDE.md`](./CLAUDE.md) for the architectural invariants and
[`SPEC.md`](./SPEC.md) for the phased build plan.

**Status: complete.** A transcript goes in one end and an applied configuration
change comes out the other, with a human decision and an audit row at every
step.

---

## Prerequisites

- Node.js 20+ (developed on 22)
- Docker Desktop, running

## Run it

```bash
cp .env.example .env
npm install
npm run db:up
npm run db:migrate
npm run db:seed
npm run dev
```

Then open <http://localhost:5173>.

### The walkthrough

The seed creates two consulting firms with two projects each, so there is
something to click the moment the page loads.

1. **Pick who you are.** The *Acting as* selector in the header is the
   authentication stub: it sets the `X-Tenant-Id` / `X-User-Id` pair on every
   request. Switching between Ana (Northwind) and Chika (Meridian) is the
   fastest way to watch tenant isolation work — the other firm's projects do
   not appear, because the repository layer filtered them out before the API
   ever formed a response.
2. **Pick a project.** Every seeded project already carries one discovery
   transcript, and *Transcripts & requirements* takes a pasted one of your own.
3. **Run the Extractor** with *Extract requirements*. This is a real model call
   and takes a second or two. What comes back is a list of requirements, each
   with the verbatim quote it came from — click one to see it highlighted in
   the transcript itself.
4. **Look at what is flagged.** Anything `needs_review` sorts to the top with
   the reason attached, and has no *Propose* button. A requirement whose quote
   could not be found in the transcript cannot become a proposal at all; that
   is the guardrail, not a UI state.
5. **Propose a change** from a clean requirement. The result is a row in the
   queue, never a change to anything.
6. **Decide, in the *Proposal queue* tab.** *Approve* runs the connector and is
   the only path in the system that does. *Reject* requires a typed reason
   before the button enables.
7. **Read the record** in *Audit trail*: who did what, when, and what the value
   was before and after — agent actions and human decisions in the same list.

The panel above the project picker is `GET /api/metrics` for the current
tenant: model calls, tokens, spend, and the approval and rejection rates.

| Script | What it does |
|---|---|
| `npm run dev` | API on :3001 and web on :5173, together |
| `npm run db:up` | Start Postgres and wait until its healthcheck passes |
| `npm run db:down` | Stop Postgres, keep the data |
| `npm run db:reset` | Destroy the volume and start clean |
| `npm run db:logs` | Follow the Postgres container log |
| `npm run db:generate` | Generate a migration from the schema |
| `npm run db:migrate` | Apply pending migrations |
| `npm run db:seed` | Insert the two demo tenants (idempotent) |
| `npm run llm:smoke` | One real call to the configured model, to prove the wire works |
| `npm run eval` | Score the Extractor against the golden dataset |
| `npm run typecheck` | `tsc --noEmit` across all workspaces |
| `npm run test` | Vitest |

## Layout

```
apps/api          Hono server, agents, DB access
apps/web          React approval UI
packages/shared   Zod schemas and types shared by api and web
evals             Golden dataset and committed run reports
docker            docker-compose.yml
```

The eval *runner* lives in `apps/api/src/evals/` rather than in `/evals`, which
deviates from SPEC's layout. It has to import the Extractor, and `apps/api` is a
private workspace with no library export surface; making one exist purely so the
harness could import through it would be worse than the deviation. The dataset
and the reports — the parts anyone reads or diffs — are where SPEC puts them.

## Architecture

```
   consultant
       |
       v
  +----------------------------+
  |  React UI (apps/web)       |  parses every response with the shared schema
  +----------------------------+
       |  X-Tenant-Id / X-User-Id      (the auth stub)
       v
  +----------------------------+
  |  Hono API (apps/api)       |
  |  tenant middleware         |  401 no headers / 403 user not in tenant
  +----------------------------+
       |
       v
  +----------------------------+
  |  repositories/             |  the ONLY place tenant_id is applied
  +----------------------------+
       |
       v
  +----------------------------+
  |  PostgreSQL                |
  +----------------------------+

  agents (propose)                    approvals (execute)
  +---------------------+             +---------------------+
  |  Extractor          |             |  approvals/service  |
  |  Proposer           |             |         |           |
  +---------------------+             +---------|-----------+
       |                                        v
       |  writes rows                  +---------------------+
       |  status: pending              |  connectors/stub    |--> "CRM"
       v                               +---------------------+
  +---------------------+                       ^
  |  proposals table    |-----------------------+
  +---------------------+   only after a human clicks approve

  Note what is missing: there is no arrow from an agent to the connector.
  The agent modules hold no reference to one. That is CLAUDE.md's first rule
  made checkable by reading imports rather than by tracing call sites.

  Every model call, success or failure, writes a row to llm_calls.
  Every state change writes a row to audit_log, in the same transaction.
```

---

## The API

`/health` is public. Everything under `/api` requires the `X-Tenant-Id` and
`X-User-Id` header pair: missing headers are 401, a user who does not belong to
the tenant is 403, and another tenant's row is 404 rather than 403 — see
[Verifying isolation by hand](#verifying-isolation-by-hand) for why.

| Method | Path | What it does |
|---|---|---|
| GET | `/health` | Liveness, answered only after a real query against Postgres |
| GET | `/api/projects` | The calling tenant's projects |
| GET | `/api/projects/:id` | One project |
| GET | `/api/projects/:id/transcripts` | Transcripts in a project |
| POST | `/api/projects/:id/transcripts` | Upload a transcript (201) |
| GET | `/api/projects/:id/audit` | The audit trail for a project |
| GET | `/api/transcripts/:id` | One transcript, full text — the UI highlights quotes in it |
| GET | `/api/transcripts/:id/requirements` | What the Extractor produced |
| POST | `/api/transcripts/:id/extract` | **Runs the Extractor** (201) |
| POST | `/api/requirements/:id/propose` | **Runs the Proposer** (201) |
| GET | `/api/proposals` | The queue; `?status=` and `?projectId=` filter it |
| POST | `/api/proposals/:id/approve` | **The only path that reaches the connector** |
| POST | `/api/proposals/:id/reject` | Requires a reason in the body |
| GET | `/api/metrics` | This tenant's model usage, spend, and decision rates |

Three status codes carry most of the design:

**409 means "this would duplicate or launder something".** Extracting a
transcript twice, proposing a requirement twice, proposing one that is flagged
`needs_review`, or proposing one that was discarded. None of these are made
into a silent no-op, because none of them have a key that would make a second
run idempotent — the model does not return the same text twice.

**502 means the model failed, not the caller.** The typed `AgentFailure` is
described in the body rather than returned raw, since it can carry the model's
own output.

**200 on approve does not mean the CRM accepted the change.** The request
promised to record the approval and attempt the apply; whether the connector
took it is in the body, and the proposal survives as `failed` if it did not.
Approving an already-settled proposal is also a 200, with `applied: false`.

## Notes for whoever runs this next

**Postgres is on host port 5433, not 5432.** A native PostgreSQL install
commonly owns 5432, and the collision does not surface as "connection refused" —
you silently reach the wrong server and get an authentication failure (`28P01`)
for a user that only exists in the container. If you change the port, change it
in both `docker/docker-compose.yml` and `DATABASE_URL`.

**The database healthcheck has a 90 second `start_period`.** On first run the
Postgres entrypoint does `initdb`, starts a temporary server, creates the
database, then restarts. On a modest laptop that took over 30 seconds and
marked the container unhealthy. Failures inside `start_period` do not consume
`retries`.

**`.env` is read once at process start.** `tsx watch` reloads changed source
files but not the env file, so after editing `.env` you have to restart
`npm run dev` — otherwise the old values are still in effect and the symptom
looks like a code bug.

## Design decisions

**The LLM provider is configuration, not a dependency.** SPEC Phase 2 already
requires driving the loop with a fake client, so the interface has to exist
regardless. One implementation speaking the OpenAI-compatible
`/chat/completions` shape over plain `fetch` covers both a free hosted tier and
a local Ollama at `http://localhost:11434/v1`, with no code change and no vendor
SDK. The project must cost $0 to run.

To go fully offline, install Ollama natively (not in Compose — GPU passthrough
on Windows needs WSL2 plus the NVIDIA Container Toolkit), then switch the
commented block in `.env`. Note that 4 GB of VRAM caps you at roughly a 3B
model, which is weak at the verbatim quoting Phase 3 depends on.

**No agent framework, on purpose.** The loop in
`apps/api/src/agents/runtime/loop.ts` is about a hundred and fifty lines: send
the conversation, run any tool calls, append the results, stop at a hard cap.
Writing it by hand is part of the brief, but the practical argument is that
every decision about what happens when a model misbehaves is visible in one
readable file — how many times it may correct a malformed tool argument, what
happens when it invents a tool name, what a failure returns. Those are the
decisions that matter in a supervised system, and in a framework they are
someone else's defaults.

**Quote verification is code, and it is normalised.** SPEC says the check must
not be a prompt instruction, and the reason is simple: a model asked whether its
own evidence is real will say yes. But SPEC's wording reads as an exact
substring test, and implemented that way it would have been worse than useless.
A transcript wraps lines; a model re-emitting a span through JSON collapses
those newlines to spaces, folds typographic quotes to ASCII, and fixes
capitalisation. Every one of those honest extractions would have been recorded
as a hallucination, and the hallucination-rate metric would have measured
Unicode rather than truthfulness. So whitespace, punctuation and case are folded
before comparison, while the offsets returned still index the original text —
which is what lets the UI highlight the real characters. It caught a genuine
stitch in the eval run: the model had joined two separate passages of one
transcript into a single quote.

**Contradiction detection covers only the half that is decidable.** SPEC asks
for "same object+field, incompatible types or opposite intent". The first is
provable. The second is not: deciding that "make the description required" and
"agents must be able to save it blank" conflict is itself a language-
understanding judgement, and handing it back to the model that produced both
statements is the move SPEC forbids everywhere else. So the detector proves type
mismatches and semantic contradiction is documented as out of scope, caught by
the human in the queue. The golden dataset contains a case for it that the
system is expected to fail, so the size of that gap is a number rather than a
footnote.

**Risk is assigned by rule, and the prompt never mentions risk.** Risk is what a
human uses to decide how much attention a change deserves. A model assigning its
own risk is grading its own homework, and the failure is silent: a confidently
worded "low risk" on a change that retypes a column reads exactly like a correct
one. `agents/proposer/risk.ts` decides from the payload alone, so the same
change described in alarming or reassuring prose scores identically — there is a
test that asserts precisely that.

**Approving twice applies once, and that is a database guarantee.** The status
predicate lives inside the `UPDATE`, so Postgres picks the winner between two
concurrent approvals and exactly one comes back with a row. Reading the status
and then updating would leave a window where both callers believe they won and
the connector runs twice. The test asserts it against a connector that counts
its calls, not against the status column — the column looks identical either
way.

**The stored payload is re-parsed on the way out of the database.** It is
`jsonb`, so it arrives as `unknown`, and it began as model output. Trusting it
because it was valid when written would mean the one component that touches a
real system runs on unvalidated data.

### Foundations

These came first, in the scaffold, and everything above rests on them. They
are listed last because they are the least specific to this product, not
because they matter least — the seams they created are what let the agent
layer be tested without a model or a database.

**Errors are values at boundaries.** `pingDb()` returns
`{ ok: true } | { ok: false, error }` rather than throwing, and the health route
decides what to log and what to expose. The reason is logged server-side; the
client gets a status, never a stack trace. Drizzle wraps driver errors, so the
outer message is only ever `Failed query: select 1` — `describeDbError()` in
`apps/api/src/db/client.ts` flattens the `cause` chain so one log line is enough
to diagnose. That is what turned an opaque failure into a diagnosable one when
the container was losing port 5432 to a native Postgres install.

**The response is parsed on the way out, not just on the way in.**
`HealthResponseSchema` lives in `packages/shared` and both the API and the web
app parse against it. Drift between the handler and the contract fails at the
handler, not in the UI.

**`status` and `db` are enums, not the literal `"ok"`.** A schema that can only
describe success forces the client to invent its own error shape. SPEC Phase 5
forbids UI that claims success before the server confirms, and that starts here.

**Routes are built without listening.** `createApp()` returns the Hono app and
`index.ts` owns the socket, so tests drive the app through `app.request()` with
no server and no database. Dependencies are injected for the same reason — the
same seam the agent loop needs in Phase 2 to run against a fake LLM client.

## Tenant isolation: repository layer vs row-level security

SPEC asks for this trade-off in writing, so here it is.

**What was built.** Every database read goes through a function in
`apps/api/src/db/repositories/` that takes a `TenantContext` as its first
argument. The `tenant_id` predicate is built in exactly one place —
`repositories/context.ts` — and every repository routes through it. Route
handlers never import the Drizzle client; they call repositories.

**What that actually buys, and what it does not.** SPEC's goal sentence says a
leak should be "structurally impossible". It is not. A repository layer is a
*convention*: one `import { db }` in a route walks straight past it, and the
only thing standing in the way is a reviewer noticing. So the convention is
enforced by a test — `src/routes/no-direct-db.test.ts` fails the build if any
file under `src/routes/` imports the client, drizzle-orm, or the table
definitions. That caught a real violation the first time it ran: the health
route was importing `db/client` for its ping, which is why `pingDb` now lives
under `repositories/` like everything else. A test is a weaker guarantee than
the database refusing, but it is an honest one, and it fails loudly.

**What RLS would buy.** Postgres row-level security is the genuinely structural
answer: `SET LOCAL app.tenant_id` per request plus a policy per table, and then
even a hand-written query in a route cannot see another tenant's rows. The
guarantee moves from "we always remember" to "the database will not serve it".

**Why it was not chosen here.** CLAUDE.md rule 2 names the repository layer as
the enforcement point, so RLS would contradict the brief. Beyond that: RLS
requires every connection to carry per-request session state, which is subtle
with a pool (a leaked `SET` on a recycled connection is a leak in the other
direction), it needs a second non-privileged role to be meaningful since the
table owner bypasses policies by default, and it makes tests slower and harder
to read. For a system this size the repository layer plus the import guard is
the better ratio. **In production handling real client data, this would be RLS
*and* the repository layer, not one of them.**

## Notes on the schema

**Four columns are not in SPEC's table.** `requirements.review_reason` and
`related_requirement_id` exist because Phase 3 flags contradictory
requirements "with a linked note" and Phase 5 has to show the human *why* an
item needs review — neither is possible with the columns SPEC lists.
`source_quote_start` / `source_quote_end` exist because Phase 5's one-click
evidence view is the trust mechanism of the whole product, and Phase 3's quote
verification already computes the offset. All four are nullable.

**`audit_log.actor_id` is text, not a foreign key**, because the actor may be
an agent, which has no row in `users`. The cost of SPEC's single `actor_id`
column is that referential integrity on the user case is not enforced.

**`llm_calls.cost_usd` is `numeric`, not a float.** It is money. Drizzle
returns it as a string, which is correct for exact values. On a free tier it is
zero, computed from a rate table rather than hardcoded, so the column stays
honest if a paid model is ever plugged in.

**Migrations do not roll back.** Drizzle Kit generates no down migrations and
has no rollback command. Hand-writing them would mean a second source of truth
that desyncs the moment someone forgets to update it. Without a production
database, the property worth protecting is that the schema rebuilds from
nothing — `npm run db:reset && npm run db:migrate` — and
`src/db/migrate.test.ts` asserts exactly that against a throwaway database,
including that every business table carries `tenant_id`. SPEC's "and roll
back" was reinterpreted rather than met.

**A missing tenant header returns 401.** It is really a 400 — there is no
authentication to fail — but SPEC asks for 401 because this is where auth would
go. A well-formed pair whose user does not belong to the tenant returns 403:
without that check, any caller could pair their own tenant id with another
tenant's user id and write a forged actor into the audit log.

## Evaluation

`npm run eval` runs the Extractor against 18 hand-written transcripts in
`evals/dataset/` and writes a timestamped report to `evals/reports/`. Both runs
below are committed, so the comparison is reproducible rather than described.

Requirements are matched on **object + field**, as SPEC specifies — titles and
wording are the model's to choose. Names are compared with casing, separators
and the `__c` suffix removed, because `SLA_Due_Date` and `SlaDueDate` are the
same answer in different clothes.

| | `extractor.v1` | `extractor.degraded.v1` |
|---|---|---|
| Precision | 100% | 100% |
| Recall | 100% | 100% |
| F1 | 100% | 100% |
| Hallucinated quotes | **10%** | **20%** |
| Adversarial flagging | 50% | 50% |
| Flags on clean cases | **16.7%** | **33.3%** |
| Agent failures | 0 | 0 |
| Tokens | 18,686 in / 4,105 out | 11,612 in / 3,633 out |
| Avg latency | 1,205 ms | 919 ms |

### What these numbers mean, and what they do not

**The 100% is not the interesting number, and it is not evidence of much.**
Eighteen cases, written by the same person who wrote the prompt, on a matcher
that was corrected after seeing a first run. It says the model finds the right
object and field on transcripts of this shape. It does not generalise to a real
two-hour call.

**Precision and recall are saturated, which makes them useless as a regression
detector here.** That is the honest reading of the degraded column. SPEC's
acceptance criterion is that deliberately worsening the prompt makes the score
drop measurably, and it does — but not on the headline metric. A two-line prompt
still finds the right field on these transcripts, so precision and recall cannot
tell the two prompts apart. Harder cases, or transcripts with several plausible
near-misses, would be needed before those two numbers could detect anything.

**The hallucination rate is the metric that actually works.** The degraded
prompt differs from the real one mainly by having no verbatim-quote instruction,
and the hallucinated-quote rate doubled, 10% to 20%, exactly as that removal
predicts. That is the number to watch when the prompt changes.

**Adversarial flagging did not move, because those failures are structural.**
Both prompts miss the same three cases, and no prompt fixes them: two are the
confidence problem described under failure modes, and one is the semantic
contradiction the detector is documented as unable to see.

**The flags on clean cases were correct flags.** In the `extractor.v1` run they
were `case-sla-due` and `contact-preferred-channel`, and in both the model had
produced a quote that was not verbatim — one stitched from two separate passages
of the transcript. The guardrail caught the model doing exactly the thing it
exists to catch. The metric is named `flagsOnCleanCasesRate` rather than
"false alarm rate" for that reason: it is a count of clean transcripts that
still needed a human, not an accusation that the flag was wrong.

To reproduce, with the database running:

```bash
npm run eval                                        # the current prompt
npm run eval -w @veleiro/api -- --prompt degraded   # the control
```

Flags have to go to the workspace script; npm swallows them on the root one.

## Known failure modes

Named specifically, because a list of weaknesses that could describe any system
is not a list of weaknesses.

**Confidence does not measure what the flagging rule needs it to.** The rule is
`confidence < 0.6 -> needs_review`, and the eval shows it does not catch
under-specification. On the case where the client says "we need the stage to be
a proper picklist" and then explicitly refuses to name the values, the model
returned **0.95** — and it is not wrong to. It is confident about *what* was
asked; the missing part is a *detail*, and a single scalar cannot express "sure
about the request, unsure about the specifics". Two of the three missed
adversarial flags are this one problem. The fix is not a different threshold, it
is a second signal: ask the model to enumerate what it had to assume, and flag
on a non-empty list rather than on a number.

**Semantic contradiction is not detected at all.** Documented above and measured
by a dataset case that is expected to fail. Same object, same field, opposite
intent, no type mismatch — the detector cannot see it and nothing else will
either until a human reads the queue.

**The prompt-injection defence is untested against a real attacker.** The
transcript arrives delimited, the delimiters are stripped from its content so it
cannot close its own block, and the prompt says its contents are never
instructions. The eval case passes. But that case is one instruction I wrote,
and someone who wanted through would not use the phrasing I thought of.
Delimiters are a mitigation, not a boundary.

**Nothing bounds the transcript size.** A two-hour call pasted in whole would be
sent to the model in one request. There is no chunking and no length check, so
the failure at some size is a provider error rather than a degraded answer. The
demo transcripts are a few hundred characters and this has never been hit.

**Extraction and proposal are one call each, with no queue.**
`POST /api/transcripts/:id/extract` and `POST /api/requirements/:id/propose`
each hold the HTTP request open for the length of a model call. That is fine for one
consultant and would not survive ten; it wants a job queue and a polling
endpoint, and the UI already models "loading" honestly enough to accommodate one.

**Re-extraction and re-proposal have no path.** Both refuse with a 409 rather
than silently duplicating, which is the safe half of the answer. The useful half
— running a transcript again after the prompt improves — does not exist.
Rejecting a proposal discards its requirement, so a rejection is terminal;
re-proposing with the human's stated reason fed back to the model is the obvious
next feature and is not built.

**The connector is a stub, and the interesting failures are the ones it cannot
have.** It cannot be half-applied, rate-limited, or succeed and then be rolled
back by someone else. A proposal stuck in `approved` because the process died
between the claim and the apply is possible today and has no recovery path;
against a real CRM that would need reconciliation, not just a retry.

**The cost figure is zero because the rate table says so.** `cost_usd` is
computed from a per-model rate table, and every entry in it is 0 because the
project runs on a free tier. That is the true number, not a placeholder, but it
means the cost metric has never been exercised against a non-zero rate.

**Test-suite flakiness is environmental and only partly mitigated.** The full
suite intermittently fails with `Connection terminated unexpectedly`, in a
different file each time. Postgres logs no fault and never approaches
`max_connections`: Docker Desktop's port forwarding on Windows drops the socket
under host I/O pressure. Migrations retry, because Drizzle knows which ones
already ran; ordinary queries deliberately do not, because re-running a
half-committed write is worse than the failure it would hide. Re-running the
suite is the workaround.

## Verifying isolation by hand

With the seed loaded and the API running:

```bash
A_T=11111111-1111-4111-8111-111111111111  # Northwind
A_U=11111111-0000-4000-8000-000000000001
B_T=22222222-2222-4222-8222-222222222222  # Meridian
B_U=22222222-0000-4000-8000-000000000001
B_P=22222222-2222-4222-8222-000000000001  # a Meridian project

curl -i localhost:3001/api/projects                                  # 401
curl -H "X-Tenant-Id: $A_T" -H "X-User-Id: $A_U"      localhost:3001/api/projects                                     # Northwind only
curl -i -H "X-Tenant-Id: $A_T" -H "X-User-Id: $A_U"      localhost:3001/api/projects/$B_P                                # 404, not 403
curl -i -H "X-Tenant-Id: $A_T" -H "X-User-Id: $B_U"      localhost:3001/api/projects                                     # 403, forged actor
```

Another tenant's row is indistinguishable from a missing one, deliberately:
"not found" must not become an existence oracle for other tenants' ids.
