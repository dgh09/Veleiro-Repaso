/**
 * The authentication stub.
 *
 * CLAUDE.md puts login out of scope: tenant and user come from headers. So the
 * UI needs some way to say who it is, and this is it - a picker over the seeded
 * fixtures, persisted per browser.
 *
 * These uuids are the ones in apps/api/src/db/seed.ts. They are duplicated here
 * rather than fetched because there is no endpoint that lists tenants, and
 * adding one would mean building the user-management surface CLAUDE.md rules
 * out. If the seed ids change, these change with them.
 *
 * Being able to switch identity in one click is also the fastest way to see
 * tenant isolation actually working: pick Meridian and Northwind's projects
 * vanish, because the repository layer filtered them out.
 */
export interface Identity {
  label: string;
  tenantName: string;
  tenantId: string;
  userId: string;
  userName: string;
}

export const IDENTITIES: Identity[] = [
  {
    label: "Ana Restrepo · Northwind",
    tenantName: "Northwind Consulting",
    tenantId: "11111111-1111-4111-8111-111111111111",
    userId: "11111111-0000-4000-8000-000000000001",
    userName: "Ana Restrepo",
  },
  {
    label: "Ben Okafor · Northwind",
    tenantName: "Northwind Consulting",
    tenantId: "11111111-1111-4111-8111-111111111111",
    userId: "11111111-0000-4000-8000-000000000002",
    userName: "Ben Okafor",
  },
  {
    label: "Chika Adeyemi · Meridian",
    tenantName: "Meridian Partners",
    tenantId: "22222222-2222-4222-8222-222222222222",
    userId: "22222222-0000-4000-8000-000000000001",
    userName: "Chika Adeyemi",
  },
];

const STORAGE_KEY = "veleiro.identity";

export function defaultIdentity(): Identity {
  const first = IDENTITIES[0];
  /* c8 ignore next */
  if (first === undefined) throw new Error("IDENTITIES must not be empty");
  return first;
}

export function loadIdentity(): Identity {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    const found = IDENTITIES.find((identity) => identity.userId === stored);
    return found ?? defaultIdentity();
  } catch {
    // Private browsing, or storage disabled. The default is a fine answer.
    return defaultIdentity();
  }
}

export function saveIdentity(identity: Identity): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, identity.userId);
  } catch {
    // Not being able to remember the choice is not worth failing over.
  }
}
