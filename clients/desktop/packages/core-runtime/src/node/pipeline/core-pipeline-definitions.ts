import { createHash } from 'node:crypto';
import type {
  CanopyInstructionHandler,
  CanopyQueryHandler,
  PipelineDefinitionDeleteResult,
  PipelineDefinitionUpsertResult,
  PipelineDefinitionGetResult,
  PipelineDefinitionListResult,
  PipelineDefinitionValidateResult,
} from '@canopy/protocol/canopy-core';
import { CanopyOperationError } from '../../runtime/errors';
import type { CanopyHandlerContext } from '../../runtime/types';
import {
  pipelineDefinitionError,
  PipelineDefinitionResumableWrite,
  type PipelineDefinitionService,
} from './definitions';

export interface CorePipelineDefinitionHandlers {
  queries: {
    'core.pipeline.definition.list': CanopyQueryHandler<
      'core.pipeline.definition.list',
      CanopyHandlerContext
    >;
    'core.pipeline.definition.get': CanopyQueryHandler<
      'core.pipeline.definition.get',
      CanopyHandlerContext
    >;
    'core.pipeline.definition.validate': CanopyQueryHandler<
      'core.pipeline.definition.validate',
      CanopyHandlerContext
    >;
  };
  instructions: {
    'core.pipeline.definition.upsert': CanopyInstructionHandler<
      'core.pipeline.definition.upsert',
      CanopyHandlerContext
    >;
    'core.pipeline.definition.delete': CanopyInstructionHandler<
      'core.pipeline.definition.delete',
      CanopyHandlerContext
    >;
  };
}

export interface CorePipelineDefinitionHost {
  /** The service for this host, created on the first call. */
  load(): Promise<PipelineDefinitionService>;
  /** The authority this host serves; other `scope.authorityId`s are refused. */
  readonly authorityId: string;
}

function assertServingAuthority(
  host: CorePipelineDefinitionHost,
  authorityId: string | undefined,
): void {
  if (authorityId !== undefined && authorityId !== host.authorityId)
    throw pipelineDefinitionError(
      'core.pipeline.targetUnavailable',
      'This host does not serve the selected authority.',
    );
}

/** Committed writes a caller can replay with the same idempotency key. */
const REPLAY_LIMIT = 256;

interface Replay<T> {
  readonly fingerprint: string;
  /** The committed result, or the step a retry finishes. */
  readonly result?: Promise<T>;
  readonly resume?: () => Promise<T>;
}

type ReplayCache<T> = (
  context: CanopyHandlerContext,
  params: object,
  run: () => Promise<T>,
) => Promise<T>;

/** The step a retry finishes when an upsert committed before failing. */
function upsertResumeOf(
  error: unknown,
): (() => Promise<PipelineDefinitionUpsertResult>) | undefined {
  const cause =
    error instanceof CanopyOperationError ? error.runtimeCause : undefined;
  if (!(cause instanceof PipelineDefinitionResumableWrite)) return undefined;
  return async (): Promise<PipelineDefinitionUpsertResult> => ({
    definition: await cause.resume(),
  });
}

/**
 * Keyed replay for one operation in this process: the same key and payload
 * return the first committed result, a different payload is a conflict, a
 * failed write frees its key for a retry, and a write that committed before
 * failing keeps its key so a retry finishes it. A key whose receipt has aged
 * out is refused rather than written again.
 */
function createReplayCache<T>(
  resumeOf: (
    error: unknown,
  ) => (() => Promise<T>) | undefined = (): undefined => undefined,
): ReplayCache<T> {
  const replays = new Map<string, Replay<T>>();
  const expired = new Set<string>();
  return async (context, params, run): Promise<T> => {
    const key = createHash('sha256')
      .update(
        [
          context.caller.principalId,
          context.caller.clientInstanceId,
          context.metadata.idempotencyKey ?? '',
        ].join('\0'),
      )
      .digest('hex');
    if (expired.has(key))
      throw new CanopyOperationError({
        kind: 'failed_precondition',
        message:
          'This idempotency key is too old to replay; read the workflow and send a new request.',
        retry: { kind: 'never' },
      });
    const payload = Object.entries(params).filter(([name]) => name !== '_meta');
    const fingerprint = createHash('sha256')
      .update(JSON.stringify(payload))
      .digest('hex');
    const previous = replays.get(key);
    if (previous && previous.fingerprint !== fingerprint)
      throw new CanopyOperationError({
        kind: 'conflict',
        message:
          'This idempotency key was already used for a different request.',
        retry: { kind: 'never' },
      });
    if (previous?.result) return previous.result;
    const result = (previous?.resume ?? run)();
    replays.delete(key);
    replays.set(key, { fingerprint, result });
    if (replays.size > REPLAY_LIMIT) {
      const oldest = replays.keys().next().value;
      if (oldest !== undefined) {
        replays.delete(oldest);
        expired.add(oldest);
      }
    }
    try {
      return await result;
    } catch (error) {
      if (replays.get(key)?.result === result) {
        const resume = resumeOf(error);
        if (resume) replays.set(key, { fingerprint, resume });
        else replays.delete(key);
      }
      throw writeError(error);
    }
  };
}

// A write is retried with its idempotency key, never as a fresh request.
function writeError(error: unknown): unknown {
  if (
    error instanceof CanopyOperationError &&
    error.payload.retry?.kind === 'same_request'
  )
    return new CanopyOperationError(
      {
        ...error.payload,
        retry: { kind: 'same_idempotency_key' },
      },
      error.runtimeCause,
    );
  return error;
}

/** `core.pipeline.definition.*` handlers. */
export function createCorePipelineDefinitionHandlers(
  host: CorePipelineDefinitionHost,
): CorePipelineDefinitionHandlers {
  const replayUpsert =
    createReplayCache<PipelineDefinitionUpsertResult>(upsertResumeOf);
  const replayDelete = createReplayCache<PipelineDefinitionDeleteResult>();
  return {
    queries: {
      'core.pipeline.definition.list': async (
        params,
        { signal },
      ): Promise<PipelineDefinitionListResult> => {
        assertServingAuthority(host, params.scope?.authorityId);
        return (await host.load()).list(params, signal);
      },
      'core.pipeline.definition.get': async (
        params,
        { signal },
      ): Promise<PipelineDefinitionGetResult> => {
        assertServingAuthority(host, params.scope?.authorityId);
        return {
          definition: await (
            await host.load()
          ).get(params.definitionId, params.scope ?? {}, signal),
        };
      },
      'core.pipeline.definition.validate': async (
        params,
      ): Promise<PipelineDefinitionValidateResult> => {
        assertServingAuthority(host, params.scope.authorityId);
        return (await host.load()).validate(params.document, params.targetId);
      },
    },
    instructions: {
      'core.pipeline.definition.upsert': (
        params,
        context,
      ): Promise<PipelineDefinitionUpsertResult> =>
        replayUpsert(context, params, async () => {
          assertServingAuthority(host, params.scope.authorityId);
          return {
            definition: await (
              await host.load()
            ).upsert(params, context.signal),
          };
        }),
      'core.pipeline.definition.delete': (
        params,
        context,
      ): Promise<PipelineDefinitionDeleteResult> =>
        replayDelete(context, params, async () => {
          return (await host.load()).delete(params, context.signal);
        }),
    },
  };
}
