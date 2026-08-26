import { Hono } from "hono";

import { runExtractor } from "../agents/extractor/extractor";
import { describeAgentFailure } from "../agents/runtime/errors";
import {
  countRequirementsByTranscript,
  listRequirementsByTranscript,
} from "../db/repositories/requirements";
import { getTranscript } from "../db/repositories/transcripts";
import type { TenantVariables } from "../middleware/tenant";

/**
 * Like every route file here: repositories only, never the Drizzle client.
 * `no-direct-db.test.ts` enforces it.
 */
export interface TranscriptsRouteDeps {
  runExtractor: typeof runExtractor;
}

export function createTranscriptsRoute(
  deps: TranscriptsRouteDeps = { runExtractor },
) {
  const route = new Hono<{ Variables: TenantVariables }>();

  route.post("/transcripts/:id/extract", async (c) => {
    const ctx = c.get("tenant");
    const id = c.req.param("id");

    const transcript = await getTranscript(ctx, id);
    // Another tenant's transcript is indistinguishable from a missing one.
    if (!transcript) return c.json({ error: "Transcript not found" }, 404);

    /**
     * Extracting twice would silently duplicate every requirement, and there is
     * no key that would make the second run a no-op - the model does not return
     * the same text twice. SPEC does not say what should happen, so this
     * refuses rather than guesses. Re-extraction after a prompt change is a real
     * need and wants its own explicit path, not an accident of calling POST
     * again.
     */
    if ((await countRequirementsByTranscript(ctx, id)) > 0) {
      return c.json(
        {
          error:
            "This transcript already has requirements. Re-extracting would duplicate " +
            "them, and re-extraction is not supported yet.",
        },
        409,
      );
    }

    const result = await deps.runExtractor({ ctx, transcript });

    if (!result.ok) {
      // The model is an upstream dependency; when it fails, this is a gateway
      // problem and not the caller's fault. The typed failure is described
      // rather than returned raw - it can carry the model's own output.
      return c.json({ error: describeAgentFailure(result.error) }, 502);
    }

    return c.json({ requirements: result.value.requirements }, 201);
  });

  route.get("/transcripts/:id/requirements", async (c) => {
    const ctx = c.get("tenant");
    const id = c.req.param("id");

    if (!(await getTranscript(ctx, id))) {
      return c.json({ error: "Transcript not found" }, 404);
    }

    return c.json(await listRequirementsByTranscript(ctx, id));
  });

  return route;
}
