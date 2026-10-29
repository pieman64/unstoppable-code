import { memo, useContext, type JSX } from 'react';
import { isActivitySectionVisibleForWorkspaceType } from '@canopy/app-state';
import { getHookTriggerDisplayName } from '@canopy/desktop-shared/hooks';
import type { ActivitySectionId } from '@canopy/desktop-shared/types';
import { openActivityCardBesideChat } from '@/lib/panels/open-activity-card';
import { panelSurfaceForWorktreeKey } from '@/lib/panels/panel-surface';
import { isActivitySectionAllowedForAccess } from '@/lib/shared-containers/panel-allowlist';
import { useWorkspaceAccess } from '@/lib/workspace-access';
import { ChatMarkdownFileTargetContext } from './chat-markdown-file-target';
import { InfoIcon as AppCatalogInfoIcon } from '@canopy/ui-shared/icons/AppIcons';

const HOOKS_SECTION = {
  id: 'hooks',
  title: 'Hooks',
} as const satisfies { id: ActivitySectionId; title: string };

/**
 * The "Chat initiated by … hook" banner at the top of a hook-started chat.
 * The hook name opens a Hooks tab beside the chat when the chat's worktree
 * can show that section; otherwise it is plain text.
 */
export const HookInfoBanner = memo(function HookInfoBanner({
  triggerName,
  timestamp,
  originChatTabId,
}: {
  triggerName: string;
  timestamp: number;
  originChatTabId: string | undefined;
}): JSX.Element {
  const target = useContext(ChatMarkdownFileTargetContext);
  const access = useWorkspaceAccess();
  const localTime = new Date(timestamp).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });
  const hookName = getHookTriggerDisplayName(triggerName);
  const worktreeKey =
    target === null ? null : `${target.projectId}/${target.worktreeId}`;
  const openHooks =
    worktreeKey !== null &&
    originChatTabId !== undefined &&
    isActivitySectionVisibleForWorkspaceType(
      HOOKS_SECTION.id,
      panelSurfaceForWorktreeKey(worktreeKey) === 'cowork'
        ? 'cowork'
        : 'single-repo',
    ) &&
    isActivitySectionAllowedForAccess(HOOKS_SECTION.id, access)
      ? (): void => {
          void openActivityCardBesideChat(
            worktreeKey,
            HOOKS_SECTION,
            originChatTabId,
          );
        }
      : null;

  return (
    <div
      data-testid="chat-hook-info-banner"
      className="flex items-center gap-2 rounded-lg border bg-fg-primary/[0.03] px-3 py-1.5 text-xs fg-secondary"
    >
      <AppCatalogInfoIcon width="14" height="14" className="flex-shrink-0" />
      <span>
        Chat initiated by{' '}
        {openHooks !== null ? (
          <button
            type="button"
            data-testid="chat-hook-info-open-hooks"
            className="focus-ring cursor-pointer font-semibold fg-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
            onClick={openHooks}
          >
            {hookName}
          </button>
        ) : (
          <strong>{hookName}</strong>
        )}{' '}
        hook at {localTime}
      </span>
    </div>
  );
});
