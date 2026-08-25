# Veleiro — Discovery to Config

A miniature supervised AI delivery platform for CRM consulting.

A consultant uploads the transcript of a discovery meeting. The system extracts
structured CRM requirements from it, proposes the corresponding configuration
changes, and puts those proposals in a queue where a human approves or rejects
them before anything is applied.

> **The agent proposes. The human approves. Only then does anything execute.**

Read [`CLAUDE.md`](./CLAUDE.md) for the architectural invariants and
[`SPEC.md`](./SPEC.md) for the phased build plan.

**Status: Phase 0 (scaffold) complete.** There is no schema, no agent and no LLM
call yet — only a monorepo whose three workspaces are wired together and prove a
real round-trip from the browser to Postgres.

---

## Prerequisites

- Node.js 20+ (developed on 22)
- Docker Desktop, running

## Run it

```bash
cp .env.example .env
npm install
npm run db:up
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
outer message is only ever `Failed query: select 1` — `describe()` in
`apps/api/src/db/client.ts` flattens the `cause` chain so one log line is enough
to diagnose.

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

---

Sections on architecture, evaluation results and known failure modes arrive with
Phase 7.
