import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import {
  AI_CREDITS_WORK_OWNER_HEADER,
  type WorkOwner,
} from '@canopy/protocol/llm-gateway';
import { serializeWorkspaceContext } from '@canopy/protocol/workspace-context';
import type {
  AutoModelRoutingRequestV1,
  AutoModelRoutingResponseV1,
} from '@canopy/protocol/model-routing';
import {
  CanopyCloudClientError,
  requestCanopyCloudJson,
  resolveCanopyCloudCredentialContext,
  type CanopyCloudCredentialContext,
} from '../canopy-cloud/client';
import { getFeatureFlagService } from '../feature-flags/service';
import { AutoModelRoutingInProgressError } from './in-progress-error';

const MODEL_ROUTING_CAPABILITY = 'model-routing-v1';

export interface DesktopModelRoutingResult {
  response: AutoModelRoutingResponseV1;
  durableLoss: boolean;
}

export interface DesktopModelRoutingClientDependencies {
  isEnabled(): boolean;
  subscribeEnabled?(listener: (enabled: boolean) => void): () => void;
  credentials(): Promise<CanopyCloudCredentialContext>;
  post(
    request: AutoModelRoutingRequestV1,
    credentials: CanopyCloudCredentialContext,
    signal?: AbortSignal,
    workOwner?: WorkOwner,
  ): Promise<AutoModelRoutingResponseV1>;
}

export interface ResolveDesktopAutoModelOptions {
  signal?: AbortSignal;
  /**
   * Owner of the chat session being routed (CAN-3462), sent as
   * `x-canopy-work-owner` so the server verifies it like the proxy does.
   * Omitted when the session's owner authority was unreadable.
   */
  workOwner?: WorkOwner;
}

/** POST the resolve request, carrying the session's work owner when known. */
export function postDesktopModelRoutingRequest(
  request: AutoModelRoutingRequestV1,
  credentials: CanopyCloudCredentialContext,
  signal?: AbortSignal,
  workOwner?: WorkOwner,
): Promise<AutoModelRoutingResponseV1> {
  return requestCanopyCloudJson<AutoModelRoutingResponseV1>(
    '/api/v1/model-routing/resolve',
    {
      method: 'POST',
      body: JSON.stringify(request),
      credentialContext: credentials,
      timeoutMs: 3_500,
      ...(workOwner
        ? {
            headers: {
              [AI_CREDITS_WORK_OWNER_HEADER]:
                serializeWorkspaceContext(workOwner),
            },
          }
        : {}),
      ...(signal ? { signal } : {}),
    },
  );
}

const defaultDependencies: DesktopModelRoutingClientDependencies = {
  isEnabled: () =>
    getFeatureFlagService().isEnabled(
      CLIENT_FEATURE_FLAGS.canopySharedAutoModelRouting.key,
    ),
  subscribeEnabled: (listener) =>
    getFeatureFlagService().onSnapshotChanged((snapshot) => {
      listener(
        snapshot.values[
          CLIENT_FEATURE_FLAGS.canopySharedAutoModelRouting.key
        ] === true,
      );
    }),
  credentials: resolveCanopyCloudCredentialContext,
  post: postDesktopModelRoutingRequest,
};

function fallback(
  request: AutoModelRoutingRequestV1,
  reason: AutoModelRoutingResponseV1['fallbackReason'],
): AutoModelRoutingResponseV1 {
  return {
    schemaVersion: 1,
    requestId: request.requestId,
    outcome: 'fallback',
    modelId: request.fallbackModelId,
    fallbackReason: reason,
  };
}

/**
 * Resolve an Auto turn's model. Any failure, including a refused work owner
 * (the owner is an organization the user has left), falls back locally; the
 * AI Credits proxy then refuses the turn itself with a marked error the chat
 * banner explains.
 */
export async function resolveDesktopAutoModel(
  request: AutoModelRoutingRequestV1,
  options: ResolveDesktopAutoModelOptions = {},
  dependencies: DesktopModelRoutingClientDependencies = defaultDependencies,
): Promise<DesktopModelRoutingResult> {
  const { signal, workOwner } = options;
  let rolloutDisabled = !dependencies.isEnabled();
  const disableForRollout = (): void => {
    rolloutDisabled = true;
  };
  const unsubscribe = dependencies.subscribeEnabled?.((enabled) => {
    if (!enabled) disableForRollout();
  });
  try {
    let credentials: CanopyCloudCredentialContext;
    try {
      credentials = await dependencies.credentials();
    } catch (error) {
      if (signal?.aborted) throw error;
      if (rolloutDisabled || !dependencies.isEnabled()) {
        return {
          response: fallback(request, 'policy_blocked'),
          durableLoss: true,
        };
      }
      return { response: fallback(request, 'unavailable'), durableLoss: true };
    }
    if (
      !credentials.capabilities?.includes(MODEL_ROUTING_CAPABILITY) &&
      !rolloutDisabled &&
      dependencies.isEnabled()
    ) {
      return {
        response: fallback(request, 'policy_blocked'),
        durableLoss: true,
      };
    }
    const response = await dependencies.post(
      request,
      credentials,
      signal,
      workOwner,
    );
    signal?.throwIfAborted();
    return {
      response,
      durableLoss:
        rolloutDisabled ||
        !dependencies.isEnabled() ||
        response.fallbackReason === 'policy_blocked',
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    if (
      error instanceof CanopyCloudClientError &&
      error.serverCode === 'model_routing_in_progress'
    ) {
      throw new AutoModelRoutingInProgressError(error.retryAfterMs, error);
    }
    if (rolloutDisabled || !dependencies.isEnabled()) {
      return {
        response: fallback(request, 'policy_blocked'),
        durableLoss: true,
      };
    }
    return { response: fallback(request, 'unavailable'), durableLoss: false };
  } finally {
    unsubscribe?.();
  }
}
