import { CanopyClientError } from '@canopy/core-client';
import { CanopyOperationError } from '@canopy/core-runtime';
import type { FilesystemEntryMutationHost } from '@canopy/core-runtime/node';
import type {
  CanopyCallerDescriptor,
  CanopyWorkspaceScope,
} from '@canopy/protocol/canopy-core';
import type {
  FileTreeMutationRequest,
  FileTreeMutationResponse,
} from '@canopy/desktop-shared/types';
import { DAEMON_FILES_EXCLUDED_WORKSPACE_IDS } from './daemon-files-route';
import type {
  DaemonFilesRouteOptions,
  DaemonFilesRouteSender,
} from './daemon-files-route';
import { evaluateLocalRouteTarget } from './daemon-read-route-guard';
import type { ElectronDaemonClient } from './electron-daemon-host';
import {
  deleteFileTreeEntryForLegacyIpc,
  transferFileTreeEntryForLegacyIpc,
  toLegacyFileTreeMutationError,
  type EntryCopyDispatch,
  type EntryDeleteDispatch,
  type EntryMoveDispatch,
  type LegacyEntryMutationHost,
} from './worker-filesystem-mutation-adapter';

export interface DaemonEntryRouteOptions extends Pick<
  DaemonFilesRouteOptions,
  'lifetime' | 'workspaceType' | 'resolveWorktreeTargetIds'
> {
  readonly host: Pick<FilesystemEntryMutationHost, 'os' | 'assertMutable'>;
  readonly hostContext: () => Promise<{ readonly authorityId: string }>;
  readonly connections: () => {
    get(
      caller: CanopyCallerDescriptor,
      owner: AbortSignal,
    ): Promise<{
      readonly client: Pick<
        ElectronDaemonClient,
        'instruction' | 'query' | 'signal'
      >;
    }>;
  };
}

export interface DaemonEntryRequest {
  readonly sender: DaemonFilesRouteSender;
  readonly caller: CanopyCallerDescriptor;
}

type EntryRequest = Extract<
  FileTreeMutationRequest,
  { operation: 'delete' | 'copy' | 'move' }
>;

export interface DaemonEntryRoute {
  mutate(
    request: EntryRequest,
    context: DaemonEntryRequest,
  ): Promise<FileTreeMutationResponse>;
}

function refused(message: string): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'failed_precondition',
    message,
    retry: { kind: 'never' },
  });
}

/** Unselected: constructing this route neither attaches nor changes any production caller. */
export function createDaemonEntryRoute(
  options: DaemonEntryRouteOptions,
): DaemonEntryRoute {
  return {
    async mutate(request, context): Promise<FileTreeMutationResponse> {
      const scope = {
        workspaceId: request.projectId,
        worktreeId: request.worktreeId,
      };
      try {
        // Bind the requesting document before async admission can outlive it.
        const owner = options.lifetime.ownerFor(context.sender);
        // The projections skip this when both root ids are supplied.
        await options.host.assertMutable(scope);
        const target = evaluateLocalRouteTarget({
          shape: 'worktree',
          scope,
          caller: context.caller,
          senderId: context.sender.id,
          lookups: {
            workspaceType: options.workspaceType,
            resolveWorktreeTargetIds: options.resolveWorktreeTargetIds,
            excludedWorkspaceIds: DAEMON_FILES_EXCLUDED_WORKSPACE_IDS,
            routedWorkspaceTypes: new Set([
              'single-repo',
              'multi-repo',
              'cowork',
            ]),
          },
        });
        if (!target || target.shape !== 'worktree')
          throw refused('This entry mutation has no daemon route.');
        const daemonHost = await options.hostContext();
        const mapped: CanopyWorkspaceScope = {
          workspaceId: target.workspaceId,
          worktreeId: target.worktreeId,
          authorityId: daemonHost.authorityId,
        };
        const client = async (): Promise<
          Pick<ElectronDaemonClient, 'instruction' | 'query' | 'signal'>
        > => {
          await options.host.assertMutable(scope);
          if (owner.aborted)
            throw new CanopyOperationError({
              kind: 'cancelled',
              message: 'The requesting window closed or reloaded.',
              retry: { kind: 'never' },
            });
          return (
            await options
              .connections()
              .get(
                { ...context.caller, authorityId: daemonHost.authorityId },
                owner,
              )
          ).client;
        };
        const host: LegacyEntryMutationHost = {
          os: options.host.os,
          assertMutable: () => options.host.assertMutable(scope),
          // Never resolve omitted ids through the desktop catalog: the renderer
          // ids and the instruction must belong to the daemon's same backend.
          roots: async () => {
            const connected = await client();
            return (
              await connected.query(
                'worker.filesystem.roots.list',
                { scope: mapped },
                { signal: owner },
              )
            ).roots;
          },
        };
        const send = async <Result>(
          key: string,
          signal: AbortSignal,
          run: () => Promise<Result>,
        ): Promise<Result> => {
          let dispatched = false;
          const abortedBeforeDispatch = owner.aborted || signal.aborted;
          try {
            const pending = run();
            // Pre-aborted clients reject asynchronously; the lifetime fence throws.
            dispatched = !abortedBeforeDispatch;
            return await pending;
          } catch (error) {
            const payload =
              error instanceof CanopyClientError ||
              error instanceof CanopyOperationError
                ? error.payload
                : null;
            if (
              payload?.retry.kind === 'same_idempotency_key' ||
              (dispatched && (owner.aborted || signal.aborted))
            ) {
              // A retired connection can replace the dispatched result with cancellation.
              // Legacy callers cannot replay the key yet (CAN-4733/E2).
              throw new CanopyOperationError({
                kind: 'unavailable',
                message:
                  'The change may have completed. Check your files before trying again.',
                details: { idempotencyKey: key },
                retry: { kind: 'same_idempotency_key' },
              });
            }
            throw error;
          }
        };
        const remove: EntryDeleteDispatch = async (params, call) => {
          const connected = await client();
          return send(params._meta.idempotencyKey, connected.signal, () =>
            connected.instruction(
              'worker.filesystem.entry.delete',
              { ...params, scope: mapped },
              { metadata: call.metadata, signal: owner },
            ),
          );
        };
        const copy: EntryCopyDispatch = async (params, call) => {
          const connected = await client();
          return send(params._meta.idempotencyKey, connected.signal, () =>
            connected.instruction(
              'worker.filesystem.entry.copy',
              {
                ...params,
                // Copy's create scope excludes authorityId; the session selects it.
                scope: {
                  workspaceId: mapped.workspaceId,
                  worktreeId: mapped.worktreeId,
                },
              },
              { metadata: call.metadata, signal: owner },
            ),
          );
        };
        const move: EntryMoveDispatch = async (params, call) => {
          const connected = await client();
          return send(params._meta.idempotencyKey, connected.signal, () =>
            connected.instruction(
              'worker.filesystem.entry.move',
              { ...params, scope: mapped },
              { metadata: call.metadata, signal: owner },
            ),
          );
        };
        // The existing projections allocate a fresh key per call; never retry or
        // fall back here, even when connection setup or the instruction fails.
        return request.operation === 'delete'
          ? await deleteFileTreeEntryForLegacyIpc(
              remove,
              host,
              request,
              context,
            )
          : await transferFileTreeEntryForLegacyIpc(
              { copy, move },
              host,
              request,
              context,
            );
      } catch (error) {
        const normalized =
          error instanceof CanopyClientError
            ? new CanopyOperationError(error.payload)
            : error;
        throw toLegacyFileTreeMutationError(normalized);
      }
    },
  };
}
