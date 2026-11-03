import {
  CanopyErrorPayloadSchema,
  type CanopyErrorKind,
  type CanopyErrorPayload,
  type CanopyInstructionDefinition,
  type CanopyRetryDirective,
} from '@canopy/protocol/canopy-core';
import { CanopyOperationError } from '../../runtime/errors';
import { w5PathFreeMessage } from '../w5/workspace-metadata/wire-errors';
import { toCoreWorkspaceMetadataWireError } from './metadata-wire-errors';

/*
 * The A7 mapping (W7b-4, CAN-5552) of the keyed source, composition, rename
 * and fork lifecycles' failures. A host refusal arrives as a
 * {@link CoreLifecycleRefusedError} naming its reason, and gets its page's
 * kind, `data.code` and retry; refusals without a code of their own use
 * `invalidState` with `details.reason`. Commit-log, revision and identifier
 * failures take W7a's rows (`metadata-wire-errors.ts`), under the
 * operation's own domain. Kept apart from the files that call the
 * one-decision runner (RX2).
 */

type Retry = 'never' | 'refresh';
type CodeSuffix =
  | 'notFound'
  | 'readOnly'
  | 'configurationUnavailable'
  | 'invalidState';

interface RefusalShape {
  readonly kind: Exclude<CanopyErrorKind, 'internal'>;
  readonly retry: Retry;
  readonly code?: CodeSuffix;
}

const NOT_FOUND: RefusalShape = {
  kind: 'not_found',
  retry: 'never',
  code: 'notFound',
};
const INVALID: RefusalShape = { kind: 'invalid_argument', retry: 'never' };
const UNAVAILABLE: RefusalShape = {
  kind: 'capability_unavailable',
  retry: 'never',
};
const STATE: RefusalShape = {
  kind: 'failed_precondition',
  retry: 'never',
  code: 'invalidState',
};
const STALE_STATE: RefusalShape = { ...STATE, retry: 'refresh' };

/** Every host refusal reason these operations name, with its wire row. */
const REFUSALS = {
  // Addressing and request validation.
  'not-found': NOT_FOUND,
  'invalid-request': INVALID,
  'invalid-branch-name': INVALID,
  'invalid-destination': INVALID,
  'not-multi-repo': INVALID,
  'duplicate-workspace': INVALID,
  'configuration-unavailable': {
    kind: 'failed_precondition',
    retry: 'refresh',
    code: 'configurationUnavailable',
  },
  'read-only-scope': {
    kind: 'failed_precondition',
    retry: 'never',
    code: 'readOnly',
  },
  // Capabilities the desktop host cannot offer on the wire.
  'option-unavailable': UNAVAILABLE,
  'preview-unavailable': UNAVAILABLE,
  'feature-unavailable': UNAVAILABLE,
  // Lifecycle state refusals.
  'index-unavailable': STALE_STATE,
  'worktrees-unavailable': STALE_STATE,
  'has-worktrees': STALE_STATE,
  'branch-unavailable': STALE_STATE,
  'source-unavailable': STALE_STATE,
  'destination-unavailable': STALE_STATE,
  temporary: STATE,
  'not-temporary': STATE,
  'already-initialized': STATE,
  'no-source-repository': STATE,
  'not-single-repo': STALE_STATE,
  'cowork-workspace': STATE,
  'organization-owned': STATE,
  'owner-mismatch': STATE,
  'organization-creation-unavailable': STATE,
  'organization-project-limit': STATE,
  'organization-already-bound': STATE,
  'organization-repository-inaccessible': STATE,
  'organization-shape-unsupported': STATE,
  'organization-creation-failed': STATE,
  // The organization repository sync (#17's multi-repo additions): only a
  // repository the organization does not hold never succeeds as sent.
  'organization-catalog-unavailable': STALE_STATE,
  'organization-remote-unreadable': STALE_STATE,
  'organization-repository-outside': STATE,
  'organization-repository-mismatch': STALE_STATE,
  'organization-sync-failed': STALE_STATE,
  // A wire addition names no folder, so its repository must be bound here.
  'repository-not-local': STATE,
  // `canopy.json` already saves the addition's id for another repository.
  'repository-id-conflict': STATE,
} as const satisfies Readonly<Record<string, RefusalShape>>;

