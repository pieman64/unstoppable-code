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
import { ScriptHookSettingsRefusedError } from '../w5/workspace-metadata/settings';
import { w5PathFreeMessage } from '../w5/workspace-metadata/wire-errors';
import { CoreWorkspaceAddressRefusedError } from './metadata-wire-errors';

/*
 * The A7 mapping (W7b-1b, CAN-5549; W7b-1c, CAN-5568) of the guarded W5
 * commands' failures: #7 `core.workspace.hooks.update`, #9
 * `.plugins.update`, #11 `.retention.update`, #12 `.cowork.update`, #22
 * `core.worktree.update`, #23 `.reorder` and #26 `.hooks.setPaused`. Each
 * refusal keeps its message and gets its page's kind, `data.code` and retry,
 * with `details.reason` naming it; a precondition the operation's enum has
 * no code for takes `invalidState` where the enum has that, and is uncoded
 * otherwise. Kept apart from the files that call the one-decision runner
 * (RX2): its only `core.*` literals are operation names.
 */

/** Why a guarded command's host refused a wire call. */
export type CoreGuardedRefusal =
  // The desktop boundaries' own refusals, carried by their host.
  | 'invalid-patch'
  | 'invalid-request'
  | 'read-only-scope'
  | 'not-found'
  | 'configuration-unavailable'
  | 'worktrees-unavailable'
  | 'unsupported-for-cowork'
  | 'retention-busy'
  // #12's Auto Delete stamp failed before any decision.
  | 'activity-unavailable'
  // Addressing, before any key is reserved (RR5).
  | 'duplicate-workspace'
  | 'index-unavailable'
  | 'ambiguous-worktree'
  | 'scope-unavailable'
  | 'organization-owned'
  // DP-1: the row's read withholds its revision for a reason other than
  // having none committed; `pending` may settle, the rest never do.
  | 'revision-pending'
  | 'revision-unverified';

/**
 * A guarded command's typed refusal as its host reports it to the wire,
 * keeping the boundary's own error when it translated one.
 */
export class CoreGuardedRefusedError extends Error {
  constructor(
    readonly reason: CoreGuardedRefusal,
    message: string,
    /** The boundary's own refusal, when the host translated one. */
    readonly boundaryError?: Error,
  ) {
    super(message);
    this.name = 'CoreGuardedRefusedError';
  }
}

type Retry = 'never' | 'same-key' | 'refresh';
type Domain = 'workspace' | 'worktree';

interface WireShape {
  readonly kind: Exclude<CanopyErrorKind, 'internal'>;
  readonly retry: Retry;
  /** The code's last segment; the operation's domain prefixes it. */
  readonly code?: string;
}

const NEVER_PRECONDITION: WireShape = {
  kind: 'failed_precondition',
  retry: 'never',
};
const INVALID: WireShape = { kind: 'invalid_argument', retry: 'never' };
const INVALID_STATE: WireShape = {
  ...NEVER_PRECONDITION,
  code: 'invalidState',
};

/** Each refusal's shape, by its `reason`; `not-found` depends on the page. */
const REFUSALS: Readonly<Record<CoreGuardedRefusal, WireShape>> = {
  'invalid-patch': INVALID,
  'invalid-request': INVALID,
  'duplicate-workspace': INVALID,
  'ambiguous-worktree': INVALID,
  'read-only-scope': { ...NEVER_PRECONDITION, code: 'readOnly' },
  'not-found': { kind: 'not_found', retry: 'never', code: 'notFound' },
  'configuration-unavailable': {
    kind: 'failed_precondition',
    retry: 'refresh',
    code: 'configurationUnavailable',
  },
  'index-unavailable': { ...INVALID_STATE, retry: 'refresh' },
  'worktrees-unavailable': {
    kind: 'unavailable',
    retry: 'same-key',
    code: 'listUnavailable',
  },
  'unsupported-for-cowork': INVALID_STATE,
  'retention-busy': { ...INVALID_STATE, retry: 'refresh' },
  'activity-unavailable': { ...INVALID_STATE, retry: 'same-key' },
  'scope-unavailable': { kind: 'capability_unavailable', retry: 'never' },
  'organization-owned': { kind: 'capability_unavailable', retry: 'never' },
  'revision-pending': { ...INVALID_STATE, retry: 'refresh' },
  'revision-unverified': INVALID_STATE,
};

/** A page's own shape for a refusal, over `REFUSALS`. */
const OPERATION_REFUSALS: Readonly<
  Record<string, Partial<Record<CoreGuardedRefusal, WireShape>>>
> = {
  // #7's own code for a member repository it cannot find.
  'core.workspace.hooks.update': {
    'not-found': {
      kind: 'not_found',
      retry: 'never',
      code: 'repositoryNotFound',
    },
  },
  // #12's page reads an unreadable index as unavailable configuration.
  'core.workspace.cowork.update': {
    'index-unavailable': REFUSALS['configuration-unavailable'],
  },
};

