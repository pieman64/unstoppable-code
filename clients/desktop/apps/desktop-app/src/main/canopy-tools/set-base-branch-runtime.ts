import { randomUUID } from 'node:crypto';
import type { AppAdvisorActionResponse } from '@canopy/desktop-shared/types';
import { requestAppAdvisorRendererTool } from '../ipc/app-advisor';
import { mainWindowOnlyToolSurfaces } from './show-files-runtime';
import type { WorktreeActionRuntime } from './worktree-actions';

export interface SetCurrentWorktreeBaseBranchInput {
  baseBranch: string;
  repoId?: string;
}

/**
 * Route the worktree-scoped tool through the canonical renderer action. The
 * trusted runtime supplies project/worktree ids; tool input can never select a
 * different target. This deliberately keeps every UX guard and confirmation
 * inside the existing `worktree.set_base_branch` implementation.
 */
export async function setCurrentWorktreeBaseBranch(
  input: SetCurrentWorktreeBaseBranchInput,
  runtime: WorktreeActionRuntime,
  context?: { toolUseId?: string; signal?: AbortSignal },
): Promise<AppAdvisorActionResponse> {
  const requestId = randomUUID();
  return requestAppAdvisorRendererTool(
    {
      kind: 'dispatch_action',
      requestId,
      action: {
        type: 'worktree.set_base_branch',
        projectId: runtime.projectId,
        worktreeId: runtime.worktreeId,
        ...(input.repoId ? { repoId: input.repoId } : {}),
        baseBranch: input.baseBranch,
      },
      originWorktreeId: runtime.worktreeId,
      originChatTabId: runtime.chatId,
    },
    mainWindowOnlyToolSurfaces(runtime.getWindow),
    context?.signal ? { signal: context.signal } : undefined,
  );
}