export type CoreLifecycleRefusal = keyof typeof REFUSALS;

export function isCoreLifecycleRefusal(
  reason: string,
): reason is CoreLifecycleRefusal {
  return Object.prototype.hasOwnProperty.call(REFUSALS, reason);
}

/**
 * A lifecycle host's typed refusal. Before the reservation (RR5) it consumes
 * no key; `hostError` is the host's own refusal, kept as the runtime cause.
 */
export class CoreLifecycleRefusedError extends Error {
  constructor(
    readonly reason: CoreLifecycleRefusal,
    message: string,
    readonly hostError?: unknown,
  ) {
    super(message);
    this.name = 'CoreLifecycleRefusedError';
  }
}

/** Where a client rereads before retrying an `after_refresh` failure. */
const REFRESH_RESOURCES: Readonly<Record<string, string>> = {
  'core.worktree.branch.rename': 'core.worktree.get',
  'core.sharedContainer.fork': 'core.workspace.list',
  'core.workspace.composition.combine': 'core.workspace.composition.options',
  'core.workspace.composition.split':
    'core.workspace.composition.split.preview',
};

function refreshResource(operation: string): string {
  return REFRESH_RESOURCES[operation] ?? 'core.workspace.get';
}

function operationDomain(operation: string): string {
  return operation.split('.')[1] ?? 'workspace';
}

function retryDirective(retry: Retry, operation: string): CanopyRetryDirective {
  return retry === 'never'
    ? { kind: 'never' }
    : { kind: 'after_refresh', resource: refreshResource(operation) };
}

function wireMessage(message: string): string {
  const text = w5PathFreeMessage(message).slice(0, 4_096);
  return text.length > 0 ? text : 'This change was refused.';
}

/** The payload with its code kept only where the operation's enum has it. */
function conformed(
  definition: Pick<CanopyInstructionDefinition, 'error'>,
  payload: CanopyErrorPayload,
): CanopyErrorPayload {
  if (payload.code === undefined || definition.error.safeParse(payload).success)
    return payload;
  return {
    kind: payload.kind,
    message: payload.message,
    retry: payload.retry,
    ...(payload.details !== undefined && { details: payload.details }),
  };
}

function refusalPayload(
  error: CoreLifecycleRefusedError,
  operation: string,
): CanopyErrorPayload {
  const shape: RefusalShape = REFUSALS[error.reason];
  return {
    kind: shape.kind,
    message: wireMessage(error.message),
    details: { reason: error.reason },
    retry: retryDirective(shape.retry, operation),
    ...(shape.code && {
      code: `core.${operationDomain(operation)}.${shape.code}`,
    }),
  };
}

/** W7a's commit-log rows, moved to the operation's domain and resource. */
function commitPayload(
  payload: CanopyErrorPayload,
  operation: string,
): CanopyErrorPayload {
  const prefix = 'core.workspace.';
  const suffix = payload.code?.startsWith(prefix)
    ? payload.code.slice(prefix.length)
    : undefined;
  const { retry } = payload;
  return {
    ...payload,
    ...(suffix !== undefined && {
      code: `core.${operationDomain(operation)}.${suffix}`,
    }),
    retry:
      retry.kind === 'after_refresh'
        ? { ...retry, resource: refreshResource(operation) }
        : retry,
  };
}

/**
 * Projects a lifecycle failure onto `operation`'s wire. The original error
 * stays the runtime cause, so an in-process caller can rethrow it; an
 * unclassified failure is returned as it is and the dispatcher answers
 * `internal`, with no text of its own.
 */
export function toCoreLifecycleWireError(
  definition: Pick<CanopyInstructionDefinition, 'error'>,
  operation: string,
  error: unknown,
): unknown {
  if (error instanceof CoreLifecycleRefusedError)
    return new CanopyOperationError(
      conformed(definition, refusalPayload(error, operation)),
      error.hostError ?? error,
    );
  const mapped = toCoreWorkspaceMetadataWireError(
    { error: CanopyErrorPayloadSchema },
    operation,
    error,
  );
  if (!(mapped instanceof CanopyOperationError) || mapped === error)
    return mapped;
  return new CanopyOperationError(
    conformed(definition, commitPayload(mapped.payload, operation)),
    mapped.runtimeCause,
  );
}
