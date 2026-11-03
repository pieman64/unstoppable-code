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
import { WorkspaceConfigUnreadableError } from '../w5/workspace-manifest-repository';
import { WorkspaceMetadataRefusedError } from '../w5/workspace-metadata/metadata';
import { WorkspacePrivateMemoryRefusedError } from '../w5/workspace-metadata/private-memory';
import { WorkspaceRepositoryRefusedError } from '../w5/workspace-metadata/repositories';
import { ScriptHookSettingsRefusedError } from '../w5/workspace-metadata/settings';
import { w5PathFreeMessage } from '../w5/workspace-metadata/wire-errors';

/*
 * The A7 mapping (W7a, CAN-5523) of the seven `core.workspace.*` metadata
 * commands' failures: each W5 refusal keeps its message and gets its page's
 * kind, `data.code` and retry. A code the operation's enum lacks is left out
 * and `details.reason` names the refusal, so a later additive code applies
 * without a mapping change. Kept apart from the files that call the
 * one-decision runner (RX2): its only `core.*` literals are operation names.
 */

/** A refusal that addressing raised before any key was reserved (RR5). */
export type CoreWorkspaceAddressRefusal =
  | 'not-found'
  | 'duplicate-workspace'
  | 'configuration-unavailable'
  | 'index-unavailable'
  | 'organization-owned';

/** Refused before any key was reserved; nothing was read for the change. */
export class CoreWorkspaceAddressRefusedError extends Error {
  constructor(
    readonly reason: CoreWorkspaceAddressRefusal,
    message: string,
  ) {
    super(message);
    this.name = 'CoreWorkspaceAddressRefusedError';
  }
}

type Retry = 'never' | 'same-key' | 'refresh';

interface WireShape {
  readonly kind: Exclude<CanopyErrorKind, 'internal'>;
  readonly retry: Retry;
  readonly code?: `core.workspace.${string}`;
}

const PRECONDITION: WireShape = { kind: 'failed_precondition', retry: 'never' };
const INVALID_STATE: WireShape = {
  ...PRECONDITION,
  code: 'core.workspace.invalidState',
};
const INVALID: WireShape = { kind: 'invalid_argument', retry: 'never' };

/** Each command refusal's shape, by its `reason`. */
const REFUSALS: Readonly<Record<string, WireShape>> = {
  'invalid-patch': INVALID,
  'invalid-request': INVALID,
  'duplicate-workspace': INVALID,
  'not-found': {
    kind: 'not_found',
    retry: 'never',
    code: 'core.workspace.notFound',
  },
  'selection-unknown': { kind: 'not_found', retry: 'never' },
  duplicate: { kind: 'already_exists', retry: 'never' },
  'read-only-scope': { ...PRECONDITION, code: 'core.workspace.readOnly' },
  'configuration-unavailable': {
    kind: 'failed_precondition',
    retry: 'refresh',
    code: 'core.workspace.configurationUnavailable',
  },
  'index-unavailable': { ...INVALID_STATE, retry: 'refresh' },
  'worktrees-unavailable': { ...INVALID_STATE, retry: 'refresh' },
  'unsupported-for-cowork': INVALID_STATE,
  'managed-by-organization': INVALID_STATE,
  'not-multi-repo': INVALID_STATE,
  'not-a-repository': INVALID_STATE,
  'organization-owned': { kind: 'capability_unavailable', retry: 'never' },
};

/** #6's own enum names a missing member repository. */
const REPOSITORY_NOT_FOUND: WireShape = {
  kind: 'not_found',
  retry: 'never',
  code: 'core.workspace.repositoryNotFound',
};

/** Fixed text where a refusal's own message names a host path. */
const FIXED_MESSAGES: Readonly<Record<string, string>> = {
  'not-a-repository': 'The selected folder is not a Git repository.',
};

const COMMIT_REFUSALS: Partial<
  Record<
    W5CommitRefusedError['reason'],
    WireShape & { readonly reason?: string }
  >
> = {
  'revision-conflict': {
    kind: 'conflict',
    retry: 'refresh',
    code: 'core.workspace.revisionConflict',
  },
  'key-reused': {
    kind: 'conflict',
    retry: 'never',
    code: 'core.workspace.idempotencyKeyReused',
  },
  'in-progress': {
    kind: 'unavailable',
    retry: 'same-key',
    code: 'core.workspace.requestInProgress',
  },
  'recovery-required': {
    ...PRECONDITION,
    code: 'core.workspace.recoveryRequired',
  },
  'outcome-expired': { ...PRECONDITION, code: 'core.workspace.outcomeExpired' },
  'unapplied-change': {
    ...PRECONDITION,
    code: 'core.workspace.recoveryRequired',
    reason: 'unapplied-change',
  },
};

