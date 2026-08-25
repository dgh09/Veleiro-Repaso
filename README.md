# Veleiro — Discovery to Config

A miniature supervised AI delivery platform for CRM consulting.

A consultant uploads the transcript of a discovery meeting. The system extracts
structured CRM requirements from it, proposes the corresponding configuration
changes, and puts those proposals in a queue where a human approves or rejects
them before anything is applied.

> **The agent proposes. The human approves. Only then does anything execute.**

Read [`CLAUDE.md`](./CLAUDE.md) for the architectural invariants and
[`SPEC.md`](./SPEC.md) for the phased build plan.

**Status: Phase 1 complete.** The schema exists and every read is tenant-scoped.
There is no agent and no LLM call yet.

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

Then open <http://localhost:5173>. The page reports the result of
`GET /health`, which is answered only after the API completes an actual query
against Postgres.

| Script | What it does |
|---|---|
| `npm run dev` | API on :3001 and web on :5173, together |
| `npm run db:up` | Start Postgres and wait until its healthcheck passes |
| `npm run db:down` | Stop Postgres, keep the data |
| `npm run db:reset` | Destroy the volume and start clean |
| `npm run db:generate` | Generate a migration from the schema |
| `npm run db:migrate` | Apply pending migrations |
| `npm run db:seed` | Insert the two demo tenants (idempotent) |
| `npm run typecheck` | `tsc --noEmit` across all workspaces |
| `npm run test` | Vitest |

## Layout

```
apps/api          Hono server, agents, DB access
apps/web          React approval UI
packages/shared   Zod schemas and types shared by api and web
docker            docker-compose.yml
```

---

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

---

Sections on architecture, evaluation results and known failure modes arrive with
Phase 7.
