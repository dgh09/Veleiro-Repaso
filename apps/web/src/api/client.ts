import {
  ApiErrorSchema,
  TenantMetricsResponseSchema,
  ApproveResponseSchema,
  AuditEntryResponseSchema,
  CreateTranscriptSchema,
  ExtractResponseSchema,
  ProjectResponseSchema,
  ProposalResponseSchema,
  ProposalStatusSchema,
  ProposeResponseSchema,
  RejectResponseSchema,
  RequirementResponseSchema,
  TranscriptResponseSchema,
  type ApproveResponse,
  type TenantMetricsResponse,
  type AuditEntryResponse,
  type ProjectResponse,
  type ProposalResponse,
  type ProposalStatus,
  type RequirementResponse,
  type TranscriptResponse,
} from "@veleiro/shared";
import { z } from "zod";

import type { Identity } from "../identity";

/**
 * The typed edge of the browser.
 *
 * Every response is parsed with the shared schema before it becomes state
 * (CLAUDE.md rule 5 applies here as much as it does to model output - the UI
 * has no more right to assume a shape than the agent does). A response that
 * does not match is an error the user is told about, not a render-time crash
 * three components deep.
 *
 * Failures are values. Nothing here throws, so no component can forget to
 * handle a network error.
 */

export type ApiResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number | null; message: string };

function failure(status: number | null, message: string): ApiResult<never> {
  return { ok: false, status, message };
}

async function request<T>(
  identity: Identity,
  path: string,
  schema: z.ZodType<T>,
  init: RequestInit = {},
): Promise<ApiResult<T>> {
  let response: Response;

  try {
    response = await fetch(path, {
      ...init,
      headers: {
        // The auth stub. Every request carries who is asking; the API decides
        // what that identity can see.
        "X-Tenant-Id": identity.tenantId,
        "X-User-Id": identity.userId,
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...init.headers,
      },
    });
  } catch (cause) {
    return failure(
      null,
      `Could not reach the API: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  const text = await response.text().catch(() => "");
  let body: unknown;
  try {
    body = text === "" ? null : JSON.parse(text);
  } catch {
    return failure(response.status, `The API replied with ${response.status} and a body that is not JSON.`);
  }

  if (!response.ok) {
    // Error bodies have a known shape; if this one does not, say so rather
    // than inventing a friendlier message than the truth.
    const parsed = ApiErrorSchema.safeParse(body);
    return failure(
      response.status,
      parsed.success ? parsed.data.error : `The API replied with ${response.status}.`,
    );
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return failure(
      response.status,
      `The API replied with ${response.status}, but the body did not match the expected shape: ${z.prettifyError(parsed.error)}`,
    );
  }

  return { ok: true, value: parsed.data };
}

export function listProjects(identity: Identity): Promise<ApiResult<ProjectResponse[]>> {
  return request(identity, "/api/projects", z.array(ProjectResponseSchema));
}

export function listTranscripts(
  identity: Identity,
  projectId: string,
): Promise<ApiResult<TranscriptResponse[]>> {
  return request(
    identity,
    `/api/projects/${projectId}/transcripts`,
    z.array(TranscriptResponseSchema),
  );
}

export function getTranscript(
  identity: Identity,
  transcriptId: string,
): Promise<ApiResult<TranscriptResponse>> {
  return request(identity, `/api/transcripts/${transcriptId}`, TranscriptResponseSchema);
}

export function createTranscript(
  identity: Identity,
  projectId: string,
  input: { title: string; content: string },
): Promise<ApiResult<TranscriptResponse>> {
  // Validated before it leaves the browser, with the same schema the API will
  // use, so the user is told about an empty paste immediately.
  const parsed = CreateTranscriptSchema.safeParse(input);
  if (!parsed.success) {
    return Promise.resolve(failure(null, z.prettifyError(parsed.error)));
  }

  return request(identity, `/api/projects/${projectId}/transcripts`, TranscriptResponseSchema, {
    method: "POST",
    body: JSON.stringify(parsed.data),
  });
}

export function listRequirements(
  identity: Identity,
  transcriptId: string,
): Promise<ApiResult<RequirementResponse[]>> {
  return request(
    identity,
    `/api/transcripts/${transcriptId}/requirements`,
    z.array(RequirementResponseSchema),
  );
}

export function extract(
  identity: Identity,
  transcriptId: string,
): Promise<ApiResult<{ requirements: RequirementResponse[] }>> {
  return request(identity, `/api/transcripts/${transcriptId}/extract`, ExtractResponseSchema, {
    method: "POST",
  });
}

export function propose(
  identity: Identity,
  requirementId: string,
): Promise<ApiResult<{ proposal: ProposalResponse }>> {
  return request(identity, `/api/requirements/${requirementId}/propose`, ProposeResponseSchema, {
    method: "POST",
  });
}

export function listProposals(
  identity: Identity,
  options: { status?: ProposalStatus; projectId?: string } = {},
): Promise<ApiResult<ProposalResponse[]>> {
  const params = new URLSearchParams();
  if (options.status !== undefined) {
    params.set("status", ProposalStatusSchema.parse(options.status));
  }
  if (options.projectId !== undefined) params.set("projectId", options.projectId);

  const query = params.size === 0 ? "" : `?${params.toString()}`;
  return request(identity, `/api/proposals${query}`, z.array(ProposalResponseSchema));
}

export function approve(
  identity: Identity,
  proposalId: string,
): Promise<ApiResult<ApproveResponse>> {
  return request(identity, `/api/proposals/${proposalId}/approve`, ApproveResponseSchema, {
    method: "POST",
  });
}

export function reject(
  identity: Identity,
  proposalId: string,
  rejectionReason: string,
): Promise<ApiResult<{ proposal: ProposalResponse }>> {
  return request(identity, `/api/proposals/${proposalId}/reject`, RejectResponseSchema, {
    method: "POST",
    body: JSON.stringify({ rejectionReason }),
  });
}

export function listProjectAudit(
  identity: Identity,
  projectId: string,
): Promise<ApiResult<AuditEntryResponse[]>> {
  return request(
    identity,
    `/api/projects/${projectId}/audit`,
    z.array(AuditEntryResponseSchema),
  );
}

export function getMetrics(
  identity: Identity,
): Promise<ApiResult<TenantMetricsResponse>> {
  return request(identity, "/api/metrics", TenantMetricsResponseSchema);
}