const GENERIC_MESSAGE = 'This change was refused.';

function retryDirective(retry: Retry, resource: string): CanopyRetryDirective {
  switch (retry) {
    case 'never':
      return { kind: 'never' };
    case 'same-key':
      return { kind: 'same_idempotency_key' };
    case 'refresh':
      return { kind: 'after_refresh', resource };
  }
}

function isJsonScalar(value: unknown): value is string | number | boolean {
  return (
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

function refusalReason(error: Error): string | undefined {
  if (
    error instanceof WorkspaceMetadataRefusedError ||
    error instanceof ScriptHookSettingsRefusedError ||
    error instanceof WorkspacePrivateMemoryRefusedError ||
    error instanceof WorkspaceRepositoryRefusedError ||
    error instanceof CoreWorkspaceAddressRefusedError
  )
    return error.reason;
  if (error instanceof WorkspaceIndexUnreadableError)
    return 'index-unavailable';
  if (error instanceof WorkspaceConfigUnreadableError)
    return 'configuration-unavailable';
  return undefined;
}

interface Classified {
  readonly shape: WireShape;
  readonly message: string;
  readonly details?: Record<string, CanopyJsonValue>;
}

/** A command or addressing refusal, by its `reason`. */
function classifyRefusal(
  error: Error,
  operation: string,
): Classified | undefined {
  const reason = refusalReason(error);
  if (reason === undefined) return undefined;
  const shape =
    reason === 'not-found' && operation === 'core.workspace.scripts.update'
      ? REPOSITORY_NOT_FOUND
      : (REFUSALS[reason] ?? PRECONDITION);
  return {
    shape,
    message: FIXED_MESSAGES[reason] ?? error.message,
    details: { reason },
  };
}

/** A commit-log refusal or failure; its details name ids, never paths. */
function classifyCommit(error: Error): Classified | undefined {
  if (error instanceof W5RevisionConflictError)
    return {
      shape: COMMIT_REFUSALS['revision-conflict'] ?? INVALID_STATE,
      message: error.message,
      details: {
        resource: error.resource,
        expected: error.expected,
        actual: error.actual,
      },
    };
  if (error instanceof W5FileWriteRefusedError)
    return {
      shape: {
        kind: 'conflict',
        retry: 'refresh',
        code: 'core.workspace.revisionConflict',
      },
      message: error.message,
      details: { reason: 'concurrent-write' },
    };
  if (!(error instanceof W5CommitRefusedError)) return undefined;
  const shape = COMMIT_REFUSALS[error.reason];
  if (!shape) return undefined;
  const details: Record<string, CanopyJsonValue> = {};
  if (shape.reason) details.reason = shape.reason;
  for (const key of ['commitId', 'reservationId'])
    if (isJsonScalar(error.details[key])) details[key] = error.details[key];
  return { shape, message: error.message, details };
}

/** A host that could not take the call; nothing was decided. */
function classifyHost(error: Error): Classified | undefined {
  if (error instanceof IdentifierValidationError)
    return { shape: INVALID, message: error.message };
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

/** The A7 row of a failure; undefined leaves it untyped (`internal`). */
function classify(error: Error, operation: string): Classified | undefined {
  return (
    classifyRefusal(error, operation) ??
    classifyCommit(error) ??
    classifyHost(error)
  );
}

/** Path-free, within the payload's bounds. */
function wireMessage(message: string): string {
  const text = w5PathFreeMessage(message).slice(0, 4_096);
  return text.length > 0 ? text : GENERIC_MESSAGE;
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
 * Projects a metadata command's failure onto `operation`'s wire. The original
 * error stays the runtime cause, so an in-process projection rethrows it
 * with its exact message; an unclassified failure is returned as it is and
 * the dispatcher answers `internal`, with no text of its own.
 */
export function toCoreWorkspaceMetadataWireError(
  definition: Pick<CanopyInstructionDefinition, 'error'>,
  operation: string,
  error: unknown,
): unknown {
  if (error instanceof CanopyOperationError || !(error instanceof Error))
    return error;
  const classified = classify(error, operation);
  if (!classified) return error;
  const { shape } = classified;
  const details = pathFreeDetails(classified.details);
  const payload: CanopyErrorPayload = {
    kind: shape.kind,
    message: wireMessage(classified.message),
    ...(details && { details }),
    retry: retryDirective(
      shape.retry,
      operation === 'core.workspace.reorder'
        ? 'core.workspace.list'
        : 'core.workspace.get',
    ),
  };
  const coded = shape.code ? { ...payload, code: shape.code } : payload;
  return new CanopyOperationError(
    definition.error.safeParse(coded).success ? coded : payload,
    error,
  );
}
