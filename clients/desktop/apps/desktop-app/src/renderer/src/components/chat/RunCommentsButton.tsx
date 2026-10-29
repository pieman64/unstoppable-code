import type { JSX } from 'react';
import { ActionTooltip } from '@/components/shared/ActionTooltip';
import { openRunComments } from '@/stores/runCommentsStore';
import { MessageIcon as AppCatalogMessageIcon } from '@canopy/ui-shared/icons/AppIcons';

/**
 * Turn-footer affordance opening the shared-run comments panel (CAN-397), with
 * an unread badge fed by the main-process comment poller. Only rendered for a
 * chat that has actually been shared as a run.
 */
export function RunCommentsButton({
  projectId,
  worktreeId,
  chatId,
  title,
  unreadCount = 0,
  testId = 'turn-run-comments',
}: {
  projectId: string;
  worktreeId: string;
  chatId: string;
  title: string;
  unreadCount?: number;
  testId?: string;
}): JSX.Element {
  const badge = unreadCount > 9 ? '9+' : String(unreadCount);
  const label = unreadCount > 0 ? `Run comments (${badge})` : 'Run comments';
  return (
    <ActionTooltip
      title="Run comments"
      description="Read and reply to comments reviewers left on this shared run."
    >
      <span className="relative inline-flex">
        <button
          type="button"
          onClick={(): void => {
            openRunComments({ projectId, worktreeId, chatId, title });
          }}
          aria-label={label}
          data-testid={testId}
          data-unread-count={String(unreadCount)}
          // Footer rows keep the unread accent instead of the muted icon look.
          data-attention={unreadCount > 0 ? '' : undefined}
          className={`focus-ring flex h-6 w-6 items-center justify-center rounded-md border transition ${
            unreadCount > 0
              ? 'border-line-accent/30 bg-accent-subtle fg-accent'
              : 'bg-fg-primary/[0.04] fg-primary/80 hover:bg-fg-primary/[0.08] hover:fg-primary'
          }`}
        >
          <AppCatalogMessageIcon width="14" height="14" aria-hidden="true" />
        </button>
        {unreadCount > 0 && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute -top-1 -right-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-accent px-1 text-3xs font-semibold fg-emphasis"
          >
            {badge}
          </span>
        )}
      </span>
    </ActionTooltip>
  );
}
