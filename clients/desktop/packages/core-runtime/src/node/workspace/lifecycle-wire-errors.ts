import {
  hasHostAbsolutePath,
  type CanopyErrorKind,
  type CanopyErrorPayload,
  type CanopyInstructionDefinition,
  type CanopyJsonValue,
  type CanopyRetryDirective,
} from '@canopy/protocol/canopy-core';
import { CanopyOperationError } from '../../runtime/errors';
import { StorageWriteRefusedError } from '../../storage';
import { IdentifierValidationError } from '../identifiers';
import {
  W5CommitLogError,
  W5CommitRefusedError,
} from '../w5/commit-log/errors';
import { W5CommitLogHostError } from '../w5/commit-log-host';
import {
  W5FileWriteRefusedError,
  W5RevisionConflictError,
} from '../w5/commit-log-file-store';
import { WorkspaceIndexUnreadableError } from '../w5/workspace-index-repository';
import { w5PathFreeMessage } from '../w5/workspace-metadata/wire-errors';

/*
 * The A7 mapping of the lifecycle commands: the creates #1, #2 and #21
 * (W7b-3, CAN-5551), and archive #24, workspace delete #5 and archive restore
 * #28 (W7b-2a, CAN-5550). Each refusal gets its page's kind, retry and
 * `data.code`, and always names itself in `details.reason`. A code the
 * operation's enum lacks is dropped. Kept apart from the one-decision
 * runner's files (RX2).
 */

export type CoreLifecycleNamespace =
  | 'core.workspace'
  | 'core.worktree'
  | 'core.archive';

/**
 * How one operation's page differs from the creates' default. Omitted, a
 * refresh is of `<namespace>.list` and a revision conflict names both
 * revisions.
 */
export interface CoreLifecycleWireProfile {
  readonly namespace: CoreLifecycleNamespace;
  /** The resource an `after_refresh` retry names. */
  readonly refreshResource?: string;
  /**
   * DP-1: a revision conflict names the resource and the expected revision,
   * never the stored one, which a read may withhold.
   */
  readonly withholdStoredRevision?: boolean;
  /** The archive page names both recovery classes `recovery-required`. */
  readonly oneRecoveryReason?: boolean;
}

type Retry = 'never' | 'same-key' | 'refresh';

/** The page code suffixes a lifecycle refusal may carry. */
export type CoreLifecycleCode =
  | 'invalidState'
  | 'notFound'
  | 'revisionConflict'
  | 'idempotencyKeyReused'
  | 'requestInProgress'
  | 'recoveryRequired'
  | 'outcomeExpired'
  | 'expired';

export interface CoreLifecycleRefusalShape {
  readonly kind: Exclude<CanopyErrorKind, 'internal'>;
  readonly retry: Retry;
  readonly code?: CoreLifecycleCode;
}

/**
 * A host's typed refusal of a lifecycle create, raised outside the keyed
 * runner (so it never decides whether a reservation is released). `reason`
 * names it on the wire; the message must already be the one users see.
 */
export class CoreLifecycleRefusedError extends Error {
  constructor(
    readonly reason: string,
    message: string,
    readonly shape: CoreLifecycleRefusalShape,
    readonly hostError?: unknown,
  ) {
    super(message);
    this.name = 'CoreLifecycleRefusedError';
  }
}

const PRECONDITION: CoreLifecycleRefusalShape = {
  kind: 'failed_precondition',
  retry: 'never',
};

const COMMIT_REFUSALS: Partial<
  Record<W5CommitRefusedError['reason'], CoreLifecycleRefusalShape>
> = {
  'revision-conflict': {
    kind: 'conflict',
    retry: 'refresh',
    code: 'revisionConflict',
  },
  'key-reused': {
    kind: 'conflict',
    retry: 'never',
    code: 'idempotencyKeyReused',
  },
  'in-progress': {
    kind: 'unavailable',
    retry: 'same-key',
    code: 'requestInProgress',
  },
  'recovery-required': { ...PRECONDITION, code: 'recoveryRequired' },
  'outcome-expired': { ...PRECONDITION, code: 'outcomeExpired' },
  'unapplied-change': { ...PRECONDITION, code: 'recoveryRequired' },
};

interface Classified {
  readonly shape: CoreLifecycleRefusalShape;
  readonly message: string;
  readonly details?: Record<string, CanopyJsonValue>;
}

