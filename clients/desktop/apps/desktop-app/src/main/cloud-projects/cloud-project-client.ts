import { z } from 'zod';
import {
  CLOUD_PROJECT_ROUTES,
  CloudProjectEventCursorSchema,
  CloudProjectInstanceSelectionSchema,
  CloudProjectLifecycleEventsPageSchema,
  CloudProjectManifestSchema,
  CloudProjectMatchResponseSchema,
  type CloudProjectCreateRequest,
  type CloudProjectInstanceSelection,
  type CloudProjectLifecycleEventsPage,
  type CloudProjectManifest,
  type CloudProjectManifestUpdateRequest,
  type CloudProjectMatchRequest,
  type CloudProjectMatchResponse,
} from '@canopy/protocol/memory-sync';

/*
 * The cloud project identity routes (CAN-5189) as a typed client for the
 * desktop binding (CAN-5190). The transport is injected, so the binding runs
 * the same against the real Cloud client and a test double. Every response is
 * parsed with its protocol schema; a body that does not parse is an error.
 */

/** The Cloud credential a request goes out with, captured once per operation. */
export interface CloudProjectCredentials {
  readonly baseUrl: string;
  readonly apiKey: string;
}

/** The account a request goes out under (the consent fence's). */
export interface CloudProjectRequestContext {
  readonly credentials: CloudProjectCredentials;
  /**
   * Awaited before every network attempt, the transport's retries included;
   * a rejection sends nothing more.
   */
  readonly beforeRequest: () => Promise<void>;
}

export interface CloudProjectTransport {
  (
    path: string,
    init?: { method?: 'GET' | 'POST' | 'PUT'; body?: unknown },
    context?: CloudProjectRequestContext,
  ): Promise<unknown>;
}

const ClaimResponseSchema = z.looseObject({
  instanceId: z.uuid(),
  operationId: z.uuid(),
  fencingGeneration: z.int().min(0),
  state: z.enum(['CLAIMED', 'READY', 'DETACHED', 'ACCESS_REVOKED']),
  /** The feed position when the claim was answered; older servers omit it. */
  eventsCursor: CloudProjectEventCursorSchema.optional(),
});
export type CloudProjectClaim = z.output<typeof ClaimResponseSchema>;

const InstanceViewSchema = z.looseObject({
  instanceId: z.uuid(),
  state: z.enum(['CLAIMED', 'READY', 'DETACHED', 'ACCESS_REVOKED']),
});

export interface CloudProjectClaimRequest {
  idempotencyKey: string;
  deviceId: string;
  installationGeneration: number;
  localWorkspaceId: string;
}

export interface CloudProjectClient {
  match(
    request: CloudProjectMatchRequest,
    context?: CloudProjectRequestContext,
  ): Promise<CloudProjectMatchResponse>;
  create(
    request: CloudProjectCreateRequest,
    context?: CloudProjectRequestContext,
  ): Promise<CloudProjectManifest>;
  manifest(
    projectId: string,
    context?: CloudProjectRequestContext,
  ): Promise<CloudProjectManifest>;
  updateManifest(
    projectId: string,
    request: CloudProjectManifestUpdateRequest,
    context?: CloudProjectRequestContext,
  ): Promise<CloudProjectManifest>;
  claim(
    projectId: string,
    request: CloudProjectClaimRequest,
    context?: CloudProjectRequestContext,
  ): Promise<CloudProjectClaim>;
  complete(
    instanceId: string,
    claim: Pick<CloudProjectClaim, 'operationId' | 'fencingGeneration'>,
    context?: CloudProjectRequestContext,
  ): Promise<void>;
  selection(
    instanceId: string,
    context?: CloudProjectRequestContext,
  ): Promise<CloudProjectInstanceSelection>;
  updateSelection(
    instanceId: string,
    selection: CloudProjectInstanceSelection,
    context?: CloudProjectRequestContext,
  ): Promise<CloudProjectInstanceSelection>;
  /** Events after the opaque `after` cursor; null reads from the first event. */
  events(
    projectId: string,
    after: string | null,
    context?: CloudProjectRequestContext,
  ): Promise<CloudProjectLifecycleEventsPage>;
  /**
   * Release this device's setup of a project. With a fence, only the claim
   * it names while still pending; a newer claim of the instance stays.
   */
  detach(
    instanceId: string,
    fence?: Pick<CloudProjectClaim, 'operationId' | 'fencingGeneration'>,
    context?: CloudProjectRequestContext,
  ): Promise<void>;
}

