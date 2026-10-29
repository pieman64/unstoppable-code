import type { LedgerContainer } from '@canopy/protocol/canopy-core';
import type { LedgerViewScope } from '@canopy/protocol/ledger-view';
import { APP_ADVISOR_PROJECT_ID } from '@canopy/desktop-shared/types';
import { ledgerChatContainerFor } from '../canopy-tools/ledger-tools-runtime';
import { getWorkspaceType } from '../lib/workspace-registry';

/**
 * The Ledger container a work scope reads: a code worktree, or a Cowork or
 * App Advisor Work Entry, exactly as for the chats in it. Null for a scope
 * without a Ledger, such as an app-managed chat surface or the legacy
 * standalone-chat sentinel.
 */
export function ledgerContainerForViewScope(
  scope: LedgerViewScope,
): LedgerContainer | null {
  return ledgerChatContainerFor(
    {
      projectId: scope.projectId,
      worktreeId: scope.worktreeId,
      assistantMode:
        scope.projectId === APP_ADVISOR_PROJECT_ID ? 'app-advisor' : 'default',
    },
    { workspaceType: getWorkspaceType },
  );
}

/**
 * The work scope that shows a container's Ledger: a Work Entry occupies the
 * worktree slot, as it does for chats.
 */
export function ledgerViewScopeForContainer(
  container: LedgerContainer,
): LedgerViewScope {
  switch (container.kind) {
    case 'code_worktree':
      return {
        projectId: container.workspaceId,
        worktreeId: container.worktreeId,
      };
    case 'cowork_entry':
      return {
        projectId: container.workspaceId,
        worktreeId: container.entryId,
      };
    case 'advisor_entry':
      return {
        projectId: container.appWorkspaceId,
        worktreeId: container.entryId,
      };
  }
}
