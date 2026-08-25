import { z } from "zod";

/**
 * Shape of `GET /health`.
 *
 * `status` and `db` are enums rather than literal "ok" on purpose: the failure
 * case has to be representable. A schema that can only describe success pushes
 * the client into inventing its own error shape, and SPEC Phase 5 forbids UI
 * that claims success before the server confirms it.
 */
export const HealthResponseSchema = z.object({
  status: z.enum(["ok", "error"]),
  db: z.enum(["ok", "error"]),
});

export type HealthResponse = z.infer<typeof HealthResponseSchema>;
