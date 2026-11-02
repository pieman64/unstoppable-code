import {
  CanopyOperationError,
  type CanopyHandlerContext,
} from '@canopy/core-runtime';
import type {
  CanopyInstructionHandlerMap,
  CanopyQueryHandlerMap,
  CanopyRequestMetadata,
} from '@canopy/protocol/canopy-core';
import type {
  CostChatRequest,
  CostChatView,
  CostPipelineRunRequest,
  CostRefreshReceipt,
  CostRefreshRequest,
  CostScopeRequest,
  CostScopeView,
  PipelineRunCostView,
} from '@canopy/protocol/cost-view';
import { CostServiceError } from '../cost-index/errors';
import type { CostService } from '../cost-index/service';

type CostServiceResolver = () => CostService | Promise<CostService>;

export type CoreCostQueryHandlers = Pick<
  CanopyQueryHandlerMap<CanopyHandlerContext>,
  'core.cost.scope.get' | 'core.cost.chat.get' | 'core.cost.pipelineRun.get'
>;

export type CoreCostInstructionHandlers = Pick<
  CanopyInstructionHandlerMap<CanopyHandlerContext>,
  'core.cost.index.refresh'
>;

export interface CoreCostAdapter {
  queries: CoreCostQueryHandlers;
  instructions: CoreCostInstructionHandlers;
}

type CostServiceFailureReason =
  | 'no_scope'
  | 'runtime_unavailable'
  | 'NOT_FOUND'
  | 'SCOPE_SEALED'
  | 'UNKNOWN';

interface CostOperationErrorMapping {
  readonly kind:
    | 'not_found'
    | 'unavailable'
    | 'failed_precondition'
    | 'internal';
  readonly code:
    | 'core.cost.noScope'
    | 'core.cost.runtimeUnavailable'
    | 'core.cost.notFound'
    | 'core.cost.scopeSealed'
    | 'core.cost.unknown';
  readonly message: string;
  readonly retry: { readonly kind: 'never' };
}

const COST_OPERATION_ERRORS: Record<
  CostServiceFailureReason,
  CostOperationErrorMapping
> = {
  no_scope: {
    kind: 'not_found',
    code: 'core.cost.noScope',
    message: 'This work scope is not available.',
    retry: { kind: 'never' },
  },
  runtime_unavailable: {
    kind: 'unavailable',
    code: 'core.cost.runtimeUnavailable',
    message: 'The cost service is temporarily unavailable.',
    retry: { kind: 'never' },
  },
  NOT_FOUND: {
    kind: 'not_found',
    code: 'core.cost.notFound',
    message: 'No cost data was found for the requested item.',
    retry: { kind: 'never' },
  },
  SCOPE_SEALED: {
    kind: 'failed_precondition',
    code: 'core.cost.scopeSealed',
    message: 'This work scope is sealed and cannot be refreshed.',
    retry: { kind: 'never' },
  },
  UNKNOWN: {
    kind: 'internal',
    code: 'core.cost.unknown',
    message: 'The cost request could not be completed.',
    retry: { kind: 'never' },
  },
};

/** Translate storage/service failures into portable, content-free operation errors. */
export function toCostOperationError(
  error: unknown,
  fallbackMessage: string,
  runtimeRetryKind: 'same_request' | 'same_idempotency_key' = 'same_request',
): CanopyOperationError {
  const reason: CostServiceFailureReason =
    error instanceof CostServiceError ? error.reason : 'UNKNOWN';
  const mapping = COST_OPERATION_ERRORS[reason];
  const message =
    reason === 'UNKNOWN' && fallbackMessage.trim().length > 0
      ? fallbackMessage.trim().slice(0, 4_096)
      : mapping.message;
  const retry =
    reason === 'runtime_unavailable'
      ? { kind: runtimeRetryKind }
      : mapping.retry;
  return new CanopyOperationError({
    kind: mapping.kind,
    code: mapping.code,
    message,
    details: { reason },
    retry,
  });
}

async function readCost<Value>(
  read: () => Promise<Value>,
  fallbackMessage: string,
  runtimeRetryKind: 'same_request' | 'same_idempotency_key' = 'same_request',
): Promise<Value> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof CanopyOperationError) throw error;
    throw toCostOperationError(error, fallbackMessage, runtimeRetryKind);
  }
}

export function createCoreCostAdapter(
  service: CostService | CostServiceResolver,
): CoreCostAdapter {
  const getService = async (): Promise<CostService> =>
    typeof service === 'function' ? service() : service;
  return {
    queries: {
      'core.cost.scope.get': (
        params: CostScopeRequest,
      ): Promise<CostScopeView> =>
        readCost(
          async () => (await getService()).getScope(params),
          'The cost scope could not be read.',
        ),
      'core.cost.chat.get': (params: CostChatRequest): Promise<CostChatView> =>
        readCost(
          async () => (await getService()).getChat(params),
          'The chat cost could not be read.',
        ),
      'core.cost.pipelineRun.get': (
        params: CostPipelineRunRequest,
      ): Promise<PipelineRunCostView> =>
        readCost(
          async () => (await getService()).getPipelineRun(params),
          'The workflow run cost could not be read.',
        ),
    },
    instructions: {
      'core.cost.index.refresh': (
        params: CostRefreshRequest & {
          _meta: CanopyRequestMetadata & { idempotencyKey: string };
        },
      ): Promise<CostRefreshReceipt> =>
        readCost(
          async () =>
            (await getService()).refresh({
              scope: params.scope,
              trigger: params.trigger,
            }),
          'The cost index could not be refreshed.',
          'same_idempotency_key',
        ),
    },
  };
}
