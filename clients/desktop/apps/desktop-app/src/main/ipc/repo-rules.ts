import type { IpcMainInvokeEvent } from 'electron';
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import {
  repoRulesScanRequestSchema,
  repoRulesApplyRequestSchema,
  repoRulesPreviewRequestSchema,
  type RepoRulesScanResponse,
  type RepoRulesApplyResponse,
  type RepoRulesStatus,
  type RepoRulesPreviewResponse,
  type EditorSetupPresence,
} from '@canopy/protocol/repo-rules';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import type { DesktopCanopyDispatcher } from '../canopy-runtime/desktop-runtime';
import { registerIpcHandler } from './register';
import { repoRulesService, resolveRepoRuleCheckouts } from '../repo-rules/host';
import { repoRulesWorker } from '../repo-rules/worker';

export function registerRepoRulesHandlers(
  dispatcher: DesktopCanopyDispatcher,
  resolveCaller: (event: IpcMainInvokeEvent) => CanopyCallerDescriptor,
): void {
  const authorize = async (
    event: IpcMainInvokeEvent,
    workspaceId: string,
    worktreeId?: string,
  ): Promise<string> => {
    const caller = resolveCaller(event);
    // Local opt-in grants ongoing checkout reads. Remote bridge callers cannot
    // consent on behalf of the local account in this Phase 1 implementation.
    if (caller.principalId !== 'local-desktop-user')
      throw new Error('Editor setup is available on the local desktop.');
    const workspace = await dispatcher.query(
      'core.workspace.get',
      { workspaceId },
      { caller },
    );
    if (workspace.kind !== 'git') throw new Error('Select a code workspace.');
    if (worktreeId) {
      const worktree = await dispatcher.query(
        'core.worktree.get',
        { worktreeId, scope: { workspaceId } },
        { caller },
      );
      if (worktree.workspaceId !== workspaceId)
        throw new Error('The checkout does not belong to this workspace.');
    }
    return `${caller.principalId}:${caller.clientInstanceId}`;
  };
  registerIpcHandler<[unknown], RepoRulesScanResponse>(
    IPC_CHANNELS.repoRulesScan,
    async (event, input) => {
      const request = repoRulesScanRequestSchema.parse(input);
      const caller = await authorize(
        event,
        request.workspaceId,
        request.worktreeId,
      );
      return repoRulesService.scan(caller, request);
    },
  );
  registerIpcHandler<[unknown], RepoRulesApplyResponse>(
    IPC_CHANNELS.repoRulesApply,
    async (event, input) => {
      const request = repoRulesApplyRequestSchema.parse(input);
      return repoRulesService.apply(
        await authorize(event, request.workspaceId),
        request,
      );
    },
  );
  registerIpcHandler<[unknown], RepoRulesStatus>(
    IPC_CHANNELS.repoRulesStatus,
    async (event, input) => {
      const request = repoRulesScanRequestSchema
        .pick({ workspaceId: true })
        .parse(input);
      await authorize(event, request.workspaceId);
      return repoRulesService.status(request.workspaceId);
    },
  );
  registerIpcHandler<[unknown], RepoRulesPreviewResponse>(
    IPC_CHANNELS.repoRulesPreview,
    async (event, input) => {
      const request = repoRulesPreviewRequestSchema.parse(input);
      return repoRulesService.preview(
        await authorize(event, request.workspaceId),
        request,
      );
    },
  );
  registerIpcHandler<[unknown], EditorSetupPresence>(
    IPC_CHANNELS.editorSetupPresence,
    async (event, input) => {
      const request = repoRulesScanRequestSchema.parse(input);
      await authorize(event, request.workspaceId, request.worktreeId);
      return repoRulesWorker
        .presence(await resolveRepoRuleCheckouts(request))
        .catch(() => ({ cursorRulesPresent: false }));
    },
  );
}