function isJsonScalar(value: unknown): value is string | number | boolean {
  return (
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

const REVISION_CONFLICT: CoreLifecycleRefusalShape = {
  kind: 'conflict',
  retry: 'refresh',
  code: 'revisionConflict',
};

/** DP-1's revision conflict: the resource and the expected revision only. */
function expectedRevisionConflict(
  message: string,
  resource: unknown,
  expected: unknown,
  ids: Record<string, CanopyJsonValue>,
): Classified {
  const details: Record<string, CanopyJsonValue> = {
    reason: 'revision-conflict',
    ...ids,
  };
  if (typeof resource === 'string') details.resource = resource;
  if (isJsonScalar(expected)) details.expected = expected;
  return { shape: REVISION_CONFLICT, message, details };
}

function classifyCommit(
  error: Error,
  profile: CoreLifecycleWireProfile,
): Classified | undefined {
  if (error instanceof W5RevisionConflictError)
    return profile.withholdStoredRevision
      ? expectedRevisionConflict(
          error.message,
          error.resource,
          error.expected,
          {},
        )
      : {
          shape: REVISION_CONFLICT,
          message: error.message,
          details: {
            reason: 'revision-conflict',
            resource: error.resource,
            expected: error.expected,
            actual: error.actual,
          },
        };
  if (error instanceof W5FileWriteRefusedError)
    return {
      shape: REVISION_CONFLICT,
      message: error.message,
      details: { reason: 'concurrent-write' },
    };
  if (!(error instanceof W5CommitRefusedError)) return undefined;
  const shape = COMMIT_REFUSALS[error.reason];
  if (!shape) return undefined;
  const ids: Record<string, CanopyJsonValue> = {};
  for (const key of ['commitId', 'reservationId'])
    if (isJsonScalar(error.details[key])) ids[key] = error.details[key];
  if (error.reason === 'revision-conflict' && profile.withholdStoredRevision)
    return expectedRevisionConflict(
      error.message,
      error.details.resource,
      error.details.expected,
      ids,
    );
  const reason =
    error.reason === 'unapplied-change' && profile.oneRecoveryReason
      ? 'recovery-required'
      : error.reason;
  return { shape, message: error.message, details: { reason, ...ids } };
}

function classifyHost(error: Error): Classified | undefined {
  if (error instanceof CoreLifecycleRefusedError)
    return {
      shape: error.shape,
      message: error.message,
      details: { reason: error.reason },
    };
  if (error instanceof IdentifierValidationError)
    return {
      shape: { kind: 'invalid_argument', retry: 'never' },
      message: error.message,
    };
  if (error instanceof WorkspaceIndexUnreadableError)
    return {
      shape: { ...PRECONDITION, retry: 'refresh', code: 'invalidState' },
      message: error.message,
      details: { reason: 'index-unavailable' },
    };
  if (error instanceof W5CommitLogError)
    return {
      shape:
        error.code === 'UNSUPPORTED_SCHEMA'
          ? PRECONDITION
          : { kind: 'unavailable', retry: 'same-key' },
      message: error.message,
      details: { code: error.code },
    };
  if (error instanceof W5CommitLogHostError && error.reason === 'unavailable')
    return {
      shape: { kind: 'unavailable', retry: 'same-key' },
      message: error.message,
    };
  if (error instanceof StorageWriteRefusedError)
    return {
      shape: { kind: 'capability_unavailable', retry: 'never' },
      message: error.message,
      details: { namespaceId: error.namespaceId, reason: error.reason },
    };
  return undefined;
}

function retryDirective(
  retry: Retry,
  profile: CoreLifecycleWireProfile,
  keyed: boolean,
): CanopyRetryDirective {
  switch (retry) {
    case 'never':
      return { kind: 'never' };
    case 'same-key':
      // An inherent operation has no key: its retry is the same request.
      return keyed
        ? { kind: 'same_idempotency_key' }
        : { kind: 'same_request' };
    case 'refresh':
      return {
        kind: 'after_refresh',
        resource: profile.refreshResource ?? `${profile.namespace}.list`,
      };
  }
}

function wireCode(
  namespace: CoreLifecycleNamespace,
  code: CoreLifecycleCode,
): `${CoreLifecycleNamespace}.${CoreLifecycleCode}` {
  return `${namespace}.${code}`;
}

function wireMessage(message: string): string {
  const text = w5PathFreeMessage(message).slice(0, 4_096);
  return text.length > 0 ? text : 'This request was refused.';
}

function pathFreeDetails(
  details: Record<string, CanopyJsonValue> | undefined,
): Record<string, CanopyJsonValue> | undefined {
  if (!details) return undefined;
  const kept = Object.entries(details).filter(
    ([, value]) => !hasHostAbsolutePath(value),
  );
  return kept.length > 0 ? Object.fromEntries(kept) : undefined;
}

/**
 * Projects a lifecycle command's failure onto its wire. The original error
 * stays the runtime cause; an unclassified failure is returned as it is and
 * the dispatcher answers a redacted `internal`.
 */
export function toCoreLifecycleWireError(
  definition: Pick<CanopyInstructionDefinition, 'error' | 'idempotency'>,
  page: CoreLifecycleNamespace | CoreLifecycleWireProfile,
  error: unknown,
): unknown {
  if (error instanceof CanopyOperationError || !(error instanceof Error))
    return error;
  const profile = typeof page === 'string' ? { namespace: page } : page;
  const { namespace } = profile;
  const classified = classifyCommit(error, profile) ?? classifyHost(error);
  if (!classified) return error;
  const { shape } = classified;
  const details = pathFreeDetails(classified.details);
  const payload: CanopyErrorPayload = {
    kind: shape.kind,
    message: wireMessage(classified.message),
    ...(details && { details }),
    retry: retryDirective(
      shape.retry,
      profile,
      definition.idempotency === 'keyed',
    ),
  };
  const coded = shape.code
    ? { ...payload, code: wireCode(namespace, shape.code) }
    : payload;
  return new CanopyOperationError(
    definition.error.safeParse(coded).success ? coded : payload,
    error instanceof CoreLifecycleRefusedError && error.hostError !== undefined
      ? error.hostError
      : error,
  );
}
