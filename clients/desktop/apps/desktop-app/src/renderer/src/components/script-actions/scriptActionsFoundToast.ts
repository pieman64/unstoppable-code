import type { ScriptActionsAddReceipt } from '@canopy/protocol/script-actions';
import {
  requestScriptActionsReview,
  scriptActionsFoundMessage,
  shouldNotifyScriptActionsReceipt,
} from '@canopy/ui-app/script-actions';
import { useChatStore } from '@/stores/chatStore';
import { useGitHubStore } from '@/stores/githubStore';
import { useProjectsStore } from '@/stores/projectsStore';
import {
  scriptActionsReceiptTargetName,
  scriptActionsReviewWorktreeId,
} from './desktopScriptActions';

/**
 * Raises the one post-add notice for a receipt: an auto-dismissing toast
 * with a visible Review action. Returns false when the receipt does not
 * qualify or its operation already produced a notice.
 */
export function showScriptActionsFoundToast(
  receipt: ScriptActionsAddReceipt,
  isFirstNotice: (operationId: string) => boolean,
): boolean {
  if (!shouldNotifyScriptActionsReceipt(receipt)) return false;
  if (!isFirstNotice(receipt.operationId)) return false;
  const projects = useProjectsStore.getState().projects;
  const project = projects.find((entry) => entry.id === receipt.projectId);
  useGitHubStore
    .getState()
    .addToast(
      scriptActionsFoundMessage(
        receipt.pendingCount,
        scriptActionsReceiptTargetName(projects, receipt),
      ),
      'info',
      undefined,
      {
        category: 'Script',
        projectId: receipt.projectId,
        ...(project ? { workspaceName: project.name } : {}),
        // The user just added the repository in this window.
        suppressOsNotification: true,
        action: {
          label: 'Review',
          onClick: (): void => {
            const worktreeId = scriptActionsReviewWorktreeId(
              useProjectsStore.getState().projects,
              useChatStore.getState().selectedWorktree,
              receipt,
            );
            if (worktreeId === null) return;
            requestScriptActionsReview({
              projectId: receipt.projectId,
              worktreeId,
              source: 'toast',
            });
          },
        },
      },
    );
  return true;
}
