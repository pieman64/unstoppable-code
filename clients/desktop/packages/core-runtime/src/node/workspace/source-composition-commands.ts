import {
  CORE_SOURCE_COMPOSITION_INSTRUCTION_DEFINITIONS,
  type CanopyCallerDescriptor,
  type CoreSharedContainerForkParams,
  type CoreSharedContainerForkResult,
  type CoreWorkspaceSourceChangesApplyParams,
  type CoreWorkspaceSourceChangesApplyResult,
  type CoreWorkspaceSourceRepoInitializeResult,
  type CoreWorkspaceTypeConvertParams,
  type CoreWorkspaceTypeConvertResult,
  type CoreWorktreeBranchRenameParams,
  type CoreWorktreeBranchRenameResult,
} from '@canopy/protocol/canopy-core';
import { CanopyOperationError } from '../../runtime/errors';
import type {
  CanopyDispatcherInstructionHandlerMap,
  CanopyHandlerContext,
} from '../../runtime/types';
import {
  deriveCoreLifecycleOperationId,
  isCoreWorkspaceLifecycleCaller,
} from './lifecycle-commands';
import {
  CoreLifecycleRefusedError,
  toCoreLifecycleWireError,
} from './source-composition-wire-errors';

/*
 * The keyed source, composition, rename and fork lifecycles (W7b-4,
 * CAN-5552) over a host port. Core admits the caller (Q8), maps the wire
 * request to the host's typed command and its failures to the pages' A7
 * codes; the host runs its existing lifecycle boundary, scopes receipts to
 * the caller's principal and addresses the request before any key is
 * reserved (RR5). Params never carry a source, a scope or a host path.
 */

export const CORE_SOURCE_COMPOSITION_COMMAND_DEFINITIONS =
  CORE_SOURCE_COMPOSITION_INSTRUCTION_DEFINITIONS;

type Definitions = typeof CORE_SOURCE_COMPOSITION_COMMAND_DEFINITIONS;
export type CoreSourceCompositionCommandName = Extract<
  keyof Definitions,
  string
>;

/** One wire call: the authenticated caller and the request's key. */
export interface CoreSourceCompositionCall {
  readonly caller: CanopyCallerDescriptor;
  readonly idempotencyKey: string;
}

type Input<Params> = Omit<Params, '_meta'>;

export interface CoreSourceCompositionHost {
  initializeSourceRepo(
    input: {
      workspaceId: string;
      expectedRevision?: number;
      repoName?: string;
    },
    call: CoreSourceCompositionCall,
  ): Promise<CoreWorkspaceSourceRepoInitializeResult>;
  convertType(
    input: Input<CoreWorkspaceTypeConvertParams>,
    call: CoreSourceCompositionCall,
  ): Promise<CoreWorkspaceTypeConvertResult>;
  applySourceChanges(
    input: Input<CoreWorkspaceSourceChangesApplyParams>,
    call: CoreSourceCompositionCall,
  ): Promise<CoreWorkspaceSourceChangesApplyResult>;
  /** Resolves once the decision commits; the result is the promoted id. */
  promote(
    input: { workspaceId: string; expectedRevision: number; name: string },
    call: CoreSourceCompositionCall,
  ): Promise<{ workspaceId: string }>;
  renameBranch(
    input: Input<CoreWorktreeBranchRenameParams>,
    call: CoreSourceCompositionCall,
  ): Promise<CoreWorktreeBranchRenameResult>;
  fork(
    input: Input<CoreSharedContainerForkParams>,
    call: CoreSourceCompositionCall,
  ): Promise<CoreSharedContainerForkResult>;
}

export type CoreSourceCompositionHandlers =
  CanopyDispatcherInstructionHandlerMap<Definitions>;

/** The message a refused lifecycle caller sees. */
export const CORE_LIFECYCLE_CALLER_REFUSED_MESSAGE =
  'This change is available only from the desktop app on this machine.';

