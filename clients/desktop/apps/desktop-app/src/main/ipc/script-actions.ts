import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import type { IpcMainInvokeEvent } from 'electron';
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import {
  isScriptActionsContext,
  isScriptActionsReceiptRequest,
  type ScriptActionsResult,
  type ScriptActionsSnapshot,
  type ScriptActionsAddReceipt,
} from '@canopy/protocol/script-actions';
import type { DesktopCanopyDispatcher } from '../canopy-runtime/desktop-runtime';
import { registerIpcHandler } from './register';
import {
  scriptActionsService,
  startScriptActionsLifecycle,
} from '../services/script-actions-host';
import {
  dispatchScriptActionsOperation,
  validScriptActionsRequest,
  type ScriptActionsOperation,
} from '../services/script-actions-operations';

export function registerScriptActionsHandlers(
  dispatcher: DesktopCanopyDispatcher,
  resolveCaller: (event: IpcMainInvokeEvent) => CanopyCallerDescriptor,
): () => Promise<void> {
  const stopLifecycle = startScriptActionsLifecycle();
  const handler =
    (operation: ScriptActionsOperation) =>
    async (
      event: IpcMainInvokeEvent,
      input: unknown,
    ): Promise<
      ScriptActionsResult<
        ScriptActionsSnapshot | ScriptActionsAddReceipt | null
      >
    > => {
      if (
        !(
          isScriptActionsContext(input) ||
          (operation === 'receipt' && isScriptActionsReceiptRequest(input))
        ) ||
        !validScriptActionsRequest(operation, input)
      )
        return {
          ok: false,
          error: {
            code: 'invalid_payload',
            message: 'Invalid script action request.',
          },
        };
      try {
        const caller = resolveCaller(event);
        // Only human interface callers enter here; no agent tool can approve, opt in or execute.
        const workspace = await dispatcher.query(
          'core.workspace.get',
          { workspaceId: input.projectId },
          { caller },
        );
        if (workspace.kind !== 'git')
          throw new Error('Select a code workspace.');
        if (input.worktreeId !== undefined) {
          const worktree = await dispatcher.query(
            'core.worktree.get',
            {
              worktreeId: input.worktreeId,
              scope: { workspaceId: input.projectId },
            },
            { caller },
          );
          if (worktree.workspaceId !== input.projectId)
            throw new Error('Worktree is unavailable.');
        }
      } catch {
        return {
          ok: false,
          error: {
            code: 'invalid_target',
            message: 'Script action target is unavailable.',
          },
        };
      }
      return dispatchScriptActionsOperation(
        scriptActionsService,
        operation,
        input,
      );
    };
  registerIpcHandler(IPC_CHANNELS.scriptActionsList, handler('list'));
  registerIpcHandler(IPC_CHANNELS.scriptActionsRescan, handler('rescan'));
  registerIpcHandler(IPC_CHANNELS.scriptActionsReview, handler('review'));
  registerIpcHandler(
    IPC_CHANNELS.scriptActionsSetShortcut,
    handler('setShortcut'),
  );
  registerIpcHandler(IPC_CHANNELS.scriptActionsSetPinned, handler('setPinned'));
  registerIpcHandler(
    IPC_CHANNELS.scriptActionsEnableShellAliasScan,
    handler('enableShellAliasScan'),
  );
  registerIpcHandler(IPC_CHANNELS.scriptActionsReceipt, handler('receipt'));
  return () => {
    stopLifecycle();
    return scriptActionsService.dispose();
  };
}
