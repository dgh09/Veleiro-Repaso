import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ProposalPayload } from "@veleiro/shared";

import { fakeLlmClient, says } from "../../test/fake-llm";
import { TEST_DATABASE_NAME } from "../../test/database-url";
import { runExtractor, type ExtractOptions } from "../agents/extractor/extractor";
import { runProposer, type ProposeOptions } from "../agents/proposer/proposer";
import { createApp } from "../app";
import type { ApplyResult, CrmConnector } from "../connectors/types";
import { db, pool } from "../db/client";
import { listAuditLog } from "../db/repositories/audit-log";
import { SEED, seed } from "../db/seed";
import { approveProposal, rejectProposal, type ApproveOptions } from "./service";

/**
 * SPEC Phase 4's acceptance criteria, driven end to end over HTTP against the
 * real database. The two models are faked; the connector is a counting spy, so
 * "applies exactly once" is asserted on the thing that would actually touch a
 * CRM rather than on a status column.
 */

const NORTHWIND = SEED.northwind;
const HEADERS = {
  "X-Tenant-Id": NORTHWIND.id,
  "X-User-Id": NORTHWIND.users[0].id,
};

const TRANSCRIPT_ID = NORTHWIND.projects[0].transcriptId;
const REAL_QUOTE = "We need the close date on the opportunity to be required";
const FABRICATED_QUOTE = "We need a field for the client's astrological sign";

const VALID_REQUIREMENT = {
  title: "Require close date",
  description: "Close date must be mandatory",
  crmObject: "Opportunity",
  fieldName: "CloseDate",
  fieldType: "Date",
  rationale: "Forecast depends on it",
  sourceQuote: REAL_QUOTE,
  confidence: 0.9,
};

const FIELD_PAYLOAD: ProposalPayload = {
  changeType: "create_field",
  objectName: "Opportunity",
  fieldName: "Renewal_Risk__c",
  fieldType: "Picklist",
  label: "Renewal Risk",
  required: false,
  picklistValues: ["Low", "Medium", "High"],
};

interface CountingConnector extends CrmConnector {
  readonly calls: number;
}

function countingConnector(result: ApplyResult): CountingConnector {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async apply(): Promise<ApplyResult> {
      calls += 1;
      return result;
    },
  };
}

const SUCCESS: ApplyResult = { ok: true, externalId: "stub-1", details: "created" };

interface AppOptions {
  extracted?: unknown[];
  payload?: ProposalPayload;
  connector?: CrmConnector;
}

function appWith(options: AppOptions = {}) {
  const extracted = options.extracted ?? [VALID_REQUIREMENT];
  const payload = options.payload ?? FIELD_PAYLOAD;

  return createApp({
    transcripts: {
      runExtractor: (o: ExtractOptions) =>
        runExtractor({
          ...o,
          client: fakeLlmClient([says(JSON.stringify({ requirements: extracted }))]),
        }),
    },
    requirements: {
      runProposer: (o: ProposeOptions) =>
        runProposer({
          ...o,
          client: fakeLlmClient([says(JSON.stringify({ payload }))]),
        }),
    },
    proposals: {
      approveProposal: (o: ApproveOptions) =>
        approveProposal({
          ...o,
          ...(options.connector ? { connector: options.connector } : {}),
        }),
      rejectProposal,
    },
  });
}

type App = ReturnType<typeof appWith>;

async function extractAndPropose(app: App): Promise<string> {
  await app.request(`/api/transcripts/${TRANSCRIPT_ID}/extract`, {
    method: "POST",
    headers: HEADERS,
  });

  const listed = await app.request(`/api/transcripts/${TRANSCRIPT_ID}/requirements`, {
    headers: HEADERS,
  });
  const requirements = (await listed.json()) as { id: string }[];
  const requirementId = requirements[0]?.id;
  if (requirementId === undefined) throw new Error("extraction produced no requirement");

  const proposed = await app.request(`/api/requirements/${requirementId}/propose`, {
    method: "POST",
    headers: HEADERS,
  });

  const body = (await proposed.json()) as { proposal?: { id: string } };
  const proposalId = body.proposal?.id;
  if (proposalId === undefined) {
    throw new Error(`propose failed: ${proposed.status} ${JSON.stringify(body)}`);
  }

  return proposalId;
}