export function createCloudProjectClient(
  transport: CloudProjectTransport,
): CloudProjectClient {
  return {
    async match(request, context): Promise<CloudProjectMatchResponse> {
      return CloudProjectMatchResponseSchema.parse(
        await transport(
          CLOUD_PROJECT_ROUTES.matchPersonal(),
          { method: 'POST', body: request },
          context,
        ),
      );
    },
    async create(request, context): Promise<CloudProjectManifest> {
      return CloudProjectManifestSchema.parse(
        await transport(
          CLOUD_PROJECT_ROUTES.createPersonal(),
          { method: 'POST', body: request },
          context,
        ),
      );
    },
    async manifest(projectId, context): Promise<CloudProjectManifest> {
      return CloudProjectManifestSchema.parse(
        await transport(
          CLOUD_PROJECT_ROUTES.manifest(projectId),
          undefined,
          context,
        ),
      );
    },
    async updateManifest(
      projectId,
      request,
      context,
    ): Promise<CloudProjectManifest> {
      return CloudProjectManifestSchema.parse(
        await transport(
          CLOUD_PROJECT_ROUTES.manifest(projectId),
          { method: 'PUT', body: request },
          context,
        ),
      );
    },
    async claim(projectId, request, context): Promise<CloudProjectClaim> {
      return ClaimResponseSchema.parse(
        await transport(
          CLOUD_PROJECT_ROUTES.claimInstance(projectId),
          { method: 'POST', body: request },
          context,
        ),
      );
    },
    async complete(instanceId, claim, context): Promise<void> {
      InstanceViewSchema.parse(
        await transport(
          CLOUD_PROJECT_ROUTES.completeInstance(instanceId),
          {
            method: 'POST',
            body: {
              operationId: claim.operationId,
              fencingGeneration: claim.fencingGeneration,
              outcome: 'ready',
            },
          },
          context,
        ),
      );
    },
    async selection(
      instanceId,
      context,
    ): Promise<CloudProjectInstanceSelection> {
      return CloudProjectInstanceSelectionSchema.parse(
        await transport(
          CLOUD_PROJECT_ROUTES.instanceRepositories(instanceId),
          undefined,
          context,
        ),
      );
    },
    async updateSelection(
      instanceId,
      selection,
      context,
    ): Promise<CloudProjectInstanceSelection> {
      return CloudProjectInstanceSelectionSchema.parse(
        await transport(
          CLOUD_PROJECT_ROUTES.instanceRepositories(instanceId),
          { method: 'PUT', body: selection },
          context,
        ),
      );
    },
    async events(
      projectId,
      after,
      context,
    ): Promise<CloudProjectLifecycleEventsPage> {
      const query = after === null ? '' : `?${new URLSearchParams({ after })}`;
      return CloudProjectLifecycleEventsPageSchema.parse(
        await transport(
          `${CLOUD_PROJECT_ROUTES.events(projectId)}${query}`,
          undefined,
          context,
        ),
      );
    },
    async detach(instanceId, fence, context): Promise<void> {
      const query =
        fence === undefined
          ? ''
          : `?${new URLSearchParams({
              operationId: fence.operationId,
              fencingGeneration: String(fence.fencingGeneration),
            })}`;
      InstanceViewSchema.parse(
        await transport(
          `${CLOUD_PROJECT_ROUTES.detachInstance(instanceId)}${query}`,
          { method: 'POST' },
          context,
        ),
      );
    },
  };
}