/** `details.reason` spellings a page publishes (#11, DP-1). */
const PUBLISHED_REASONS: Partial<Record<CoreGuardedRefusal, string>> = {
  'unsupported-for-cowork': 'cowork_workspace',
  'retention-busy': 'retention_busy',
  'activity-unavailable': 'activity_unavailable',
  'revision-pending': 'revision-unverified',
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
  'recovery-required': { ...NEVER_PRECONDITION, code: 'recoveryRequired' },
  'outcome-expired': { ...NEVER_PRECONDITION, code: 'outcomeExpired' },
  'unapplied-change': {
    ...NEVER_PRECONDITION,
    code: 'recoveryRequired',
    reason: 'unapplied-change',
  },
};

const GENERIC_MESSAGE = 'This change was refused.';

/** The read a refusal's `after_refresh` names. */
const REFRESH_RESOURCES: Readonly<Record<string, string>> = {
  'core.workspace.hooks.update': 'core.workspace.get',
  'core.workspace.plugins.update': 'core.workspace.get',
  'core.workspace.retention.update': 'core.workspace.get',
  'core.workspace.cowork.update': 'core.workspace.get',
  'core.worktree.update': 'core.worktree.get',
  'core.worktree.hooks.setPaused': 'core.worktree.get',
  'core.worktree.reorder': 'core.worktree.list',
};

function domainOf(operation: string): Domain {
  return operation.startsWith('core.worktree.') ? 'worktree' : 'workspace';
}

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

function refusalReason(error: Error): CoreGuardedRefusal | undefined {
  // #7's and #26's boundaries throw the core settings refusal, and the
  // shared workspace addressing (W7a) its own.
  if (
    error instanceof CoreGuardedRefusedError ||
    error instanceof ScriptHookSettingsRefusedError ||
    error instanceof CoreWorkspaceAddressRefusedError
  )
    return error.reason;
  if (error instanceof WorkspaceIndexUnreadableError)
    return 'index-unavailable';
  return undefined;
}

interface Classified {
  readonly shape: WireShape;
  readonly message: string;
  readonly details?: Record<string, CanopyJsonValue>;
}

function classifyRefusal(
  error: Error,
  operation: string,
): Classified | undefined {
  const reason = refusalReason(error);
  if (reason === undefined) return undefined;
  const shape = OPERATION_REFUSALS[operation]?.[reason] ?? REFUSALS[reason];
  return {
    shape,
    message: error.message,
    details: { reason: PUBLISHED_REASONS[reason] ?? reason },
  };
}

/** A commit-log refusal or failure; its details name ids, never paths. */
function classifyCommit(error: Error): Classified | undefined {
  if (error instanceof W5RevisionConflictError)
    return {
      shape: { kind: 'conflict', retry: 'refresh', code: 'revisionConflict' },
      message: error.message,
      details: {
        resource: error.resource,
        expected: error.expected,
        actual: error.actual,
      },
    };
  if (error instanceof W5FileWriteRefusedError)
    return {
      shape: { kind: 'conflict', retry: 'refresh', code: 'revisionConflict' },
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
          ? NEVER_PRECONDITION
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
 * Projects a guarded command's failure onto `operation`'s wire. The original
 * error stays the runtime cause; an unclassified failure is returned as it is
 * and the dispatcher answers `internal`, with no text of its own.
 */
export function toCoreGuardedWireError(
  definition: Pick<CanopyInstructionDefinition, 'error'>,
  operation: string,
  error: unknown,
): unknown {
  if (error instanceof CanopyOperationError || !(error instanceof Error))
    return error;
  const classified =
    classifyRefusal(error, operation) ??
    classifyCommit(error) ??
    classifyHost(error);
  if (!classified) return error;
  const { shape } = classified;
  const details = pathFreeDetails(classified.details);
  const payload: CanopyErrorPayload = {
    kind: shape.kind,
    message: wireMessage(classified.message),
    ...(details && { details }),
    retry: retryDirective(
      shape.retry,
      REFRESH_RESOURCES[operation] ?? 'core.workspace.get',
    ),
  };
  return new CanopyOperationError(
    codedPayload(definition, operation, payload, shape),
    error,
  );
}

/**
 * The payload with its code, when the operation's enum has it. A
 * precondition refusal without one of its own takes `invalidState` where the
 * enum has that (the pages' rule); otherwise it is uncoded.
 */
function codedPayload(
  definition: Pick<CanopyInstructionDefinition, 'error'>,
  operation: string,
  payload: CanopyErrorPayload,
  shape: WireShape,
): CanopyErrorPayload {
  const prefix: `core.${Domain}` = `core.${domainOf(operation)}`;
  const candidates: `core.${Domain}.${string}`[] = [];
  if (shape.code) candidates.push(`${prefix}.${shape.code}`);
  if (shape.kind === 'failed_precondition')
    candidates.push(`${prefix}.invalidState`);
  for (const code of candidates) {
    const coded = { ...payload, code };
    if (definition.error.safeParse(coded).success) return coded;
  }
  return payload;
}
