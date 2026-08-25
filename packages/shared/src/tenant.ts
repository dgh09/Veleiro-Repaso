import { z } from "zod";

/**
 * Every repository function takes one of these as its first argument, and the
 * tenant predicate is derived from it. Built by the middleware from the
 * X-Tenant-Id / X-User-Id headers - a stub for real authentication, but the
 * isolation downstream of it is real.
 */
export const TenantContextSchema = z.object({
  tenantId: z.uuid(),
  userId: z.uuid(),
});

export type TenantContext = z.infer<typeof TenantContextSchema>;
