import {
  type AnyPgColumn,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  ACTOR_TYPE,
  CHANGE_TYPE,
  PROPOSAL_STATUS,
  REQUIREMENT_STATUS,
  RISK_LEVEL,
} from "@veleiro/shared";

/**
 * Postgres enums are built from the same `as const` tuples that back the Zod
 * schemas in @veleiro/shared, so the database type and the validator cannot
 * drift apart.
 */
export const requirementStatusEnum = pgEnum("requirement_status", REQUIREMENT_STATUS);
export const proposalStatusEnum = pgEnum("proposal_status", PROPOSAL_STATUS);
export const riskLevelEnum = pgEnum("risk_level", RISK_LEVEL);
export const actorTypeEnum = pgEnum("actor_type", ACTOR_TYPE);
export const changeTypeEnum = pgEnum("change_type", CHANGE_TYPE);

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

// --- tenants -------------------------------------------------------------
// The only table without a tenant_id: it *is* the tenant. Never exposed
// through the tenant-scoped repository layer.

export const tenants = pgTable(
  "tenants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("tenants_slug_key").on(t.slug)],
);

// --- users ---------------------------------------------------------------

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    email: text("email").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("users_tenant_id_idx").on(t.tenantId),
    uniqueIndex("users_tenant_id_email_key").on(t.tenantId, t.email),
  ],
);

// --- projects ------------------------------------------------------------

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    clientName: text("client_name").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("projects_tenant_id_idx").on(t.tenantId)],
);

// --- transcripts ---------------------------------------------------------

export const transcripts = pgTable(
  "transcripts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    content: text("content").notNull(),
    meetingDate: timestamp("meeting_date", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("transcripts_tenant_id_idx").on(t.tenantId),
    index("transcripts_tenant_project_idx").on(t.tenantId, t.projectId),
  ],
);

// --- requirements --------------------------------------------------------

export const requirements = pgTable(
  "requirements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    transcriptId: uuid("transcript_id")
      .notNull()
      .references(() => transcripts.id, { onDelete: "cascade" }),

    title: text("title").notNull(),
    description: text("description").notNull(),

    // Not every requirement maps onto a field; some are objects or rules.
    crmObject: text("crm_object"),
    fieldName: text("field_name"),
    fieldType: text("field_type"),

    rationale: text("rationale").notNull(),

    // The provenance anchor: a verbatim span of the transcript. Phase 3
    // verifies it actually occurs there, in code, and records where.
    sourceQuote: text("source_quote").notNull(),
    sourceQuoteStart: integer("source_quote_start"),
    sourceQuoteEnd: integer("source_quote_end"),

    confidence: real("confidence").notNull(),
    status: requirementStatusEnum("status").notNull().default("extracted"),

    // Why this landed in needs_review, and - for contradictions - the sibling
    // it conflicts with. Not in SPEC's column list: Phase 3 flags items "with
    // a linked note" and Phase 5 must show the human *why*, and neither is
    // possible without somewhere to put it.
    reviewReason: text("review_reason"),
    relatedRequirementId: uuid("related_requirement_id").references(
      (): AnyPgColumn => requirements.id,
      { onDelete: "set null" },
    ),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("requirements_tenant_id_idx").on(t.tenantId),
    index("requirements_tenant_transcript_idx").on(t.tenantId, t.transcriptId),
    index("requirements_tenant_project_idx").on(t.tenantId, t.projectId),
    index("requirements_tenant_status_idx").on(t.tenantId, t.status),
  ],
);

// --- proposals -----------------------------------------------------------

export const proposals = pgTable(
  "proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    requirementId: uuid("requirement_id")
      .notNull()
      .references(() => requirements.id, { onDelete: "cascade" }),

    changeType: changeTypeEnum("change_type").notNull(),
    // The machine-applicable metadata the connector would receive. Its shape is
    // enforced per change_type by a Zod schema at the boundary, not by the DB.
    payload: jsonb("payload").notNull(),
    riskLevel: riskLevelEnum("risk_level").notNull(),
    status: proposalStatusEnum("status").notNull().default("pending"),

    reviewedBy: uuid("reviewed_by").references(() => users.id, { onDelete: "set null" }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    rejectionReason: text("rejection_reason"),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("proposals_tenant_id_idx").on(t.tenantId),
    index("proposals_tenant_status_idx").on(t.tenantId, t.status),
    index("proposals_requirement_id_idx").on(t.requirementId),
  ],
);

// --- audit_log -----------------------------------------------------------
// Append-only: no updated_at, because an audit row that can be edited is not
// an audit row.

export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    actorType: actorTypeEnum("actor_type").notNull(),
    // Text rather than a users FK because the actor may be an agent, which has
    // no row in users. Holds a user uuid when actor_type is "user", and the
    // agent identifier when it is "agent". The cost of SPEC's single actor_id
    // column is that referential integrity on the user case is not enforced.
    actorId: text("actor_id").notNull(),

    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    before: jsonb("before"),
    after: jsonb("after"),

    createdAt: createdAt(),
  },
  (t) => [
    index("audit_log_tenant_id_idx").on(t.tenantId),
    index("audit_log_tenant_entity_idx").on(t.tenantId, t.entityType, t.entityId),
    index("audit_log_tenant_created_at_idx").on(t.tenantId, t.createdAt),
  ],
);

// --- llm_calls -----------------------------------------------------------

export const llmCalls = pgTable(
  "llm_calls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    agent: text("agent").notNull(),
    promptVersion: text("prompt_version").notNull(),
    model: text("model").notNull(),

    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    // numeric, not float: this is money. Drizzle returns it as a string, which
    // is the correct default for exact values. Zero on a free tier, computed
    // from a rate table rather than hardcoded, so the column stays honest if a
    // paid model is ever plugged in.
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }).notNull().default("0"),
    latencyMs: integer("latency_ms").notNull().default(0),

    rawResponse: jsonb("raw_response"),
    // Set when the call failed. Failed calls are logged too: rule 3 says
    // *every* model call, and the failures are the interesting ones.
    error: text("error"),

    createdAt: createdAt(),
  },
  (t) => [
    index("llm_calls_tenant_id_idx").on(t.tenantId),
    index("llm_calls_tenant_created_at_idx").on(t.tenantId, t.createdAt),
    index("llm_calls_tenant_agent_idx").on(t.tenantId, t.agent),
  ],
);