beforeAll(async () => {
  const target = new URL(process.env.DATABASE_URL ?? "").pathname.replace("/", "");
  if (target !== TEST_DATABASE_NAME) {
    throw new Error(
      `Refusing to run destructive tests against "${target}". Expected "${TEST_DATABASE_NAME}".`,
    );
  }
  await seed();
});

beforeEach(async () => {
  await db.execute(
    sql`truncate table ${sql.identifier("requirements")}, ${sql.identifier("proposals")}, ${sql.identifier("audit_log")} cascade`,
  );
});

afterAll(async () => {
  await pool.end();
});

describe("the approval loop", () => {
  it("runs the whole path: extract, propose, approve, apply", async () => {
    const connector = countingConnector(SUCCESS);
    const app = appWith({ connector });

    const proposalId = await extractAndPropose(app);

    const res = await app.request(`/api/proposals/${proposalId}/approve`, {
      method: "POST",
      headers: HEADERS,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { applied: boolean; proposal: { status: string } };
    expect(body.applied).toBe(true);
    expect(body.proposal.status).toBe("applied");
    expect(connector.calls).toBe(1);

    // An audit row for each step, agent actions and human actions distinct.
    const actions = (await listAuditLog({
      tenantId: NORTHWIND.id,
      userId: NORTHWIND.users[0].id,
    })).map((row) => `${row.actorType}:${row.action}`);

    expect(actions).toContain("agent:extract_requirements");
    expect(actions).toContain("agent:propose_change");
    expect(actions).toContain("user:apply_proposal");
  });

  it("applies exactly once when approved twice", async () => {
    const connector = countingConnector(SUCCESS);
    const app = appWith({ connector });
    const proposalId = await extractAndPropose(app);

    const first = await app.request(`/api/proposals/${proposalId}/approve`, {
      method: "POST",
      headers: HEADERS,
    });
    const second = await app.request(`/api/proposals/${proposalId}/approve`, {
      method: "POST",
      headers: HEADERS,
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    // The assertion that matters: the CRM was touched once, not twice.
    expect(connector.calls).toBe(1);

    const body = (await second.json()) as {
      alreadySettled: boolean;
      proposal: { status: string };
    };
    expect(body.alreadySettled).toBe(true);
    expect(body.proposal.status).toBe("applied");
  });

  it("refuses a rejection with no reason", async () => {
    const app = appWith();
    const proposalId = await extractAndPropose(app);

    const missing = await app.request(`/api/proposals/${proposalId}/reject`, {
      method: "POST",
      headers: { ...HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    const blank = await app.request(`/api/proposals/${proposalId}/reject`, {
      method: "POST",
      headers: { ...HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ rejectionReason: "   " }),
    });

    expect(missing.status).toBe(400);
    // Whitespace is not a reason either.
    expect(blank.status).toBe(400);
  });

  it("records the human's stated reason on rejection", async () => {
    const app = appWith();
    const proposalId = await extractAndPropose(app);

    const res = await app.request(`/api/proposals/${proposalId}/reject`, {
      method: "POST",
      headers: { ...HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ rejectionReason: "Client already has this field" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      proposal: { status: string; rejectionReason: string; reviewedBy: string };
    };
    expect(body.proposal.status).toBe("rejected");
    expect(body.proposal.rejectionReason).toBe("Client already has this field");
    expect(body.proposal.reviewedBy).toBe(NORTHWIND.users[0].id);

    const audit = await listAuditLog({
      tenantId: NORTHWIND.id,
      userId: NORTHWIND.users[0].id,
    });
    const rejection = audit.find((row) => row.action === "reject_proposal");
    expect(rejection?.actorType).toBe("user");
    expect(JSON.stringify(rejection?.after)).toContain("Client already has this field");
  });

  it("never proposes a requirement that needs review", async () => {
    // The extractor flags this one because its quote is fabricated.
    const app = appWith({
      extracted: [{ ...VALID_REQUIREMENT, sourceQuote: FABRICATED_QUOTE }],
    });

    await app.request(`/api/transcripts/${TRANSCRIPT_ID}/extract`, {
      method: "POST",
      headers: HEADERS,
    });

    const listed = await app.request(`/api/transcripts/${TRANSCRIPT_ID}/requirements`, {
      headers: HEADERS,
    });
    const [requirement] = (await listed.json()) as { id: string; status: string }[];
    expect(requirement?.status).toBe("needs_review");

    const res = await app.request(`/api/requirements/${requirement?.id}/propose`, {
      method: "POST",
      headers: HEADERS,
    });

    expect(res.status).toBe(409);
  });

  it("keeps the proposal when the connector fails", async () => {
    const connector = countingConnector({ ok: false, error: "CRM said no" });
    const app = appWith({ connector });
    const proposalId = await extractAndPropose(app);

    const res = await app.request(`/api/proposals/${proposalId}/approve`, {
      method: "POST",
      headers: HEADERS,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { applied: boolean; error: string };
    expect(body.applied).toBe(false);
    expect(body.error).toBe("CRM said no");

    // Not lost: still listable, marked failed, with the reason in the audit log.
    const listed = await app.request("/api/proposals?status=failed", { headers: HEADERS });
    const failed = (await listed.json()) as { id: string }[];
    expect(failed.map((p) => p.id)).toContain(proposalId);

    const audit = await listAuditLog({
      tenantId: NORTHWIND.id,
      userId: NORTHWIND.users[0].id,
    });
    expect(audit.some((row) => row.action === "apply_proposal_failed")).toBe(true);
  });

  it("does not apply a proposal that was already rejected", async () => {
    const connector = countingConnector(SUCCESS);
    const app = appWith({ connector });
    const proposalId = await extractAndPropose(app);

    await app.request(`/api/proposals/${proposalId}/reject`, {
      method: "POST",
      headers: { ...HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ rejectionReason: "Not needed" }),
    });

    const res = await app.request(`/api/proposals/${proposalId}/approve`, {
      method: "POST",
      headers: HEADERS,
    });

    expect(res.status).toBe(200);
    expect((await res.json()) as { alreadySettled: boolean }).toMatchObject({
      alreadySettled: true,
    });
    // The whole point: a rejected change never reaches the CRM.
    expect(connector.calls).toBe(0);
  });

  it("refuses to reject a proposal that was already applied", async () => {
    const app = appWith({ connector: countingConnector(SUCCESS) });
    const proposalId = await extractAndPropose(app);

    await app.request(`/api/proposals/${proposalId}/approve`, {
      method: "POST",
      headers: HEADERS,
    });

    const res = await app.request(`/api/proposals/${proposalId}/reject`, {
      method: "POST",
      headers: { ...HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ rejectionReason: "Changed my mind" }),
    });

    expect(res.status).toBe(409);
  });

  it("assigns risk by rule, from the payload rather than from the model", async () => {
    const app = appWith({
      payload: {
        changeType: "update_field",
        objectName: "Opportunity",
        fieldName: "Amount",
        newFieldType: "Text",
        newRequired: null,
        newLabel: null,
        newPicklistValues: null,
      },
    });

    const proposalId = await extractAndPropose(app);

    const listed = await app.request("/api/proposals?status=pending", { headers: HEADERS });
    const pending = (await listed.json()) as { id: string; riskLevel: string }[];

    expect(pending.find((p) => p.id === proposalId)?.riskLevel).toBe("high");
  });

  it("returns 404 for a proposal that does not exist", async () => {
    const app = appWith();

    const res = await app.request(
      "/api/proposals/00000000-0000-4000-8000-000000000000/approve",
      { method: "POST", headers: HEADERS },
    );

    expect(res.status).toBe(404);
  });

  it("rejects an unknown status filter rather than returning everything", async () => {
    const app = appWith();

    const res = await app.request("/api/proposals?status=banana", { headers: HEADERS });

    expect(res.status).toBe(400);
  });
});
