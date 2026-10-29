import {
  APP_ADVISOR_PROJECT_ID,
  type HomeDiscoveryTarget,
} from '@canopy/desktop-shared/types';

/** Discovery identity only. Host paths are resolved by the existing Home APIs. */
export type ConfigurationComposerContext =
  | { kind: 'workspace'; workspaceId: string; target: HomeDiscoveryTarget }
  | { kind: 'advisor' }
  | { kind: 'unresolved'; reason: string };

export function resolveHookComposerContext(args: {
  workspaceId: string;
  mode: 'source' | 'local';
  worktreeId?: string | null;
  repoId?: string;
}): ConfigurationComposerContext {
  return {
    kind: 'workspace',
    workspaceId: args.workspaceId,
    target:
      args.mode === 'source' && args.worktreeId
        ? {
            kind: 'worktree',
            worktreeId: args.worktreeId,
            ...(args.repoId ? { repoId: args.repoId } : {}),
          }
        : { kind: 'baseline', ...(args.repoId ? { repoId: args.repoId } : {}) },
  };
}

export function resolveAutomationComposerContext(args: {
  actionType: string;
  workspaceId?: string;
  isCowork?: boolean;
  baseWorktreeId?: string;
  existingWorktreeId?: string;
  selectedRepoId?: string;
  sessionTarget?: { workspaceId: string; worktreeId: string; chatId: string };
  sessionReady?: boolean;
}): ConfigurationComposerContext {
  if (args.actionType === 'app_advisor_prompt') return { kind: 'advisor' };
  if (args.actionType === 'worktree_session_prompt') {
    const target = args.sessionTarget;
    // App Advisor chats share the advisor's discovery context whichever Work
    // Entry they live in.
    if (target?.workspaceId === APP_ADVISOR_PROJECT_ID) {
      return { kind: 'advisor' };
    }
    if (!target?.chatId || !target.worktreeId || !args.sessionReady) {
      return {
        kind: 'unresolved',
        reason:
          'Choose an available destination chat to load files and commands.',
      };
    }
    if (args.isCowork)
      return {
        kind: 'workspace',
        workspaceId: target.workspaceId,
        target: { kind: 'cowork' },
      };
    return {
      kind: 'workspace',
      workspaceId: target.workspaceId,
      target: {
        kind: 'worktree',
        worktreeId: target.worktreeId,
        ...(args.selectedRepoId ? { repoId: args.selectedRepoId } : {}),
      },
    };
  }
  if (!args.workspaceId)
    return {
      kind: 'unresolved',
      reason: 'Choose a project to load files and commands.',
    };
  if (args.isCowork)
    return {
      kind: 'workspace',
      workspaceId: args.workspaceId,
      target: { kind: 'cowork' },
    };
  const worktreeId = args.existingWorktreeId || args.baseWorktreeId;
  return {
    kind: 'workspace',
    workspaceId: args.workspaceId,
    target: worktreeId
      ? { kind: 'worktree', worktreeId }
      : { kind: 'baseline' },
  };
}
