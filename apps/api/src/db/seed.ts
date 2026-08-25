import { fileURLToPath } from "node:url";

import { db, pool } from "./client";
import { projects, tenants, transcripts, users } from "./schema";

/**
 * Fixed uuids, so the seed is idempotent and so the manual cross-tenant probes
 * in the README can be copy-pasted. Two tenants is the point: one tenant cannot
 * demonstrate isolation.
 */
export const SEED = {
  northwind: {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Northwind Consulting",
    slug: "northwind",
    users: [
      { id: "11111111-0000-4000-8000-000000000001", name: "Ana Restrepo", email: "ana@northwind.test" },
      { id: "11111111-0000-4000-8000-000000000002", name: "Ben Okafor", email: "ben@northwind.test" },
    ],
    projects: [
      { id: "11111111-2222-4222-8222-000000000001", transcriptId: "11111111-3333-4333-8333-000000000001", name: "Pipeline revamp", clientName: "Acme Industrial" },
      { id: "11111111-2222-4222-8222-000000000002", transcriptId: "11111111-3333-4333-8333-000000000002", name: "Service cloud rollout", clientName: "Beacon Health" },
    ],
  },
  meridian: {
    id: "22222222-2222-4222-8222-222222222222",
    name: "Meridian Partners",
    slug: "meridian",
    users: [
      { id: "22222222-0000-4000-8000-000000000001", name: "Chika Adeyemi", email: "chika@meridian.test" },
      { id: "22222222-0000-4000-8000-000000000002", name: "Dan Sørensen", email: "dan@meridian.test" },
    ],
    projects: [
      { id: "22222222-2222-4222-8222-000000000001", transcriptId: "22222222-3333-4333-8333-000000000001", name: "Lead routing", clientName: "Corvus Freight" },
      { id: "22222222-2222-4222-8222-000000000002", transcriptId: "22222222-3333-4333-8333-000000000002", name: "Quote-to-cash", clientName: "Delta Foods" },
    ],
  },
} as const;

const TRANSCRIPT_TEXT = [
  "Consultant: Thanks for making the time. Walk me through how your team",
  "tracks a deal today.",
  "Client: Everything lives in a spreadsheet. We need the close date on the",
  "opportunity to be required, because half of them come in blank and the",
  "forecast is useless.",
  "Consultant: Understood. Anything else on the opportunity record?",
  "Client: We would like a field for the renewal risk, something like low,",
  "medium or high, so account managers can triage.",
].join("\n");

export async function seed(): Promise<void> {
  for (const tenant of [SEED.northwind, SEED.meridian]) {
    await db
      .insert(tenants)
      .values({ id: tenant.id, name: tenant.name, slug: tenant.slug })
      .onConflictDoNothing();

    await db
      .insert(users)
      .values(tenant.users.map((u) => ({ ...u, tenantId: tenant.id })))
      .onConflictDoNothing();

    await db
      .insert(projects)
      .values(
        tenant.projects.map((p) => ({
          id: p.id,
          tenantId: tenant.id,
          name: p.name,
          clientName: p.clientName,
        })),
      )
      .onConflictDoNothing();

    // One transcript per project, so the join repository has something to join.
    await db
      .insert(transcripts)
      .values(
        tenant.projects.map((p) => ({
          id: p.transcriptId,
          tenantId: tenant.id,
          projectId: p.id,
          title: `Discovery call - ${p.clientName}`,
          content: TRANSCRIPT_TEXT,
          meetingDate: new Date("2026-08-10T15:00:00Z"),
        })),
      )
      .onConflictDoNothing();
  }
}

const isCli = process.argv[1] === fileURLToPath(import.meta.url);

if (isCli) {
  await seed();
  console.log(
    `[seed] 2 tenants, 4 users, 4 projects, 4 transcripts\n` +
      `[seed] Northwind tenant ${SEED.northwind.id} user ${SEED.northwind.users[0].id}\n` +
      `[seed] Meridian  tenant ${SEED.meridian.id} user ${SEED.meridian.users[0].id}`,
  );
  await pool.end();
}