/**
 * W7b-3's caller rule (Q8, OD-4), refused as these pages document it: with
 * `details.reason: "caller-refused"` and wording that fits any lifecycle
 * (W7b-3's message names creates), before any read.
 */
function assertLifecycleCaller(caller: CanopyCallerDescriptor): void {
  if (isCoreWorkspaceLifecycleCaller(caller)) return;
  throw new CanopyOperationError({
    kind: 'permission_denied',
    message: CORE_LIFECYCLE_CALLER_REFUSED_MESSAGE,
    details: { reason: 'caller-refused' },
    retry: { kind: 'never' },
  });
}

function call(context: CanopyHandlerContext): CoreSourceCompositionCall {
  const key = context.metadata.idempotencyKey;
  // The dispatcher refuses a keyed instruction without a key first.
  if (!key) throw new Error('An idempotency key is required.');
  return { caller: context.caller, idempotencyKey: key };
}

/**
 * The combine option and split preview ids come from
 * `core.workspace.composition.options` and `.split.preview`, which no
 * desktop host serves yet, so no id can be redeemed (CAN-3823's page
 * amendment or those queries lift this).
 */
function unredeemable(
  reason: 'option-unavailable' | 'preview-unavailable',
): CoreLifecycleRefusedError {
  return new CoreLifecycleRefusedError(
    reason,
    reason === 'option-unavailable'
      ? 'Combining projects from a composition option is unavailable on this host.'
      : 'Splitting a project from a split preview is unavailable on this host.',
  );
}

/** The eight handlers over `host`; register them only where `host` runs. */
export function createCoreSourceCompositionHandlers(
  host: CoreSourceCompositionHost,
): CoreSourceCompositionHandlers {
  const run = async <Result>(
    operation: CoreSourceCompositionCommandName,
    context: CanopyHandlerContext,
    command: (call: CoreSourceCompositionCall) => Promise<Result>,
  ): Promise<Result> => {
    assertLifecycleCaller(context.caller);
    try {
      return await command(call(context));
    } catch (error) {
      throw toCoreLifecycleWireError(
        CORE_SOURCE_COMPOSITION_COMMAND_DEFINITIONS[operation],
        operation,
        error,
      );
    }
  };
  return {
    'core.workspace.sourceRepo.initialize': (params, context) =>
      run('core.workspace.sourceRepo.initialize', context, (wire) =>
        host.initializeSourceRepo(params, wire),
      ),
    'core.workspace.type.convert': (params, context) =>
      run('core.workspace.type.convert', context, (wire) =>
        host.convertType(params, wire),
      ),
    'core.workspace.sourceChanges.apply': (params, context) =>
      run('core.workspace.sourceChanges.apply', context, (wire) =>
        host.applySourceChanges(params, wire),
      ),
    'core.workspace.composition.combine': (_params, context) =>
      run('core.workspace.composition.combine', context, () =>
        Promise.reject(unredeemable('option-unavailable')),
      ),
    'core.workspace.composition.split': (_params, context) =>
      run('core.workspace.composition.split', context, () =>
        Promise.reject(unredeemable('preview-unavailable')),
      ),
    'core.workspace.composition.promote': (params, context) =>
      run('core.workspace.composition.promote', context, async (wire) => {
        const { workspaceId } = await host.promote(
          {
            workspaceId: params.workspaceId,
            expectedRevision: params.expectedRevision,
            name: params.name,
          },
          wire,
        );
        return {
          workspaceId,
          operation: {
            // DP-3: a same-key replay answers the same id.
            operationId: deriveCoreLifecycleOperationId(
              wire.caller.principalId,
              'core.workspace.composition.promote',
              wire.idempotencyKey,
            ),
            state: 'succeeded' as const,
          },
        };
      }),
    'core.worktree.branch.rename': (params, context) =>
      run('core.worktree.branch.rename', context, (wire) =>
        host.renameBranch(params, wire),
      ),
    'core.sharedContainer.fork': (params, context) =>
      run('core.sharedContainer.fork', context, (wire) =>
        host.fork(params, wire),
      ),
  };
}
