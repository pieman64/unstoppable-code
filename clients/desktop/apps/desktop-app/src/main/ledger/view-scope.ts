import type { LedgerContainer } from '@canopy/protocol/canopy-core';
import {
  isLedgerTaskViewScope,
  type LedgerTaskViewScope,
  type LedgerViewScope,
} from '@canopy/protocol/ledger-view';
import { APP_ADVISOR_PROJECT_ID } from '@canopy/desktop-shared/types';
import { ledgerChatContainerFor } from '../canopy-tools/ledger-tools-runtime';
import { getWorkspaceType } from '../lib/workspace-registry';

/**
 * The Ledger container a work scope reads: a code worktree, or a Cowork or
 * App Advisor Work Entry, exactly as for the chats in it, or an owner's
 * global (workflow) Ledger. Null for a scope without a Ledger, such as an
 * app-managed chat surface or the legacy standalone-chat sentinel. A global
 * scope names one incarnation by its `ledgerId`, which callers check against
 * the stored scope before serving it.
 */
export function ledgerContainerForViewScope(
  scope: LedgerViewScope,
): LedgerContainer | null {
  if (!isLedgerTaskViewScope(scope)) {
    return { kind: 'global', owner: scope.owner };
  }
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
 * The task that shows a container's Ledger: a Work Entry occupies the
 * worktree slot, as it does for chats. Null for a global (workflow) Ledger,
 * which belongs to no task.
 */
export function ledgerTaskViewScopeForContainer(
  container: LedgerContainer,
): LedgerTaskViewScope | null {
  return container.kind === 'global' ? null : taskViewScope(container);
}

/**
 * The work scope that shows a ledger: its task, or for a global (workflow)
 * Ledger, the owner and the ledger itself, so each incarnation stays apart.
 */
export function ledgerViewScopeForContainer(
  container: LedgerContainer,
  ledgerId: string,
): LedgerViewScope {
  if (container.kind === 'global') {
    return { kind: 'global', owner: container.owner, ledgerId };
  }
  return taskViewScope(container);
}

/** The task a task container's Ledger shows in. */
function taskViewScope(
  container: Exclude<LedgerContainer, { kind: 'global' }>,
): LedgerTaskViewScope {
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
